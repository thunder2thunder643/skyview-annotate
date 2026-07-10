import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  MousePointer2, Square, Hexagon, Hand, Undo2, Redo2, Trash2, Sparkles, Save,
  ArrowLeft, ZoomIn, ZoomOut, Eye, EyeOff, Lock, Unlock, Scan, Maximize2,
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  color?: string | null;
  hidden?: boolean;
  locked?: boolean;
};

const LABELS = [
  { name: "Building", color: "#0EA5E9" }, // blue
  { name: "Road", color: "#f97316" },     // orange
  { name: "Vehicle", color: "#22c55e" },  // green
  { name: "Ship", color: "#06b6d4" },     // cyan
  { name: "Airport", color: "#a855f7" },  // purple
  { name: "Bridge", color: "#eab308" },   // yellow
];
const colorFor = (s: Shape) =>
  s.color ?? LABELS.find((l) => l.name.toLowerCase() === s.class_name.toLowerCase())?.color ?? "#0EA5E9";
const classColor = (c: string) =>
  LABELS.find((l) => l.name.toLowerCase() === c.toLowerCase())?.color ?? "#0EA5E9";

const VB_W = 1000;
const VB_H = 700;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number }[] | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [aiBusy, setAiBusy] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });

  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Undo / redo history
  const past = useRef<Shape[][]>([]);
  const future = useRef<Shape[][]>([]);
  const dirty = useRef(false);

  // Active pointer interaction
  const interaction = useRef<
    | null
    | {
        mode: "move" | "resize" | "vertex" | "pan" | "rect";
        index?: number;
        handle?: "nw" | "ne" | "sw" | "se";
        vertex?: number;
        start: { x: number; y: number };
        startView?: { scale: number; tx: number; ty: number };
        snapshot: Shape[];
        origPoints?: { x: number; y: number }[];
      }
  >(null);

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
      past.current = [];
      future.current = [];
    }
  }, [saved]);

  // ---- coordinate transform (screen -> normalized 0..1, accounting for zoom/pan) ----
  const toNorm = useCallback((e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const vbX = ((e.clientX - r.left) / r.width) * VB_W;
    const vbY = ((e.clientY - r.top) / r.height) * VB_H;
    const gx = (vbX - view.tx) / view.scale;
    const gy = (vbY - view.ty) / view.scale;
    return { x: clamp(gx / VB_W, 0, 1), y: clamp(gy / VB_H, 0, 1) };
  }, [view]);

  // ---- history helpers ----
  const commit = useCallback((next: Shape[]) => {
    past.current.push(shapes);
    future.current = [];
    dirty.current = true;
    setShapes(next);
  }, [shapes]);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(shapes);
    const prev = past.current.pop()!;
    dirty.current = true;
    setShapes(prev);
    setSelected(null);
  }, [shapes]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(shapes);
    const next = future.current.pop()!;
    dirty.current = true;
    setShapes(next);
    setSelected(null);
  }, [shapes]);

  // ---- zoom / pan ----
  const zoomBy = useCallback((factor: number, cx = VB_W / 2, cy = VB_H / 2) => {
    setView((v) => {
      const scale = clamp(v.scale * factor, 0.5, 10);
      const wx = (cx - v.tx) / v.scale;
      const wy = (cy - v.ty) / v.scale;
      return { scale, tx: cx - wx * scale, ty: cy - wy * scale };
    });
  }, []);
  const resetView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);
  const fitScreen = resetView;
  const fullScreen = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && tool !== "pan") return;
    e.preventDefault();
    const r = svgRef.current!.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / r.width) * VB_W;
    const cy = ((e.clientY - r.top) / r.height) * VB_H;
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, cx, cy);
  }, [tool, zoomBy]);

  // ---- drawing / interaction ----
  function onCanvasDown(e: React.MouseEvent) {
    if (tool === "pan") {
      interaction.current = {
        mode: "pan",
        start: { x: e.clientX, y: e.clientY },
        startView: { ...view },
        snapshot: shapes,
      };
      return;
    }
    const p = toNorm(e);
    if (tool === "rectangle") {
      interaction.current = { mode: "rect", start: p, snapshot: shapes };
      setDraft([p, p]);
      return;
    }
    if (tool === "polygon") {
      setDraft((d) => (d ? [...d, p] : [p]));
      return;
    }
    // select tool: clicking empty canvas deselects
    setSelected(null);
  }

  function beginMove(e: React.MouseEvent, i: number) {
    if (tool !== "select" || shapes[i].locked) return;
    e.stopPropagation();
    setSelected(i);
    interaction.current = {
      mode: "move", index: i, start: toNorm(e), snapshot: shapes,
      origPoints: shapes[i].geometry.points.map((q) => ({ ...q })),
    };
  }
  function beginResize(e: React.MouseEvent, i: number, handle: "nw" | "ne" | "sw" | "se") {
    e.stopPropagation();
    interaction.current = {
      mode: "resize", index: i, handle, start: toNorm(e), snapshot: shapes,
      origPoints: shapes[i].geometry.points.map((q) => ({ ...q })),
    };
  }
  function beginVertex(e: React.MouseEvent, i: number, vertex: number) {
    e.stopPropagation();
    interaction.current = {
      mode: "vertex", index: i, vertex, start: toNorm(e), snapshot: shapes,
      origPoints: shapes[i].geometry.points.map((q) => ({ ...q })),
    };
  }

  function onMove(e: React.MouseEvent) {
    const it = interaction.current;
    if (!it) return;
    if (it.mode === "pan" && it.startView) {
      const r = svgRef.current!.getBoundingClientRect();
      const dx = ((e.clientX - it.start.x) / r.width) * VB_W;
      const dy = ((e.clientY - it.start.y) / r.height) * VB_H;
      setView({ scale: it.startView.scale, tx: it.startView.tx + dx, ty: it.startView.ty + dy });
      return;
    }
    if (it.mode === "rect") {
      const p = toNorm(e);
      setDraft([it.start, p]);
      return;
    }
    const p = toNorm(e);
    const dx = p.x - it.start.x, dy = p.y - it.start.y;
    if (it.mode === "move" && it.index != null && it.origPoints) {
      const pts = it.origPoints.map((q) => ({ x: clamp(q.x + dx, 0, 1), y: clamp(q.y + dy, 0, 1) }));
      setShapes((prev) => prev.map((s, idx) => (idx === it.index ? { ...s, geometry: { points: pts } } : s)));
    } else if (it.mode === "vertex" && it.index != null && it.origPoints && it.vertex != null) {
      const pts = it.origPoints.map((q, vi) => (vi === it.vertex ? { x: p.x, y: p.y } : { ...q }));
      setShapes((prev) => prev.map((s, idx) => (idx === it.index ? { ...s, geometry: { points: pts } } : s)));
    } else if (it.mode === "resize" && it.index != null && it.origPoints && it.handle) {
      const [a, b] = it.origPoints;
      let minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x);
      let miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
      if (it.handle.includes("w")) minx = p.x; else maxx = p.x;
      if (it.handle.includes("n")) miny = p.y; else maxy = p.y;
      const pts = [
        { x: clamp(Math.min(minx, maxx), 0, 1), y: clamp(Math.min(miny, maxy), 0, 1) },
        { x: clamp(Math.max(minx, maxx), 0, 1), y: clamp(Math.max(miny, maxy), 0, 1) },
      ];
      setShapes((prev) => prev.map((s, idx) => (idx === it.index ? { ...s, geometry: { points: pts } } : s)));
    }
  }

  function onUp() {
    const it = interaction.current;
    if (it && it.mode === "rect" && draft) {
      const [a, b] = draft;
      if (Math.abs(a.x - b.x) > 0.005 && Math.abs(a.y - b.y) > 0.005) {
        const pts = [
          { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
          { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
        ];
        commit([...shapes, { class_name: label, annotation_type: "rectangle", geometry: { points: pts }, source: "manual", status: "confirmed" }]);
      }
      setDraft(null);
    } else if (it && (it.mode === "move" || it.mode === "resize" || it.mode === "vertex")) {
      // record history entry with pre-edit snapshot
      past.current.push(it.snapshot);
      future.current = [];
      dirty.current = true;
    }
    interaction.current = null;
  }

  function finishPolygon() {
    if (draft && draft.length >= 3)
      commit([...shapes, { class_name: label, annotation_type: "polygon", geometry: { points: draft }, source: "manual", status: "confirmed" }]);
    setDraft(null);
  }

  function del(i: number) {
    commit(shapes.filter((_, idx) => idx !== i));
    setSelected((s) => (s === i ? null : s != null && s > i ? s - 1 : s));
  }
  function toggleHidden(i: number) {
    commit(shapes.map((s, idx) => (idx === i ? { ...s, hidden: !s.hidden } : s)));
  }
  function toggleLocked(i: number) {
    commit(shapes.map((s, idx) => (idx === i ? { ...s, locked: !s.locked } : s)));
  }
  function renameClass(i: number, name: string) {
    commit(shapes.map((s, idx) => (idx === i ? { ...s, class_name: name, color: classColor(name) } : s)));
  }
  function recolor(i: number, color: string) {
    commit(shapes.map((s, idx) => (idx === i ? { ...s, color } : s)));
  }

  // Focus / center an annotation from the panel
  function focusShape(i: number) {
    setSelected(i);
    const pts = shapes[i].geometry.points;
    const cx = (pts.reduce((a, p) => a + p.x, 0) / pts.length) * VB_W;
    const cy = (pts.reduce((a, p) => a + p.y, 0) / pts.length) * VB_H;
    setView((v) => ({ scale: v.scale, tx: VB_W / 2 - cx * v.scale, ty: VB_H / 2 - cy * v.scale }));
  }

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "v") setTool("select");
      if (e.key === "r") setTool("rectangle");
      if (e.key === "p") setTool("polygon");
      if (e.key === "h") setTool("pan");
      if (e.key === "Enter" && tool === "polygon") finishPolygon();
      if ((e.key === "Delete" || e.key === "Backspace") && selected != null) { e.preventDefault(); del(selected); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [tool, draft, selected, undo, redo]);

  async function saveShapes(silent = false) {
    if (!user) return;
    await supabase.from("annotations").delete().eq("image_id", imageId);
    if (shapes.length) {
      const rows = shapes.map((s) => ({
        image_id: imageId, user_id: user.id, class_name: s.class_name,
        annotation_type: s.annotation_type, geometry: s.geometry as unknown as Json,
        confidence: s.confidence ?? null, source: s.source, status: s.status,
      }));
      const { error } = await supabase.from("annotations").insert(rows);
      if (error) { if (!silent) toast.error(error.message); return; }
    }
    await supabase.from("images").update({ status: shapes.length ? "labeled" : "uploaded" }).eq("id", imageId);
    qc.invalidateQueries({ queryKey: ["stats"] });
    dirty.current = false;
    if (!silent) toast.success("Annotations saved");
  }

  // debounced auto-save on any change
  useEffect(() => {
    if (!dirty.current || !user) return;
    const t = setTimeout(() => { saveShapes(true); }, 1200);
    return () => clearTimeout(t);
  }, [shapes, user]);

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
            class_name: p.class, annotation_type: "polygon" as const,
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
      if (newShapes.length === 0) {
        toast.info("No predictions above the confidence threshold");
      } else {
        commit([...shapes, ...newShapes]);
        toast.success(`AI added ${newShapes.length} suggestion(s)`);
      }
    } catch {
      toast.error("AI labeling failed. Please try again.");
    } finally { setAiBusy(false); }
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

  const cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";

  return (
    <div>
      <PageHeader
        title={image?.filename ?? "Annotation Studio"}
        subtitle="Draw, edit, zoom and pan annotations, or run AI to auto-label"
        action={
          <div className="flex gap-2">
            <Button variant="ghost" asChild><Link to="/label"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Link></Button>
            <Button onClick={() => saveShapes(false)}><Save className="mr-1 h-4 w-4" /> Save</Button>
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
            <Button size="sm" variant="ghost" onClick={fitScreen} title="Fit / Reset view"><Scan className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={fullScreen} title="Full screen"><Maximize2 className="h-4 w-4" /></Button>
            <div className="mx-1 h-6 w-px bg-border" />
            <Button size="sm" variant="ghost" onClick={undo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={redo} title="Redo (Ctrl+Y)"><Redo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => selected != null && del(selected)} disabled={selected == null} title="Delete selected"><Trash2 className="h-4 w-4" /></Button>
            <Button size="sm" variant={showAll ? "ghost" : "secondary"} onClick={() => setShowAll((v) => !v)} title="Toggle annotation visibility">
              {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </Button>
            <span className="ml-auto px-2 text-xs text-muted-foreground">{Math.round(view.scale * 100)}%</span>
            {tool === "polygon" && draft && <Button size="sm" variant="secondary" onClick={finishPolygon}>Finish polygon</Button>}
          </div>

          <div ref={canvasRef} className="overflow-hidden rounded-xl border border-border bg-[#0b1020]">
            <svg
              ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`} className="aspect-[10/7] w-full select-none"
              style={{ cursor }}
              onMouseDown={onCanvasDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
              onWheel={onWheel}
            >
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
                {url && imgOk ? (
                  <image href={url} x={0} y={0} width={VB_W} height={VB_H} preserveAspectRatio="xMidYMid slice" onError={() => setImgOk(false)} />
                ) : (
                  <>
                    <rect x={0} y={0} width={VB_W} height={VB_H} fill="#0b1020" />
                    <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="#5b6478" fontSize={18}>
                      Preview unavailable for this format — annotations still work
                    </text>
                  </>
                )}

                {showAll && shapes.map((s, i) => {
                  if (s.hidden) return null;
                  const p = s.geometry.points;
                  if (!p.length) return null;
                  const col = colorFor(s);
                  const isSel = selected === i;
                  const isHov = hover === i;
                  const sw = (isSel ? 3 : 2) / view.scale;
                  const conf = s.source === "ai" && s.confidence != null ? ` (${Math.round(s.confidence * 100)}%)` : "";
                  const fillOp = isSel || isHov ? "3d" : "33"; // ~24% / ~20%
                  const common = {
                    onMouseDown: (e: React.MouseEvent) => beginMove(e, i),
                    onMouseEnter: () => setHover(i),
                    onMouseLeave: () => setHover((h) => (h === i ? null : h)),
                    style: { cursor: tool === "select" && !s.locked ? "move" : "pointer" as const },
                  };

                  if (s.annotation_type === "rectangle") {
                    const x = Math.min(p[0].x, p[1].x) * VB_W, y = Math.min(p[0].y, p[1].y) * VB_H;
                    const w = Math.abs(p[1].x - p[0].x) * VB_W, hgt = Math.abs(p[1].y - p[0].y) * VB_H;
                    const hs = 7 / view.scale;
                    return (
                      <g key={i}>
                        <rect x={x} y={y} width={w} height={hgt} fill={col + fillOp} stroke={col} strokeWidth={sw}
                          strokeDasharray={s.source === "ai" ? `${6 / view.scale} ${4 / view.scale}` : undefined} {...common} />
                        <text x={x + 4 / view.scale} y={y + 16 / view.scale} fill={col} fontSize={13 / view.scale}
                          style={{ pointerEvents: "none" }}>{s.class_name}{conf}</text>
                        {isSel && !s.locked && ([
                          ["nw", x, y], ["ne", x + w, y], ["sw", x, y + hgt], ["se", x + w, y + hgt],
                        ] as const).map(([hd, hx, hy]) => (
                          <rect key={hd} x={hx - hs / 2} y={hy - hs / 2} width={hs} height={hs} fill="#fff" stroke={col}
                            strokeWidth={1 / view.scale} style={{ cursor: "nwse-resize" }}
                            onMouseDown={(e) => beginResize(e, i, hd)} />
                        ))}
                      </g>
                    );
                  }
                  const pts = p.map((q) => `${q.x * VB_W},${q.y * VB_H}`).join(" ");
                  const vs = 6 / view.scale;
                  return (
                    <g key={i}>
                      <polygon points={pts} fill={col + fillOp} stroke={col} strokeWidth={sw}
                        strokeDasharray={s.source === "ai" ? `${6 / view.scale} ${4 / view.scale}` : undefined} {...common} />
                      <text x={p[0].x * VB_W + 4 / view.scale} y={p[0].y * VB_H - 4 / view.scale} fill={col} fontSize={13 / view.scale}
                        style={{ pointerEvents: "none" }}>{s.class_name}{conf}</text>
                      {isSel && !s.locked && p.map((q, vi) => (
                        <circle key={vi} cx={q.x * VB_W} cy={q.y * VB_H} r={vs} fill="#fff" stroke={col}
                          strokeWidth={1 / view.scale} style={{ cursor: "grab" }} onMouseDown={(e) => beginVertex(e, i, vi)} />
                      ))}
                    </g>
                  );
                })}

                {draft && tool === "rectangle" && (
                  <rect x={Math.min(draft[0].x, draft[1].x) * VB_W} y={Math.min(draft[0].y, draft[1].y) * VB_H}
                    width={Math.abs(draft[1].x - draft[0].x) * VB_W} height={Math.abs(draft[1].y - draft[0].y) * VB_H}
                    fill="none" stroke={classColor(label)} strokeWidth={2 / view.scale} strokeDasharray={`${4 / view.scale} ${4 / view.scale}`} />
                )}
                {draft && tool === "polygon" && (
                  <polyline points={draft.map((q) => `${q.x * VB_W},${q.y * VB_H}`).join(" ")} fill="none" stroke={classColor(label)} strokeWidth={2 / view.scale} />
                )}
              </g>
            </svg>
          </div>
        </div>

        <div className="w-full space-y-4 lg:w-80">
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
            <div className="max-h-[24rem] space-y-2 overflow-auto">
              {shapes.map((s, i) => {
                const isSel = selected === i;
                const conf = s.source === "ai" && s.confidence != null ? `${Math.round(s.confidence * 100)}%` : null;
                return (
                  <div key={i}
                    className={cn("rounded-md border px-2 py-1.5 text-xs", isSel ? "border-gold bg-gold/5" : "border-border", hover === i && "bg-muted/40")}
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
                    <div className="flex items-center gap-1.5">
                      <button className="flex flex-1 items-center gap-2 text-left" onClick={() => focusShape(i)}>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s) }} />
                        <span className="font-medium">{s.class_name}</span>
                        {conf && <Badge variant="outline" className="h-4 px-1 text-[10px]">{conf}</Badge>}
                        {s.source === "ai" && <Badge variant="outline" className="h-4 px-1 text-[10px]">AI</Badge>}
                      </button>
                      <button onClick={() => toggleHidden(i)} title="Toggle visibility">
                        {s.hidden ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : <Eye className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                      <button onClick={() => toggleLocked(i)} title="Lock / unlock">
                        {s.locked ? <Lock className="h-3.5 w-3.5 text-gold" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                      <button onClick={() => del(i)} title="Delete"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.annotation_type}</span>
                      {isSel && (
                        <div className="flex items-center gap-1.5">
                          <Select value={LABELS.some((l) => l.name === s.class_name) ? s.class_name : undefined} onValueChange={(v) => renameClass(i, v)}>
                            <SelectTrigger className="h-6 w-24 text-[11px]"><SelectValue placeholder="Class" /></SelectTrigger>
                            <SelectContent>
                              {LABELS.map((l) => <SelectItem key={l.name} value={l.name} className="text-xs">{l.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <input type="color" value={colorFor(s)} onChange={(e) => recolor(i, e.target.value)}
                            className="h-6 w-6 cursor-pointer rounded border border-border bg-transparent p-0" title="Change color" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {shapes.length === 0 && <p className="text-xs text-muted-foreground">No annotations yet.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
