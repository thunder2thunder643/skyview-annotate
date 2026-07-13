import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PenTool, Trash2, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { getImages, getProjects, deleteImage } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/label/")({
  component: LabelIndex,
});

function LabelIndex() {
  const qc = useQueryClient();
  const { data: images } = useQuery({ queryKey: ["images", undefined], queryFn: () => getImages() });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const projName = (id: string) => projects?.find((p) => p.id === id)?.name ?? "—";

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const list = images ?? [];
  const allSelected = useMemo(
    () => list.length > 0 && list.every((i) => selected.has(i.id)),
    [list, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(list.map((i) => i.id)));

  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };

  async function bulkDelete() {
    if (deleting || selected.size === 0) return;
    setDeleting(true);
    const targets = list.filter((i) => selected.has(i.id));
    // Optimistically remove from the cached list, then sync each deletion.
    const prev = qc.getQueryData(["images", undefined]);
    qc.setQueryData(["images", undefined], (old: typeof images) =>
      (old ?? []).filter((i) => !selected.has(i.id)),
    );
    const results = await Promise.allSettled(
      targets.map((img) => deleteImage({ id: img.id, storage_path: img.storage_path })),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      console.error("Some images failed to delete", results);
      qc.setQueryData(["images", undefined], prev); // roll back and refetch truth
      await qc.invalidateQueries({ queryKey: ["images"] });
      toast.error(`Couldn't delete ${failed} image${failed > 1 ? "s" : ""}. Please try again.`);
    } else {
      toast.success(`Deleted ${targets.length} image${targets.length > 1 ? "s" : ""}.`);
    }
    await qc.invalidateQueries({ queryKey: ["images"] });
    setDeleting(false);
    setConfirmOpen(false);
    exitSelect();
  }

  return (
    <div>
      <PageHeader title="Label Images" subtitle="Pick an image to open the annotation studio" />

      <div className="flex flex-wrap items-center justify-end gap-2 px-6 pt-2">
        {selectMode ? (
          <>
            <span className="mr-auto text-sm text-muted-foreground">
              {selected.size} selected
            </span>
            <Button size="sm" variant="outline" onClick={toggleAll} disabled={list.length === 0}>
              {allSelected ? "Clear all" : "Select all"}
            </Button>
            <Button
              size="sm" variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={selected.size === 0 || deleting}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Delete selected
            </Button>
            <Button size="sm" variant="ghost" onClick={exitSelect} disabled={deleting}>
              <X className="mr-1 h-4 w-4" /> Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setSelectMode(true)} disabled={list.length === 0}>
            Select
          </Button>
        )}
      </div>

      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((img) => {
          const isSel = selected.has(img.id);
          const card = (
            <div className={cn(
              "relative rounded-xl border bg-card p-5 transition-colors",
              isSel ? "border-gold" : "border-border hover:border-gold/40",
            )}>
              {selectMode && (
                <Checkbox
                  checked={isSel}
                  onCheckedChange={() => toggle(img.id)}
                  className="absolute right-3 top-3"
                  aria-label={`Select ${img.filename}`}
                />
              )}
              <div className="flex items-center gap-3">
                <PenTool className="h-5 w-5 text-gold" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{img.filename}</p>
                  <p className="text-xs text-muted-foreground">{projName(img.project_id)}</p>
                </div>
              </div>
              <Badge variant="secondary" className="mt-3">{img.status}</Badge>
            </div>
          );
          return selectMode ? (
            <button key={img.id} type="button" onClick={() => toggle(img.id)} className="text-left">
              {card}
            </button>
          ) : (
            <Link key={img.id} to="/label/$imageId" params={{ imageId: img.id }}>
              {card}
            </Link>
          );
        })}
        {images && images.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No images uploaded yet.
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !deleting && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} image{selected.size > 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected images and all associated annotations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); bulkDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Deleting…</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
