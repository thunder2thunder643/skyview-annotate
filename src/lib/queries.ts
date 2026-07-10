import { supabase } from "@/integrations/supabase/client";

export const BUCKET = "satellite-images";

export const ACCEPTED_EXT = [".cog", ".tif", ".tiff", ".jp2", ".kmz", ".nc", ".jpg", ".jpeg"];

export async function getProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getProject(id: string) {
  const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function getImages(projectId?: string) {
  let q = supabase.from("images").select("*").order("created_at", { ascending: false });
  if (projectId) q = q.eq("project_id", projectId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getImage(id: string) {
  const { data, error } = await supabase.from("images").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function getAnnotations(imageId: string) {
  const { data, error } = await supabase
    .from("annotations")
    .select("*")
    .eq("image_id", imageId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getExports() {
  const { data, error } = await supabase
    .from("exports")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getStats() {
  const [images, annotations, pending, exports] = await Promise.all([
    supabase.from("images").select("id", { count: "exact", head: true }),
    supabase.from("annotations").select("id", { count: "exact", head: true }),
    supabase.from("annotations").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("exports").select("id", { count: "exact", head: true }),
  ]);
  return {
    images: images.count ?? 0,
    annotations: annotations.count ?? 0,
    pending: pending.count ?? 0,
    exports: exports.count ?? 0,
  };
}

export async function signedUrl(path: string) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Permanently delete an uploaded image and all associated records.
 * RLS ensures only the owner can delete their own rows/objects.
 * Order: annotations -> storage object -> image record.
 */
export async function deleteImage(image: { id: string; storage_path: string }) {
  // Remove associated annotations (AI predictions + manual + cached inference).
  const { error: annErr } = await supabase.from("annotations").delete().eq("image_id", image.id);
  if (annErr) throw annErr;

  // Remove the file from storage (ignore missing-object errors).
  const { error: storageErr } = await supabase.storage.from(BUCKET).remove([image.storage_path]);
  if (storageErr) throw storageErr;

  // Remove the database record.
  const { error: imgErr } = await supabase.from("images").delete().eq("id", image.id);
  if (imgErr) throw imgErr;
}

export function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
