import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Square, Hexagon, Hand, Undo2, Redo2, Trash2, Sparkles, Save, ArrowLeft,
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
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/label/$imageId")({
  component: Studio,
});

type Tool = "rectangle" | "polygon" | "pan";
type Shape = {
  id?: string;
  class_name: string;
  annotation_type: "rectangle" | "polygon";
  geometry: { points: { x: number; y: number }[] }; // normalized 0..1
  confidence?: number | null;
  source: string;
  status: string;
};

const LABELS = [
  { name: "Building", color: "#0EA5E9" },
  { name: "Road", color: "#D4AF37" },
  { name: "Vehicle", color: "#22c55e" },
  { name: "Airport", color: "#a855f7" },
  { name: "Ship", color: "#ef4444" },
  { name: "Bridge", color: "#f97316" },
];
const colorFor = (c: string) => LABELS.find((l) => l.name.toLowerCase() === c.toLowerCase())?.color ?? "#0EA5E9";

function Studio() {
  const { imageId } = Route.useParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const runAi = useServerFn(runRoboflowWorkflow);

  const { data: image } = useQuery({ queryKey: ["image", imageId], queryFn: () => getImage(imageId) });
  const { data: saved } = useQuery({ queryKey: ["annotations", imageId], queryFn: () => getAnnotations(imageId) });
  const [url, setUrl] = useState<string>();
  const [imgOk, setImgOk] = useState(true);

  const [tool, setTool] = useState<Tool>("rectangle");
  const [label, setLabel] = useState(LABELS[0].name);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [redo, setRedo] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<{ x: number; y: number }[] | null>(null);
  const [confidence, setConfidence] = useState(50);
  const [aiBusy, setAiBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

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

  const pt = useCallback((e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }, []);

  function pushShape(s: Shape) { setShapes((p) => [...p, s]); setRedo([]); }

  function onDown(e: React.MouseEvent) {
    if (tool === "pan") return;
    const p = pt(e);
    if (tool === "rectangle") setDraft([p, p]);
    else setDraft((d) => (d ? [...d, p] : [p]));
  }
  function onMove(e: React.MouseEvent) {
    if (tool === "rectangle" && draft) { const p = pt(e); setDraft([draft[0], p]); }
  }
  function onUp() {
    if (tool === "rectangle" && draft) {
      const [a, b] = draft;
      if (Math.abs(a.x - b.x) > 0.005 && Math.abs(a.y - b.y) > 0.005)
        pushShape({ class_name: label, annotation_type: "rectangle", geometry: { points: [a, b] }, source: "manual", status: "confirmed" });
      setDraft(null);
    }
  }
  function finishPolygon() {
    if (draft && draft.length >= 3)
      pushShape({ class_name: label, annotation_type: "polygon", geometry: { points: draft }, source: "manual", status: "confirmed" });
    setDraft(null);
  }

  function undo() { setShapes((p) => { if (!p.length) return p; const last = p[p.length - 1]; setRedo((r) => [...r, last]); return p.slice(0, -1); }); }
  function redoFn() { setRedo((r) => { if (!r.length) return r; const last = r[r.length - 1]; setShapes((p) => [...p, last]); return r.slice(0, -1); }); }
  function del(i: number) { setShapes((p) => p.filter((_, idx) => idx !== i)); }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "r") setTool("rectangle");
      if (e.key === "p") setTool("polygon");
      if (e.key === "h") setTool("pan");
      if (e.key === "Enter" && tool === "polygon") finishPolygon();
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redoFn(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [tool, draft]);

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
        toast.success(`AI added ${newShapes.length} suggestion(s)`);
      }
    } catch (e) {
      toast.error("AI labeling failed. Please try again.");
    } finally { setAiBusy(false); }
  }

  async function save() {
    if (!user) return;
    await supabase.from("annotations").delete().eq("image_id", imageId);
    if (shapes.length) {
      const rows = shapes.map((s) => ({
        image_id: imageId, user_id: user.id, class_name: s.class_name,
        annotation_type: s.annotation_type, geometry: s.geometry as unknown as Json,
        confidence: s.confidence ?? null, source: s.source, status: s.status,
      }));
      const { error } = await supabase.from("annotations").insert(rows);
      if (error) return toast.error(error.message);
    }
    await supabase.from("images").update({ status: "labeled" }).eq("id", imageId);
    qc.invalidateQueries({ queryKey: ["annotations", imageId] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    toast.success("Annotations saved");
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    shapes.forEach((s) => { m[s.class_name] = (m[s.class_name] ?? 0) + 1; });
    return m;
  }, [shapes]);

  const tools: { id: Tool; icon: typeof Square; label: string }[] = [
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
            <Button size="sm" variant="ghost" onClick={undo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={redoFn} title="Redo (Ctrl+Y)"><Redo2 className="h-4 w-4" /></Button>
            {tool === "polygon" && draft && <Button size="sm" variant="secondary" onClick={finishPolygon}>Finish polygon</Button>}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-[#0b1020]">
            <svg
              ref={svgRef} viewBox="0 0 1000 700" className="aspect-[10/7] w-full cursor-crosshair select-none"
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
            >
              {url && imgOk ? (
                <image href={url} x={0} y={0} width={1000} height={700} preserveAspectRatio="xMidYMid slice" onError={() => setImgOk(false)} />
              ) : (
                <>
                  <rect x={0} y={0} width={1000} height={700} fill="#0b1020" />
                  <text x={500} y={350} textAnchor="middle" fill="#5b6478" fontSize={18}>
                    Preview unavailable for this format — annotations still work
                  </text>
                </>
              )}
              {shapes.map((s, i) => {
                const p = s.geometry.points;
                const col = colorFor(s.class_name);
                if (s.annotation_type === "rectangle") {
                  const x = Math.min(p[0].x, p[1].x) * 1000, y = Math.min(p[0].y, p[1].y) * 700;
                  const w = Math.abs(p[1].x - p[0].x) * 1000, h = Math.abs(p[1].y - p[0].y) * 700;
                  return <g key={i}>
                    <rect x={x} y={y} width={w} height={h} fill={col + "22"} stroke={col} strokeWidth={2} strokeDasharray={s.source === "ai" ? "6 4" : undefined} />
                    <text x={x + 4} y={y + 16} fill={col} fontSize={13}>{s.class_name}</text>
                  </g>;
                }
                const pts = p.map((q) => `${q.x * 1000},${q.y * 700}`).join(" ");
                return <g key={i}>
                  <polygon points={pts} fill={col + "22"} stroke={col} strokeWidth={2} strokeDasharray={s.source === "ai" ? "6 4" : undefined} />
                  <text x={p[0].x * 1000 + 4} y={p[0].y * 700 - 4} fill={col} fontSize={13}>{s.class_name}</text>
                </g>;
              })}
              {draft && tool === "rectangle" && (
                <rect x={Math.min(draft[0].x, draft[1].x) * 1000} y={Math.min(draft[0].y, draft[1].y) * 700}
                  width={Math.abs(draft[1].x - draft[0].x) * 1000} height={Math.abs(draft[1].y - draft[0].y) * 700}
                  fill="none" stroke={colorFor(label)} strokeWidth={2} strokeDasharray="4 4" />
              )}
              {draft && tool === "polygon" && (
                <polyline points={draft.map((q) => `${q.x * 1000},${q.y * 700}`).join(" ")} fill="none" stroke={colorFor(label)} strokeWidth={2} />
              )}
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
            <Button className="w-full" onClick={autoLabel} disabled={aiBusy || !url}>{aiBusy ? "Running…" : "Run AI"}</Button>
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
            <div className="max-h-64 space-y-1 overflow-auto">
              {shapes.map((s, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border border-border px-2 py-1 text-xs">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s.class_name) }} />
                    {s.class_name}
                    {s.source === "ai" && <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">AI</Badge>}
                  </span>
                  <button onClick={() => del(i)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
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
