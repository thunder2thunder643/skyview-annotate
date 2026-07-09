import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, FileDown } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { getProjects, getImages, getAnnotations, getExports } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/export")({
  component: ExportPage,
});

const FORMATS = ["GeoTIFF", "COG", "PNG", "JPG", "PDF", "KMZ", "KML", "COCO", "YOLO", "GeoJSON"];
const CRS = ["WGS84", "UTM", "EPSG:3857"];

function download(name: string, content: string, type = "application/json") {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ExportPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const { data: history } = useQuery({ queryKey: ["exports"], queryFn: getExports });
  const [projectId, setProjectId] = useState<string>();
  const [format, setFormat] = useState("GeoJSON");
  const [crs, setCrs] = useState("WGS84");
  const [pyramids, setPyramids] = useState(true);
  const [busy, setBusy] = useState(false);

  async function buildAnnotationExport(fmt: string, imgs: { id: string; filename: string; width: number | null; height: number | null }[]) {
    if (fmt === "GeoJSON") {
      const features: unknown[] = [];
      for (const img of imgs) {
        const ann = await getAnnotations(img.id);
        for (const a of ann) {
          const pts = (a.geometry as { points: { x: number; y: number }[] }).points ?? [];
          const ring = a.annotation_type === "rectangle" && pts.length === 2
            ? [pts[0], { x: pts[1].x, y: pts[0].y }, pts[1], { x: pts[0].x, y: pts[1].y }, pts[0]]
            : [...pts, pts[0]].filter(Boolean);
          features.push({
            type: "Feature",
            properties: { class: a.class_name, source: a.source, confidence: a.confidence, image: img.filename },
            geometry: { type: "Polygon", coordinates: [ring.map((p) => [p.x, p.y])] },
          });
        }
      }
      return JSON.stringify({ type: "FeatureCollection", crs, features }, null, 2);
    }
    if (fmt === "COCO") {
      const categories = ["Building", "Road", "Vehicle", "Airport", "Ship", "Bridge"].map((n, i) => ({ id: i + 1, name: n }));
      const catId = (n: string) => (categories.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ?? 1);
      const coco = { images: [] as unknown[], annotations: [] as unknown[], categories };
      let aid = 1;
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        coco.images.push({ id: i + 1, file_name: img.filename, width: img.width ?? 0, height: img.height ?? 0 });
        const ann = await getAnnotations(img.id);
        for (const a of ann) {
          const pts = (a.geometry as { points: { x: number; y: number }[] }).points ?? [];
          const w = img.width ?? 1, h = img.height ?? 1;
          if (a.annotation_type === "rectangle" && pts.length === 2) {
            const x = Math.min(pts[0].x, pts[1].x) * w, y = Math.min(pts[0].y, pts[1].y) * h;
            const bw = Math.abs(pts[1].x - pts[0].x) * w, bh = Math.abs(pts[1].y - pts[0].y) * h;
            coco.annotations.push({ id: aid++, image_id: i + 1, category_id: catId(a.class_name), bbox: [x, y, bw, bh], area: bw * bh, iscrowd: 0 });
          }
        }
      }
      return JSON.stringify(coco, null, 2);
    }
    // YOLO (single text index)
    let out = "";
    const cats = ["Building", "Road", "Vehicle", "Airport", "Ship", "Bridge"];
    for (const img of imgs) {
      const ann = await getAnnotations(img.id);
      for (const a of ann) {
        const pts = (a.geometry as { points: { x: number; y: number }[] }).points ?? [];
        if (a.annotation_type === "rectangle" && pts.length === 2) {
          const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
          const bw = Math.abs(pts[1].x - pts[0].x), bh = Math.abs(pts[1].y - pts[0].y);
          const ci = Math.max(0, cats.findIndex((c) => c.toLowerCase() === a.class_name.toLowerCase()));
          out += `${img.filename} ${ci} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}\n`;
        }
      }
    }
    return out || "# no bounding boxes\n";
  }

  async function generate() {
    if (!projectId) return toast.error("Select a project");
    setBusy(true);
    try {
      const imgs = await getImages(projectId);
      let downloadable = true;
      if (["GeoJSON", "COCO", "YOLO"].includes(format)) {
        const content = await buildAnnotationExport(format, imgs);
        const ext = format === "YOLO" ? "txt" : format === "GeoJSON" ? "geojson" : "json";
        download(`skyvonyx-${format.toLowerCase()}.${ext}`, content, format === "YOLO" ? "text/plain" : "application/json");
      } else {
        downloadable = false;
        toast.info(`${format} export queued — GIS/raster rendering runs server-side.`);
      }
      await supabase.from("exports").insert({
        project_id: projectId, user_id: user!.id, format, coordinate_system: crs,
        status: downloadable ? "ready" : "queued",
      });
      qc.invalidateQueries({ queryKey: ["exports"] });
      if (downloadable) toast.success(`${format} exported`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="Export Center" subtitle="Generate GIS, image, report and dataset outputs" />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger><SelectValue placeholder="Select a project" /></SelectTrigger>
                  <SelectContent>{(projects ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Coordinate system</Label>
                <Select value={crs} onValueChange={setCrs}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CRS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-5">
              <Label className="mb-2 block">Format</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {FORMATS.map((f) => (
                  <label key={f} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${format === f ? "border-gold" : "border-border"}`}>
                    <Checkbox checked={format === f} onCheckedChange={() => setFormat(f)} />
                    {f}
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <span className="text-sm">Build pyramids / overviews</span>
              <Switch checked={pyramids} onCheckedChange={setPyramids} />
            </div>

            <Button className="mt-5 w-full" onClick={generate} disabled={busy}>
              <Download className="mr-2 h-4 w-4" /> {busy ? "Generating…" : "Generate export"}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              GeoJSON, COCO & YOLO download instantly. Raster formats (GeoTIFF, COG, KMZ…) are queued for server processing.
            </p>
          </div>
        </div>

        <div>
          <h3 className="mb-3 font-semibold">Export history</h3>
          <div className="space-y-2">
            {(history ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <span className="flex items-center gap-2"><FileDown className="h-4 w-4 text-gold" /> {h.format}</span>
                <Badge variant="secondary">{h.status}</Badge>
              </div>
            ))}
            {history && history.length === 0 && <p className="text-sm text-muted-foreground">No exports yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
