import { createFileRoute, Link } from "@tanstack/react-router";
import { Satellite, ShieldCheck, Boxes, Sparkles, Download, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import heroImg from "@/assets/hero-satellite.jpg";

export const Route = createFileRoute("/")({
  component: Landing,
});

const features = [
  { icon: Sparkles, title: "AI-Assisted Labeling", desc: "Run your Roboflow workflow to auto-suggest boxes and polygons, then accept, reject, or refine." },
  { icon: Layers, title: "Rectangle & Polygon Tools", desc: "Annotate buildings, roads, ships and more with a fast, keyboard-driven canvas." },
  { icon: ShieldCheck, title: "Secure by Design", desc: "API keys stay server-side. Row-level security keeps every project private to its owner." },
  { icon: Boxes, title: "Project Management", desc: "Organize imagery into projects with upload queues, review workflows and activity." },
  { icon: Download, title: "GIS-Ready Exports", desc: "Export to GeoTIFF, COG, KMZ, PNG, plus COCO, YOLO and GeoJSON." },
  { icon: Satellite, title: "Built for Satellite Imagery", desc: "Handles COG, GeoTIFF, TIFF, JP2, KMZ and NetCDF sources." },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Satellite className="h-6 w-6 text-gold" />
          <span className="text-lg font-extrabold tracking-tight">SKY<span className="text-gold">VONYX</span></span>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/auth">Sign in</Link>
        </Button>
      </header>

      <section className="bg-space-grid">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-16 md:grid-cols-2 md:py-24">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 px-3 py-1 text-xs font-medium text-gold">
              <Sparkles className="h-3.5 w-3.5" /> Satellite Image Labeling Platform
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
              Label satellite imagery at <span className="text-gold">mission-grade</span> speed
            </h1>
            <p className="mt-4 max-w-lg text-muted-foreground">
              A secure, aerospace-inspired workspace combining the best of Labelbox, CVAT and Roboflow — built specifically for geospatial data.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/auth">Get started</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/auth">Sign in</Link>
              </Button>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border card-glow">
            <img src={heroImg} alt="Satellite view of Earth from orbit" className="h-full w-full object-cover" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">Everything you need to annotate from orbit</h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-card p-5">
              <f.icon className="h-6 w-6 text-gold" />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border px-6 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Skyvonyx — Satellite Image Labeling Platform
      </footer>
    </div>
  );
}
