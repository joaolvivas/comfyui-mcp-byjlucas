import { readdir, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, basename } from "node:path";
import { config } from "../config.js";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getClient } from "../comfyui/client.js";

export const MODEL_SUBDIRS = [
  "checkpoints",
  "loras",
  "vae",
  "upscale_models",
  "controlnet",
  "embeddings",
  "clip",
  "diffusers",
  "diffusion_models",
  "gligen",
  "hypernetworks",
  "photomaker",
  "style_models",
  "text_encoders",
  "unet",
] as const;

export type ModelType = (typeof MODEL_SUBDIRS)[number];

export interface HFModelResult {
  id: string;
  modelId: string;
  author: string;
  tags: string[];
  downloads: number;
  likes: number;
  lastModified: string;
}

export interface LocalModel {
  name: string;
  path: string;
  size: number;
  modified: string;
  type: string;
}

function getModelsRoot(): string {
  if (!config.comfyuiPath) {
    throw new ModelError("COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.");
  }
  return join(config.comfyuiPath, "models");
}

export async function searchHuggingFaceModels(
  query: string,
  options: { filter?: string; limit?: number } = {},
): Promise<HFModelResult[]> {
  const { filter, limit = 10 } = options;
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
  });
  if (filter) params.set("filter", filter);

  const headers: Record<string, string> = {};
  if (config.huggingfaceToken) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  }

  const url = `https://huggingface.co/api/models?${params}`;
  logger.debug("HuggingFace API request", { url });

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(
      `HuggingFace API ${res.status}: ${res.statusText}`,
      { url, status: res.status, body },
    );
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((m) => ({
    id: String(m.id ?? m._id ?? ""),
    modelId: String(m.modelId ?? m.id ?? ""),
    author: String(m.author ?? ""),
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    downloads: Number(m.downloads ?? 0),
    likes: Number(m.likes ?? 0),
    lastModified: String(m.lastModified ?? ""),
  }));
}

export async function listLocalModels(
  modelType?: string,
): Promise<LocalModel[]> {
  const dirsToScan: string[] = modelType
    ? [modelType]
    : [...MODEL_SUBDIRS];

  const results: LocalModel[] = [];

  // Path 1: HTTP REST (works with remote ComfyUI; respects extra_model_paths.yaml).
  // This is the source of truth — ComfyUI's /models endpoint reports what is
  // actually available to workflows, including symlinked/mounted dirs from
  // extra_model_paths.yaml. Filesystem scanning of the install dir misses those.
  try {
    const client = getClient();
    for (const dir of dirsToScan) {
      try {
        const res = await client.fetchApi(`/models/${dir}`);
        if (!res.ok) continue;
        const files = (await res.json()) as unknown;
        if (!Array.isArray(files)) continue;
        for (const name of files) {
          if (typeof name !== "string") continue;
          results.push({
            name,
            path: `${dir}/${name}`, // ComfyUI-relative (full path unknown via REST)
            size: 0,
            modified: "",
            type: dir,
          });
        }
      } catch (err) {
        logger.debug(`HTTP /models/${dir} failed, continuing`, { err });
      }
    }
    if (results.length > 0) return results;
  } catch (err) {
    logger.debug("HTTP model listing unavailable, falling back to filesystem", { err });
  }

  // Path 2: filesystem fallback. Only when COMFYUI_PATH is set AND models actually
  // live under that path (no extra_model_paths.yaml indirection).
  if (!config.comfyuiPath) return results;
  const modelsRoot = join(config.comfyuiPath, "models");
  for (const dir of dirsToScan) {
    const dirPath = join(modelsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = join(dirPath, entry);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        results.push({
          name: entry,
          path: filePath,
          size: info.size,
          modified: info.mtime.toISOString(),
          type: dir,
        });
      } catch {}
    }
  }
  return results;
}

export async function downloadModel(
  url: string,
  targetSubfolder: string,
  filename?: string,
): Promise<string> {
  const modelsRoot = getModelsRoot();
  const targetDir = join(modelsRoot, targetSubfolder);

  // Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  const resolvedFilename = filename ?? (basename(new URL(url).pathname) || "model.safetensors");
  const targetPath = join(targetDir, resolvedFilename);

  logger.info(`Downloading model to ${targetPath}`, { url });

  const headers: Record<string, string> = {};
  if (config.huggingfaceToken && url.includes("huggingface.co")) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ModelError(
      `Download failed: ${res.status} ${res.statusText}`,
      { url, status: res.status },
    );
  }

  if (!res.body) {
    throw new ModelError("Download response has no body", { url });
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(targetPath);
  await pipeline(nodeStream, fileStream);

  const info = await stat(targetPath);
  logger.info(`Download complete: ${resolvedFilename} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

  return targetPath;
}
