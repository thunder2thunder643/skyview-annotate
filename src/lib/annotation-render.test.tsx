import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { labelAnchor, AnnotationLabel, type Point } from "@/lib/annotation-render";

const W = 1000, H = 700;

describe("labelAnchor (bounding-box top-left)", () => {
  it("anchors a polygon label to the bbox top-left, not the first vertex", () => {
    // First vertex is NOT the top-left; min x/y come from other vertices.
    const poly: Point[] = [
      { x: 0.5, y: 0.2 }, // first vertex (rightish, topish)
      { x: 0.7, y: 0.6 },
      { x: 0.3, y: 0.5 }, // has the min x
      { x: 0.45, y: 0.1 }, // has the min y
    ];
    const a = labelAnchor(poly, W, H);
    expect(a.x).toBeCloseTo(0.3 * W); // 300
    expect(a.y).toBeCloseTo(0.1 * H); // 70
    // Explicitly not the first vertex position.
    expect(a.x).not.toBeCloseTo(0.5 * W);
  });

  it("anchors a rectangle label to its top-left corner regardless of point order", () => {
    const rect: Point[] = [
      { x: 0.8, y: 0.9 }, // bottom-right given first
      { x: 0.2, y: 0.3 }, // top-left given second
    ];
    const a = labelAnchor(rect, W, H);
    expect(a.x).toBeCloseTo(0.2 * W);
    expect(a.y).toBeCloseTo(0.3 * H);
  });

  it("never produces an image-level (0,0) anchor for an off-origin shape", () => {
    const poly: Point[] = [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.5 },
      { x: 0.45, y: 0.7 },
    ];
    const a = labelAnchor(poly, W, H);
    expect(a.x).toBeGreaterThan(0);
    expect(a.y).toBeGreaterThan(0);
  });

  it("gives each polygon its own distinct anchor", () => {
    const p1: Point[] = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }, { x: 0.12, y: 0.25 }];
    const p2: Point[] = [{ x: 0.6, y: 0.55 }, { x: 0.75, y: 0.6 }, { x: 0.65, y: 0.8 }];
    const a1 = labelAnchor(p1, W, H);
    const a2 = labelAnchor(p2, W, H);
    expect(a1).not.toEqual(a2);
  });
});

describe("AnnotationLabel rendering", () => {
  it("renders exactly one label group per annotation, positioned at the anchor", () => {
    const poly: Point[] = [
      { x: 0.5, y: 0.2 }, { x: 0.7, y: 0.6 }, { x: 0.3, y: 0.5 }, { x: 0.45, y: 0.1 },
    ];
    const { x, y } = labelAnchor(poly, W, H);
    const { container } = render(
      <svg>
        <AnnotationLabel x={x} y={y} text="Plane (92%)" color="#22c55e" zoom={1} onSelect={() => {}} />
      </svg>,
    );
    const groups = container.querySelectorAll("[data-annotation-label]");
    expect(groups).toHaveLength(1);

    const rect = container.querySelector("rect")!;
    // Label x sits at the bbox left edge (300). y may tuck to the box top or
    // sit just above it, but must be near the box top (70), never image-level 0.
    expect(Number(rect.getAttribute("x"))).toBeCloseTo(300, 0);
    const ry = Number(rect.getAttribute("y"));
    expect(ry).toBeGreaterThan(0);
    expect(ry).toBeLessThanOrEqual(70);
  });

  it("renders N independent label groups for N annotations (no single image-level label)", () => {
    const shapes: Point[][] = [
      [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }, { x: 0.12, y: 0.25 }],
      [{ x: 0.6, y: 0.55 }, { x: 0.75, y: 0.6 }, { x: 0.65, y: 0.8 }],
      [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.35 }, { x: 0.4, y: 0.5 }],
    ];
    const { container } = render(
      <svg>
        {shapes.map((pts, i) => {
          const { x, y } = labelAnchor(pts, W, H);
          return <AnnotationLabel key={i} x={x} y={y} text={`c${i}`} color="#000" zoom={1} onSelect={() => {}} />;
        })}
      </svg>,
    );
    expect(container.querySelectorAll("[data-annotation-label]")).toHaveLength(shapes.length);
  });
});
