import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Square, Hexagon, Hand, Undo2, Redo2, Trash2, Sparkles, Save, ArrowLeft,
  MousePointer2, ZoomIn, ZoomOut, Maximize2, Eye, EyeOff, Lock, Unlock,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { getImage, getAnnotations, signedUrl } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { runRoboflowWorkflow } from "@/lib/roboflow.functions";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AnnotationLabel, labelAnchor } from "@/lib/annotation-render";

export const Route = createFileRoute("/_authenticated/label/$imageId")({
  component: Studio,
});

type Tool = "select" | "rectangle" | "polygon" | "pan";
type Shape = {
  id?: string;
  class_name: string;
  annotation_type: "rectangle" | "polygon";
  geometry: { points: { x: number; y: number }[] }; // normalized 0..1
  confidence?: number | null;
  source: string;
  status: string;
  hidden?: boolean;
  locked?: boolean;
};

const LABELS = [
  { name: "Plane", color: "#22c55e" },
  { name: "Airplane", color: "#eab308" },
  { name: "Helicopter", color: "#a855f7" },
  { name: "Airport", color: "#ef4444" },
  { name: "Ship", color: "#06b6d4" },
  { name: "Bridge", color: "#f97316" },
  { name: "Vehicle", color: "#3b82f6" },
  { name: "Storage Tank", color: "#ec4899" },
];
// Deterministic fallback palette so unknown classes keep a consistent color.
const FALLBACK_PALETTE = ["#0EA5E9", "#D4AF37", "#84cc16", "#f43f5e", "#8b5cf6", "#14b8a6", "#f59e0b", "#e11d48"];
const colorFor = (c: string) => {
  const known = LABELS.find((l) => l.name.toLowerCase() === c.toLowerCase());
  if (known) return known.color;
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
};

const W = 1000, H = 700;

