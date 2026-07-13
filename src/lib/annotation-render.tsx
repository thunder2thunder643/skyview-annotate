import type React from "react";

export type Point = { x: number; y: number };

/**
 * Pixel-space top-left corner of a shape's bounding box, computed from
 * normalized (0..1) points. Works for both rectangles (two corner points)
 * and polygons (>= 3 vertices): it always returns the minimum x/y so the
 * class label anchors to the box's top-left — never to a fixed image-level
 * position and never to an arbitrary vertex.
 */
export function labelAnchor(points: Point[], w: number, h: number): Point {
  if (!points.length) return { x: 0, y: 0 };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  return { x: minX * w, y: minY * h };
}

/**
 * Independent annotation label: a colored pill with white text pinned to a
 * bounding box's top-left corner. Lives inside the zoom/pan <g>, so it moves
 * with its box. If the pill would overflow the top of the image it is tucked
 * just inside the top edge of the box instead.
 */
export function AnnotationLabel({
  x, y, text, color, zoom, onSelect,
}: {
  x: number; y: number; text: string; color: string; zoom: number;
  onSelect: (e: React.MouseEvent) => void;
}) {
  const fontSize = 13 / zoom;
  const padX = 5 / zoom, padY = 3 / zoom, rounded = 4 / zoom;
  const labelW = text.length * fontSize * 0.6 + padX * 2; // fit-content width
  const labelH = fontSize + padY * 2;
  const above = y - labelH;
  const ly = above < 0 ? y : above;
  return (
    <g className="cursor-pointer" data-annotation-label="" onMouseDown={onSelect}>
      <rect x={x} y={ly} width={labelW} height={labelH} rx={rounded} ry={rounded} fill={color} />
      <text x={x + padX} y={ly + labelH - padY - fontSize * 0.15} fill="#fff" fontSize={fontSize} className="font-semibold pointer-events-none">
        {text}
      </text>
    </g>
  );
}