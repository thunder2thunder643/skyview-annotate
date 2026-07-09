import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileWarning, CheckCircle2, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { getProjects, getImages, ACCEPTED_EXT, BUCKET } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/upload")({
  validateSearch: (s: Record<string, unknown>) => ({ project: typeof s.project === "string" ? s.project : undefined }),
  component: UploadPage,
});

const MAX_SIZE = 500 * 1024 * 1024; // 500MB

type QueueItem = { file: File; status: "pending" | "uploading" | "done" | "error"; progress: number; reason?: string };

function extOk(name: string) {
  const lower = name.toLowerCase();
  return ACCEPTED_EXT.some((e) => lower.endsWith(e));
}

function UploadPage() {
  const { project: initialProject } = Route.useSearch();
  const qc = useQueryClient();
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState<string | undefined>(initialProject);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const { data: images } = useQuery({
    queryKey: ["images", projectId],
    queryFn: () => getImages(projectId),
    enabled: !!projectId,
  });

  const addFiles = useCallback((files: FileList | File[]) => {
    const existing = new Set(queue.map((q) => q.file.name + q.file.size));
    const items: QueueItem[] = [];
    for (const file of Array.from(files)) {
      if (existing.has(file.name + file.size)) continue;
      if (!extOk(file.name)) { items.push({ file, status: "error", progress: 0, reason: "Unsupported format" }); continue; }
      if (file.size > MAX_SIZE) { items.push({ file, status: "error", progress: 0, reason: "File too large" }); continue; }
      items.push({ file, status: "pending", progress: 0 });
    }
    setQueue((q) => [...q, ...items]);
  }, [queue]);

  async function startUpload() {
    if (!projectId) return toast.error("Select a project first");
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status !== "pending") continue;
      setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "uploading", progress: 30 } : it)));
      const file = queue[i].file;
      const path = `${user!.id}/${projectId}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (upErr) {
        setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "error", reason: upErr.message } : it)));
        continue;
      }
      setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, progress: 70 } : it)));
      const { error: dbErr } = await supabase.from("images").insert({
        project_id: projectId, user_id: user!.id, filename: file.name,
        storage_path: path, mime_type: file.type || null, file_size: file.size, status: "uploaded",
      });
      if (dbErr) {
        setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "error", reason: dbErr.message } : it)));
        continue;
      }
      setQueue((q) => q.map((it, idx) => (idx === i ? { ...it, status: "done", progress: 100 } : it)));
    }
    qc.invalidateQueries({ queryKey: ["images", projectId] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    toast.success("Upload batch complete");
  }

  return (
    <div>
      <PageHeader title="Upload Imagery" subtitle="Drag & drop satellite files or browse to add them" />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div className="max-w-sm space-y-2">
            <Label>Target project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger><SelectValue placeholder="Select a project" /></SelectTrigger>
              <SelectContent>
                {(projects ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {projects && projects.length === 0 && (
              <p className="text-xs text-muted-foreground">No projects yet — <Link to="/projects" className="text-gold">create one</Link>.</p>
            )}
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${dragging ? "border-gold bg-gold/5" : "border-border"}`}
          >
            <UploadCloud className="h-10 w-10 text-gold" />
            <p className="mt-4 font-medium">Drag & drop files here</p>
            <p className="text-sm text-muted-foreground">or</p>
            <Button variant="secondary" className="mt-2" onClick={() => inputRef.current?.click()}>Browse files</Button>
            <input
              ref={inputRef} type="file" multiple hidden
              accept={ACCEPTED_EXT.join(",")}
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {ACCEPTED_EXT.map((e) => <Badge key={e} variant="secondary">{e}</Badge>)}
            </div>
          </div>

          {queue.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">Upload queue ({queue.length})</h3>
                <Button size="sm" onClick={startUpload} disabled={!projectId}>Start upload</Button>
              </div>
              <div className="space-y-3">
                {queue.map((it, idx) => (
                  <div key={idx} className="flex items-center gap-3 text-sm">
                    {it.status === "done" ? <CheckCircle2 className="h-4 w-4 text-primary" />
                      : it.status === "error" ? <FileWarning className="h-4 w-4 text-destructive" />
                      : it.status === "uploading" ? <Loader2 className="h-4 w-4 animate-spin text-gold" />
                      : <ImageIcon className="h-4 w-4 text-muted-foreground" />}
                    <span className="w-48 truncate">{it.file.name}</span>
                    <Progress value={it.status === "error" ? 0 : it.progress} className="h-2 flex-1" />
                    <span className="w-28 text-right text-xs text-muted-foreground">
                      {it.reason ?? it.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-3 font-semibold">In this project</h3>
          <div className="space-y-2">
            {(images ?? []).map((img) => (
              <Link
                key={img.id} to="/label/$imageId" params={{ imageId: img.id }}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm hover:border-gold/40"
              >
                <span className="truncate">{img.filename}</span>
                <Badge variant="secondary">{img.status}</Badge>
              </Link>
            ))}
            {(!images || images.length === 0) && (
              <p className="text-sm text-muted-foreground">{projectId ? "No images yet." : "Select a project to see images."}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
