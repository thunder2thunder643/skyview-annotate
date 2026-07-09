import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Image as ImageIcon, Tag, Clock, Download, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { getStats, getProjects } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: getStats });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: getProjects });

  const cards = [
    { label: "Images Uploaded", value: stats?.images ?? 0, icon: ImageIcon },
    { label: "Objects Labeled", value: stats?.annotations ?? 0, icon: Tag },
    { label: "Pending Review", value: stats?.pending ?? 0, icon: Clock },
    { label: "Exports", value: stats?.exports ?? 0, icon: Download },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Mission overview of your labeling workspace"
        action={
          <Button asChild>
            <Link to="/upload">Upload imagery</Link>
          </Button>
        }
      />
      <div className="p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{c.label}</span>
                <c.icon className="h-4 w-4 text-gold" />
              </div>
              <div className="mt-3 text-3xl font-bold">{c.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent projects</h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/projects">View all <ArrowRight className="ml-1 h-4 w-4" /></Link>
          </Button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(projects ?? []).slice(0, 6).map((p) => (
            <Link
              key={p.id}
              to="/upload"
              search={{ project: p.id }}
              className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-gold/40"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.name}</span>
                <Badge variant="secondary">{p.status}</Badge>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{p.description || "No description"}</p>
            </Link>
          ))}
          {projects && projects.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No projects yet. <Link to="/projects" className="text-gold">Create your first project</Link>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
