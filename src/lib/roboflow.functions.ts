import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Secure Roboflow inference proxy.
 * The ROBOFLOW_API_KEY never leaves the server — the browser only sends an image URL.
 * Configure the workflow via env: ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID.
 */
export const runRoboflowWorkflow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { imageUrl: string; confidence?: number }) => {
    if (!data?.imageUrl || typeof data.imageUrl !== "string") {
      throw new Error("imageUrl is required");
    }
    return { imageUrl: data.imageUrl, confidence: data.confidence ?? 0.4 };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    if (!apiKey) throw new Error("Roboflow is not configured");

    const workspace = process.env.ROBOFLOW_WORKSPACE ?? "";
    const workflowId = process.env.ROBOFLOW_WORKFLOW_ID ?? "";

    // If a workflow is configured, call the serverless workflow endpoint.
    if (workspace && workflowId) {
      const res = await fetch(
        `https://serverless.roboflow.com/infer/workflows/${workspace}/${workflowId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            inputs: { image: { type: "url", value: data.imageUrl } },
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        console.error(`Roboflow error [${res.status}]: ${body}`);
        return { predictions: [], error: `Inference failed (${res.status})` };
      }
      const json = (await res.json()) as Record<string, unknown>;
      return { predictions: extractPredictions(json), error: null as string | null };
    }

    return {
      predictions: [],
      error:
        "No Roboflow workflow configured yet. Set ROBOFLOW_WORKSPACE and ROBOFLOW_WORKFLOW_ID to enable AI labeling.",
    };
  });

type Prediction = {
  class: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: { x: number; y: number }[] | null;
};

function extractPredictions(json: unknown): Prediction[] {
  const out: Prediction[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.class === "string" &&
      typeof obj.x === "number" &&
      typeof obj.y === "number" &&
      typeof obj.width === "number" &&
      typeof obj.height === "number"
    ) {
      const rawPoints = Array.isArray(obj.points) ? obj.points : null;
      const points =
        rawPoints
          ?.map((p) => {
            const pt = p as Record<string, unknown>;
            return typeof pt?.x === "number" && typeof pt?.y === "number"
              ? { x: pt.x, y: pt.y }
              : null;
          })
          .filter((p): p is { x: number; y: number } => p !== null) ?? null;
      out.push({
        class: obj.class,
        confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
        x: obj.x,
        y: obj.y,
        width: obj.width,
        height: obj.height,
        points: points && points.length >= 3 ? points : null,
      });
    }
    Object.values(obj).forEach(walk);
  };
  walk(json);
  return out;
}
