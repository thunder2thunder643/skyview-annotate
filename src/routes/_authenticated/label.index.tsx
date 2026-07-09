import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PenTool } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { getImages, getProjects } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/label/")({
  component: LabelIndex,
});

function LabelIndex() {
  const { data: images } = useQuery({ queryKey: ["images", undefined], queryFn: () => getImages() });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const projName = (id: string) => projects?.find((p) => p.id === id)?.name ?? "—";

  return (
    <div>
      <PageHeader title="Label Images" subtitle="Pick an image to open the annotation studio" />
      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {(images ?? []).map((img) => (
          <Link
            key={img.id} to="/label/$imageId" params={{ imageId: img.id }}
            className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-gold/40"
          >
            <div className="flex items-center gap-3">
              <PenTool className="h-5 w-5 text-gold" />
              <div className="min-w-0">
                <p className="truncate font-medium">{img.filename}</p>
                <p className="text-xs text-muted-foreground">{projName(img.project_id)}</p>
              </div>
            </div>
            <Badge variant="secondary" className="mt-3">{img.status}</Badge>
          </Link>
        ))}
        {images && images.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No images uploaded yet.
          </div>
        )}
      </div>
    </div>
  );
}