function Studio() {
  const { imageId } = Route.useParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const runAi = useServerFn(runRoboflowWorkflow);

  const { data: image } = useQuery({ queryKey: ["image", imageId], queryFn: () => getImage(imageId) });
  const { data: saved } = useQuery({ queryKey: ["annotations", imageId], queryFn: () => getAnnotations(imageId) });
  const [url, setUrl] = useState<string>();
  const [imgOk, setImgOk] = useState(true);

  const [tool, setTool] = useState<Tool>("select");
  const [label, setLabel] = useState(LABELS[0].name);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redo, setRedo] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<{ x: number; y: number }[] | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [aiBusy, setAiBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { mode: "move"; idx: number; last: { x: number; y: number } }
    | { mode: "resize"; idx: number; corner: number }
    | { mode: "vertex"; idx: number; vi: number }
    | { mode: "pan"; last: { x: number; y: number } }
    | null
  >(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (image?.storage_path) signedUrl(image.storage_path).then(setUrl).catch(() => setImgOk(false));
  }, [image]);

  useEffect(() => {
    if (saved) {
      setShapes(saved.map((a) => ({
        id: a.id, class_name: a.class_name,
        annotation_type: a.annotation_type as "rectangle" | "polygon",
        geometry: (a.geometry as Shape["geometry"]) ?? { points: [] },
        confidence: a.confidence, source: a.source, status: a.status,
      })));
    }
  }, [saved]);

  // Convert a mouse event to normalized (0..1) content coordinates, accounting for zoom/pan.
  const pt = useCallback((e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const ux = ((e.clientX - r.left) / r.width) * W;
    const uy = ((e.clientY - r.top) / r.height) * H;
    const cx = (ux - view.x) / view.zoom;
    const cy = (uy - view.y) / view.zoom;
    return { x: Math.min(1, Math.max(0, cx / W)), y: Math.min(1, Math.max(0, cy / H)) };
  }, [view]);
  // Raw user-unit point (for pan deltas), no clamping.
  const rawPt = useCallback((e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }, []);

  function markDirty() { dirtyRef.current = true; }
  function pushShape(s: Shape) { setShapes((p) => [...p, s]); setRedo([]); markDirty(); }

  // Live confidence filter: AI predictions below the threshold are hidden.
  // Manual annotations (no confidence) always pass.
  const passesConf = useCallback(
    (s: Shape) => s.confidence == null || s.confidence * 100 >= confidence,
    [confidence],
  );

  // Hit test: return index of the topmost shape containing point p (normalized).
  function hitTest(p: { x: number; y: number }): number | null {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.hidden) continue;
      if (!passesConf(s)) continue;
      const pts = s.geometry.points;
      if (s.annotation_type === "rectangle") {
        const x0 = Math.min(pts[0].x, pts[1].x), x1 = Math.max(pts[0].x, pts[1].x);
        const y0 = Math.min(pts[0].y, pts[1].y), y1 = Math.max(pts[0].y, pts[1].y);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return i;
      } else if (pointInPolygon(p, pts)) return i;
    }
    return null;
  }

  function onDown(e: React.MouseEvent) {
    if (tool === "pan") { dragRef.current = { mode: "pan", last: rawPt(e) }; return; }
    const p = pt(e);
    if (tool === "select") {
      const hit = hitTest(p);
      setSelected(hit);
      if (hit !== null && !shapes[hit].locked) dragRef.current = { mode: "move", idx: hit, last: p };
      return;
    }
    if (tool === "rectangle") setDraft([p, p]);
    else setDraft((d) => (d ? [...d, p] : [p]));
  }

  function onMove(e: React.MouseEvent) {
    const drag = dragRef.current;
    if (drag) {
      if (drag.mode === "pan") {
        const r = rawPt(e);
        setView((v) => ({ ...v, x: v.x + (r.x - drag.last.x), y: v.y + (r.y - drag.last.y) }));
        drag.last = r;
        return;
      }
      const p = pt(e);
      if (drag.mode === "move") {
        const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
        setShapes((prev) => prev.map((s, i) => i === drag.idx
          ? { ...s, geometry: { points: s.geometry.points.map((q) => ({ x: clamp01(q.x + dx), y: clamp01(q.y + dy) })) } } : s));
        drag.last = p; markDirty();
      } else if (drag.mode === "resize") {
        setShapes((prev) => prev.map((s, i) => {
          if (i !== drag.idx) return s;
          const pts = [...s.geometry.points];
          pts[drag.corner] = { x: p.x, y: p.y };
          return { ...s, geometry: { points: pts } };
        }));
        markDirty();
      } else if (drag.mode === "vertex") {
        setShapes((prev) => prev.map((s, i) => {
          if (i !== drag.idx) return s;
          const pts = [...s.geometry.points];
          pts[drag.vi] = { x: p.x, y: p.y };
          return { ...s, geometry: { points: pts } };
        }));
        markDirty();
      }
      return;
    }
    if (tool === "rectangle" && draft) { const p = pt(e); setDraft([draft[0], p]); return; }
    if (tool === "select") setHover(hitTest(pt(e)));
  }

  function onUp() {
    if (dragRef.current) { dragRef.current = null; scheduleSave(); return; }
    if (tool === "rectangle" && draft) {
      const [a, b] = draft;
      if (Math.abs(a.x - b.x) > 0.005 && Math.abs(a.y - b.y) > 0.005)
        pushShape({ class_name: label, annotation_type: "rectangle", geometry: { points: [a, b] }, source: "manual", status: "confirmed" });
      setDraft(null);
      scheduleSave();
    }
  }
  function finishPolygon() {
    if (draft && draft.length >= 3)
      pushShape({ class_name: label, annotation_type: "polygon", geometry: { points: draft }, source: "manual", status: "confirmed" });
    setDraft(null);
    scheduleSave();
  }

  function undo() { setShapes((p) => { if (!p.length) return p; const last = p[p.length - 1]; setRedo((r) => [...r, last]); return p.slice(0, -1); }); markDirty(); scheduleSave(); }
  function redoFn() { setRedo((r) => { if (!r.length) return r; const last = r[r.length - 1]; setShapes((p) => [...p, last]); return r.slice(0, -1); }); markDirty(); scheduleSave(); }
  function del(i: number) { setShapes((p) => p.filter((_, idx) => idx !== i)); setSelected(null); markDirty(); scheduleSave(); }
  function toggleHidden(i: number) { setShapes((p) => p.map((s, idx) => idx === i ? { ...s, hidden: !s.hidden } : s)); }
  function toggleLocked(i: number) { setShapes((p) => p.map((s, idx) => idx === i ? { ...s, locked: !s.locked } : s)); }
  function renameClass(i: number, name: string) { setShapes((p) => p.map((s, idx) => idx === i ? { ...s, class_name: name } : s)); markDirty(); scheduleSave(); }

  // Zoom / view controls
  function zoomBy(factor: number, cx = W / 2, cy = H / 2) {
    setView((v) => {
      const zoom = Math.min(8, Math.max(1, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }
  function resetView() { setView({ zoom: 1, x: 0, y: 0 }); }
  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey && tool !== "pan") return;
    e.preventDefault();
    const r = rawPt(e as unknown as React.MouseEvent);
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, r.x, r.y);
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "v") setTool("select");
      if (e.key === "r") setTool("rectangle");
      if (e.key === "p") setTool("polygon");
      if (e.key === "h") setTool("pan");
      if (e.key === "Enter" && tool === "polygon") finishPolygon();
      if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) { e.preventDefault(); del(selected); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redoFn(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [tool, draft, selected]);

  async function autoLabel() {
    if (!url) return;
    setAiBusy(true);
    try {
      const res = await runAi({ data: { imageUrl: url, confidence: confidence / 100 } });
      if (res.error) { toast.error(res.error); return; }
      const w = image?.width ?? 1, h = image?.height ?? 1;
      const preds = res.predictions.filter((p) => p.confidence * 100 >= confidence);
      const newShapes: Shape[] = preds.map((p) => {
        const nx = (v: number) => v / w, ny = (v: number) => v / h;
        if (p.points && p.points.length >= 3) {
          return {
            class_name: p.class,
            annotation_type: "polygon" as const,
            geometry: { points: p.points.map((pt) => ({ x: nx(pt.x), y: ny(pt.y) })) },
            confidence: p.confidence, source: "ai", status: "pending",
          };
        }
        return {
          class_name: p.class, annotation_type: "rectangle" as const,
          geometry: { points: [
            { x: nx(p.x - p.width / 2), y: ny(p.y - p.height / 2) },
            { x: nx(p.x + p.width / 2), y: ny(p.y + p.height / 2) },
          ] },
          confidence: p.confidence, source: "ai", status: "pending",
        };
      });
      setShapes((prev) => [...prev, ...newShapes]);
      if (newShapes.length === 0) {
        toast.info("No predictions above the confidence threshold");
      } else {
        markDirty();
        scheduleSave();
        toast.success(`AI added ${newShapes.length} suggestion(s)`);
      }
    } catch (e) {
      toast.error("AI labeling failed. Please try again.");
    } finally { setAiBusy(false); }
  }

  const shapesRef = useRef<Shape[]>(shapes);
  useEffect(() => { shapesRef.current = shapes; }, [shapes]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedFlag, setSavedFlag] = useState(true);

  // Debounced auto-save. Preserves the existing delete-then-insert workflow.
  function scheduleSave() {
    setSavedFlag(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(); }, 900);
  }

  async function persist(showToast = false) {
    if (!user) return;
    if (!dirtyRef.current) { setSavedFlag(true); return; }
    dirtyRef.current = false;
    const current = shapesRef.current;
    await supabase.from("annotations").delete().eq("image_id", imageId);
    if (current.length) {
      const rows = current.map((s) => ({
        image_id: imageId, user_id: user.id, class_name: s.class_name,
        annotation_type: s.annotation_type, geometry: s.geometry as unknown as Json,
        confidence: s.confidence ?? null, source: s.source, status: s.status,
      }));
      const { error } = await supabase.from("annotations").insert(rows);
      if (error) { setSavedFlag(false); return toast.error(error.message); }
    }
    await supabase.from("images").update({ status: current.length ? "labeled" : "uploaded" }).eq("id", imageId);
    qc.invalidateQueries({ queryKey: ["stats"] });
    setSavedFlag(true);
    if (showToast) toast.success("Annotations saved");
  }

  async function save() {
    if (!user) return;
    dirtyRef.current = true;
    await persist(true);
  }

  // Focus (center + zoom) on a shape when selected from the panel.
  function focusShape(i: number) {
    setSelected(i);
    const pts = shapes[i].geometry.points;
    const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length * W;
    const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length * H;
    const zoom = 2;
    setView({ zoom, x: W / 2 - cx * zoom, y: H / 2 - cy * zoom });
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    shapes.forEach((s) => { m[s.class_name] = (m[s.class_name] ?? 0) + 1; });
    return m;
  }, [shapes]);

  const tools: { id: Tool; icon: typeof Square; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Select (V)" },
    { id: "rectangle", icon: Square, label: "Rectangle (R)" },
    { id: "polygon", icon: Hexagon, label: "Polygon (P)" },
    { id: "pan", icon: Hand, label: "Pan (H)" },
  ];

  return (
    <div>
      <PageHeader
        title={image?.filename ?? "Annotation Studio"}
        subtitle="Draw boxes and polygons, or run AI to auto-label"
        action={
          <div className="flex gap-2">
            <Badge variant={savedFlag ? "secondary" : "outline"} className="self-center">
              {savedFlag ? "Saved" : "Saving…"}
            </Badge>
            <Button variant="ghost" asChild><Link to="/label"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Link></Button>
            <Button onClick={save}><Save className="mr-1 h-4 w-4" /> Save</Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4 p-6 lg:flex-row">
        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1.5">
            {tools.map((t) => (
              <Button key={t.id} size="sm" variant={tool === t.id ? "default" : "ghost"} title={t.label} onClick={() => setTool(t.id)}>
                <t.icon className="h-4 w-4" />
              </Button>
            ))}
            <div className="mx-1 h-6 w-px bg-border" />
            <Button size="sm" variant="ghost" onClick={() => zoomBy(1.2)} title="Zoom in"><ZoomIn className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => zoomBy(1 / 1.2)} title="Zoom out"><ZoomOut className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={resetView} title="Reset / Fit to screen"><Maximize2 className="h-4 w-4" /></Button>
            <span className="px-1 text-xs text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
            <div className="mx-1 h-6 w-px bg-border" />
            <Button size="sm" variant="ghost" onClick={undo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={redoFn} title="Redo (Ctrl+Y)"><Redo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" disabled={selected === null} onClick={() => selected !== null && del(selected)} title="Delete selected (Del)"><Trash2 className="h-4 w-4" /></Button>
            {tool === "polygon" && draft && <Button size="sm" variant="secondary" onClick={finishPolygon}>Finish polygon</Button>}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-[#0b1020]">
            <svg
              ref={svgRef} viewBox="0 0 1000 700"
              className={cn("aspect-[10/7] w-full select-none", tool === "pan" ? "cursor-grab" : tool === "select" ? "cursor-default" : "cursor-crosshair")}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
            >
              <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                {url && imgOk ? (
                  <image href={url} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" onError={() => setImgOk(false)} />
                ) : (
                  <>
                    <rect x={0} y={0} width={W} height={H} fill="#0b1020" />
                    <text x={500} y={350} textAnchor="middle" fill="#5b6478" fontSize={18}>
                      Preview unavailable for this format — annotations still work
                    </text>
                  </>
                )}
                {shapes.map((s, i) => {
                  if (s.hidden) return null;
                  if (!passesConf(s)) return null;
                  const p = s.geometry.points;
                  const col = colorFor(s.class_name);
                  const isSel = selected === i, isHover = hover === i;
                  const sw = (isSel ? 3 : 2) / view.zoom;
                  const fillOp = isSel || isHover ? "40" : "33";
                  const conf = s.source === "ai" && s.confidence != null ? ` (${Math.round(s.confidence * 100)}%)` : "";
                  const labelText = `${s.class_name}${conf}`;
                  const handleR = 5 / view.zoom;
                  // Selecting via the attached label picks only this annotation.
                  const selectThis = (e: React.MouseEvent) => { e.stopPropagation(); setSelected(i); };
                  if (s.annotation_type === "rectangle") {
                    const x = Math.min(p[0].x, p[1].x) * W, y = Math.min(p[0].y, p[1].y) * H;
                    const w = Math.abs(p[1].x - p[0].x) * W, h = Math.abs(p[1].y - p[0].y) * H;
                    return <g key={i}>
                      <rect x={x} y={y} width={w} height={h} fill={col + fillOp} stroke={col} strokeWidth={sw}
                        strokeDasharray={s.source === "ai" ? `${6 / view.zoom} ${4 / view.zoom}` : undefined}
                        onMouseDown={(e) => { if (tool === "select") { e.stopPropagation(); setSelected(i); if (!s.locked) dragRef.current = { mode: "move", idx: i, last: pt(e) }; } }} />
                      <AnnotationLabel x={x} y={y} text={labelText} color={col} zoom={view.zoom} onSelect={selectThis} />
                      {isSel && tool === "select" && !s.locked && [0, 1].map((ci) => (
                        <rect key={ci} x={p[ci].x * W - handleR} y={p[ci].y * H - handleR} width={handleR * 2} height={handleR * 2}
                          fill="#fff" stroke={col} strokeWidth={1 / view.zoom} className="cursor-nwse-resize"
                          onMouseDown={(e) => { e.stopPropagation(); dragRef.current = { mode: "resize", idx: i, corner: ci }; }} />
                      ))}
                    </g>;
                  }
                  const ptsStr = p.map((q) => `${q.x * W},${q.y * H}`).join(" ");
                  const px0 = Math.min(...p.map((q) => q.x)) * W, py0 = Math.min(...p.map((q) => q.y)) * H;
                  return <g key={i}>
                    <polygon points={ptsStr} fill={col + fillOp} stroke={col} strokeWidth={sw}
                      strokeDasharray={s.source === "ai" ? `${6 / view.zoom} ${4 / view.zoom}` : undefined}
                      onMouseDown={(e) => { if (tool === "select") { e.stopPropagation(); setSelected(i); if (!s.locked) dragRef.current = { mode: "move", idx: i, last: pt(e) }; } }} />
                    <AnnotationLabel x={px0} y={py0} text={labelText} color={col} zoom={view.zoom} onSelect={selectThis} />
                    {isSel && tool === "select" && !s.locked && p.map((q, vi) => (
                      <circle key={vi} cx={q.x * W} cy={q.y * H} r={handleR} fill="#fff" stroke={col} strokeWidth={1 / view.zoom} className="cursor-move"
                        onMouseDown={(e) => { e.stopPropagation(); dragRef.current = { mode: "vertex", idx: i, vi }; }} />
                    ))}
                  </g>;
                })}
                {draft && tool === "rectangle" && (
                  <rect x={Math.min(draft[0].x, draft[1].x) * W} y={Math.min(draft[0].y, draft[1].y) * H}
                    width={Math.abs(draft[1].x - draft[0].x) * W} height={Math.abs(draft[1].y - draft[0].y) * H}
                    fill="none" stroke={colorFor(label)} strokeWidth={2 / view.zoom} strokeDasharray={`${4 / view.zoom} ${4 / view.zoom}`} />
                )}
                {draft && tool === "polygon" && (
                  <polyline points={draft.map((q) => `${q.x * W},${q.y * H}`).join(" ")} fill="none" stroke={colorFor(label)} strokeWidth={2 / view.zoom} />
                )}
              </g>
            </svg>
          </div>
        </div>

        <div className="w-full space-y-4 lg:w-72">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold">Labels</h3>
            <div className="grid grid-cols-2 gap-2">
              {LABELS.map((l) => (
                <button key={l.name} onClick={() => setLabel(l.name)}
                  className={cn("flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs", label === l.name ? "border-gold" : "border-border")}>
                  <span className="h-3 w-3 rounded-full" style={{ background: l.color }} />
                  {l.name}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-gold" /> AI Auto-Label</h3>
            <div className="mb-3">
              <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Confidence</span><span>{confidence}%</span></div>
              <Slider value={[confidence]} min={0} max={100} step={5} onValueChange={(v) => setConfidence(v[0])} />
            </div>
            <Button className="w-full" onClick={autoLabel} disabled={aiBusy || !url}>
              {aiBusy ? "Running…" : <><Sparkles className="mr-1 h-4 w-4" /> AI Label</>}
            </Button>
            {aiBusy && (
              <div className="mt-3 space-y-1 rounded-md border border-gold/30 bg-gold/5 p-2 text-center">
                <p className="text-xs font-medium text-gold">Running AI…</p>
                <p className="text-[11px] text-muted-foreground">Generating predictions…</p>
                <p className="text-[11px] text-muted-foreground">This may take a few seconds…</p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold">Annotations ({shapes.length})</h3>
            <div className="mb-3 flex flex-wrap gap-1">
              {Object.entries(counts).map(([k, v]) => <Badge key={k} variant="secondary">{k}: {v}</Badge>)}
            </div>
            <div className="max-h-80 space-y-1 overflow-auto">
              {shapes.map((s, i) => (
                <div key={i}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                  className={cn("rounded-md border px-2 py-1.5 text-xs transition-colors",
                    selected === i ? "border-gold bg-gold/5" : "border-border hover:bg-muted/50",
                    !passesConf(s) && "opacity-40")}>
                  <div className="flex items-center justify-between gap-1">
                    <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => focusShape(i)}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorFor(s.class_name) }} />
                      <span className="truncate">{s.class_name}</span>
                      {s.source === "ai" && <Badge variant="outline" className="h-4 px-1 text-[10px]">AI</Badge>}
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button title="Toggle visibility" onClick={() => toggleHidden(i)}>
                        {s.hidden ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button title={s.locked ? "Unlock" : "Lock"} onClick={() => toggleLocked(i)}>
                        {s.locked ? <Lock className="h-3.5 w-3.5 text-gold" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                      <button title="Delete" onClick={() => del(i)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="capitalize">{s.annotation_type}</span>
                    {s.source === "ai" && s.confidence != null && <span>· {Math.round(s.confidence * 100)}%</span>}
                  </div>
                  {selected === i && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {LABELS.map((l) => (
                        <button key={l.name} title={`Set ${l.name}`} onClick={() => renameClass(i, l.name)}
                          className={cn("h-5 w-5 rounded-full border", s.class_name === l.name ? "border-foreground" : "border-transparent")}
                          style={{ background: l.color }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {shapes.length === 0 && <p className="text-xs text-muted-foreground">No annotations yet.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp01(v: number) { return Math.min(1, Math.max(0, v)); }

function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
