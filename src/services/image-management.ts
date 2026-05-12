import { readFile, copyFile, readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { config } from "../config.js";
import { ValidationError, ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getHistory } from "../comfyui/client.js";

function getInputDir(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return join(config.comfyuiPath, "input");
}

function getOutputDir(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return join(config.comfyuiPath, "output");
}

/**
 * Copy a local image file into ComfyUI's input/ directory so it can be
 * referenced by LoadImage nodes in workflows.
 */
export async function uploadImage(
  sourcePath: string,
  filename?: string,
): Promise<{ filename: string; path: string }> {
  const inputDir = getInputDir();
  const resolvedFilename = filename ?? basename(sourcePath);

  // Validate extension
  const ext = extname(resolvedFilename).toLowerCase();
  const allowed = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif"];
  if (!allowed.includes(ext)) {
    throw new ValidationError(
      `Unsupported image format "${ext}". Supported: ${allowed.join(", ")}`,
    );
  }

  const targetPath = join(inputDir, resolvedFilename);
  logger.info("Uploading image to ComfyUI input", { sourcePath, targetPath });

  try {
    await copyFile(sourcePath, targetPath);
  } catch (err) {
    throw new ValidationError(
      `Failed to copy image: ${err instanceof Error ? err.message : err}`,
    );
  }

  return { filename: resolvedFilename, path: targetPath };
}

/**
 * Extract embedded workflow JSON from a ComfyUI-generated PNG file.
 *
 * Accepts:
 *   - bare filename ("MyOutput_00001_.png") → fetched via ComfyUI /view
 *   - remote/server-side absolute path ("/workspace/.../output/foo.png") → filename
 *     extracted and fetched via /view (works with remote ComfyUI on RunPod)
 *   - local-Mac absolute path → read directly from filesystem
 */
export async function extractWorkflowFromImage(
  imagePath: string,
): Promise<{ prompt?: Record<string, unknown>; workflow?: Record<string, unknown> }> {
  const ext = extname(imagePath).toLowerCase();
  if (ext !== ".png") {
    throw new ValidationError(
      "Workflow extraction only works with PNG files. ComfyUI embeds metadata in PNG tEXt chunks.",
    );
  }

  const looksRemote =
    imagePath.startsWith("/workspace/") ||
    imagePath.startsWith("/runpod/") ||
    imagePath.includes("/output/") ||
    imagePath.includes("/input/") ||
    imagePath.includes("/temp/") ||
    !imagePath.startsWith("/"); // bare filename

  let buffer: Buffer | null = null;
  let remoteErr: unknown;
  let localErr: unknown;

  if (looksRemote) {
    try {
      buffer = await fetchPngViaView(imagePath);
    } catch (err) {
      remoteErr = err;
      logger.debug("Remote /view fetch failed, will try local read", { imagePath, err });
    }
  }

  if (!buffer) {
    try {
      buffer = await readFile(imagePath);
    } catch (err) {
      localErr = err;
      if (!looksRemote) {
        // Path didn't look remote but local read failed — try remote anyway
        try {
          buffer = await fetchPngViaView(imagePath);
        } catch (err2) {
          remoteErr = err2;
        }
      }
    }
  }

  if (!buffer) {
    throw new ValidationError(
      `Could not read PNG at "${imagePath}". ` +
        `Remote (/view) error: ${remoteErr instanceof Error ? remoteErr.message : remoteErr ?? "n/a"}. ` +
        `Local (fs) error: ${localErr instanceof Error ? localErr.message : localErr ?? "n/a"}.`,
    );
  }

  return parseWorkflowFromBuffer(buffer);
}

async function fetchPngViaView(imagePath: string): Promise<Buffer> {
  const filename = basename(imagePath);
  const candidates: Array<"output" | "input" | "temp"> = ["output"];
  if (imagePath.includes("/input/")) candidates.unshift("input");
  if (imagePath.includes("/temp/")) candidates.unshift("temp");
  if (!candidates.includes("input")) candidates.push("input");
  if (!candidates.includes("temp")) candidates.push("temp");

  let lastErr: unknown;
  for (const type of candidates) {
    try {
      const { base64 } = await fetchImage(filename, type, "");
      return Buffer.from(base64, "base64");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not fetch "${filename}" from any ComfyUI dir (output/input/temp). Last: ${
      lastErr instanceof Error ? lastErr.message : lastErr
    }`,
  );
}

function parseWorkflowFromBuffer(
  buffer: Buffer,
): { prompt?: Record<string, unknown>; workflow?: Record<string, unknown> } {
  const result: { prompt?: Record<string, unknown>; workflow?: Record<string, unknown> } = {};
  const chunks = parsePngTextChunks(buffer);
  for (const { keyword, text } of chunks) {
    if (keyword === "prompt") {
      try { result.prompt = JSON.parse(text); }
      catch { logger.warn("Failed to parse 'prompt' PNG metadata as JSON"); }
    } else if (keyword === "workflow") {
      try { result.workflow = JSON.parse(text); }
      catch { logger.warn("Failed to parse 'workflow' PNG metadata as JSON"); }
    }
  }
  if (!result.prompt && !result.workflow) {
    throw new ValidationError(
      "No ComfyUI workflow metadata found in this PNG. The image may not have been generated by ComfyUI, or metadata embedding may have been disabled.",
    );
  }
  return result;
}

interface PngTextChunk {
  keyword: string;
  text: string;
}

/**
 * Low-level PNG tEXt/iTXt chunk parser.
 * PNG format: 8-byte signature, then chunks of [4-byte length][4-byte type][data][4-byte CRC].
 */
function parsePngTextChunks(buffer: Buffer): PngTextChunk[] {
  const results: PngTextChunk[] = [];

  // Verify PNG signature
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new ValidationError("Not a valid PNG file");
  }

  let offset = 8; // Skip signature

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd > buffer.length) break;

    if (chunkType === "tEXt") {
      // tEXt: keyword\0text
      const data = buffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx >= 0) {
        const keyword = data.subarray(0, nullIdx).toString("latin1");
        const text = data.subarray(nullIdx + 1).toString("latin1");
        results.push({ keyword, text });
      }
    } else if (chunkType === "iTXt") {
      // iTXt: keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text
      const data = buffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx >= 0) {
        const keyword = data.subarray(0, nullIdx).toString("utf-8");
        const compressionFlag = data[nullIdx + 1];
        // Skip compression method (1 byte), language tag, translated keyword
        let textStart = nullIdx + 3; // past null, compressionFlag, compressionMethod
        // Skip language tag (null-terminated)
        const langEnd = data.indexOf(0, textStart);
        if (langEnd >= 0) {
          textStart = langEnd + 1;
          // Skip translated keyword (null-terminated)
          const transEnd = data.indexOf(0, textStart);
          if (transEnd >= 0) {
            textStart = transEnd + 1;
          }
        }
        const textData = data.subarray(textStart);
        if (compressionFlag === 0) {
          results.push({ keyword, text: textData.toString("utf-8") });
        }
        // We skip compressed iTXt chunks — ComfyUI typically uses uncompressed
      }
    }

    if (chunkType === "IEND") break;

    // Next chunk: length(4) + type(4) + data(chunkLength) + CRC(4)
    offset = dataEnd + 4;
  }

  return results;
}

export interface OutputImage {
  filename: string;
  path: string;
  size: number;
  modified: string;
}

/**
 * List images recently produced by ComfyUI.
 *
 * Path 1 (preferred): HTTP /history aggregation. Reflects what ComfyUI actually
 *   produced in this session. Works with remote ComfyUI (RunPod/Cloud).
 * Path 2 (fallback): filesystem readdir of COMFYUI_PATH/output. Only useful
 *   when MCP shares filesystem with ComfyUI.
 */
export async function listOutputImages(options?: {
  limit?: number;
  pattern?: string;
}): Promise<OutputImage[]> {
  const limit = options?.limit ?? 20;
  const pattern = options?.pattern?.toLowerCase();
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const images: OutputImage[] = [];
  const seen = new Set<string>();

  // Path 1: /history aggregation
  try {
    const history = await getHistory();
    for (const entry of Object.values(history)) {
      const outputs = (entry.outputs ?? {}) as Record<string, unknown>;
      for (const nodeOut of Object.values(outputs)) {
        const imgsField = (nodeOut as Record<string, unknown>).images;
        if (!Array.isArray(imgsField)) continue;
        for (const img of imgsField) {
          if (!img || typeof img !== "object") continue;
          const filename = (img as Record<string, unknown>).filename;
          const type = (img as Record<string, unknown>).type;
          if (typeof filename !== "string") continue;
          if (type !== undefined && type !== "output") continue;
          if (seen.has(filename)) continue;
          seen.add(filename);
          if (pattern && !filename.toLowerCase().includes(pattern)) continue;
          const ext = extname(filename).toLowerCase();
          if (!imageExts.has(ext)) continue;
          images.push({ filename, path: filename, size: 0, modified: "" });
        }
      }
    }
  } catch (err) {
    logger.debug("HTTP /history listing failed, will try filesystem", { err });
  }

  // Path 2: filesystem scan
  if (config.comfyuiPath) {
    const outputDir = join(config.comfyuiPath, "output");
    let entries: string[] = [];
    try {
      entries = await readdir(outputDir);
    } catch {}
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (!imageExts.has(ext)) continue;
      if (pattern && !entry.toLowerCase().includes(pattern)) continue;
      const fsPath = join(outputDir, entry);
      try {
        const info = await stat(fsPath);
        if (!info.isFile()) continue;
        if (seen.has(entry)) {
          // Backfill size/mtime onto existing /history entry
          const existing = images.find((i) => i.filename === entry);
          if (existing) {
            existing.size = info.size;
            existing.modified = info.mtime.toISOString();
            existing.path = fsPath;
          }
        } else {
          seen.add(entry);
          images.push({
            filename: entry,
            path: fsPath,
            size: info.size,
            modified: info.mtime.toISOString(),
          });
        }
      } catch {}
    }
  }

  // Sort: real mtimes first (newest), then /history-only entries preserving order
  images.sort((a, b) => {
    if (a.modified && b.modified) return b.modified.localeCompare(a.modified);
    if (a.modified) return -1;
    if (b.modified) return 1;
    return 0;
  });

  return images.slice(0, limit);
}

import { fetchImage, uploadImageHttp } from "../comfyui/client.js";
import { readFile as nodeReadFile } from "node:fs/promises";

/**
 * Fetch a generated image from ComfyUI via HTTP /view endpoint.
 * Does NOT require COMFYUI_PATH — works with remote ComfyUI instances.
 */
export async function getOutputImage(
  filename: string,
  type: "output" | "input" | "temp" = "output",
  subfolder = "",
): Promise<{ base64: string; mimeType: string; filename: string }> {
  const result = await fetchImage(filename, type, subfolder);
  return { ...result, filename };
}

/**
 * Upload a local image to ComfyUI via HTTP multipart POST.
 * Falls back to HTTP when COMFYUI_PATH is not available (remote ComfyUI).
 */
export async function uploadImageAuto(
  sourcePath: string,
  filename?: string,
): Promise<{ filename: string }> {
  const resolvedFilename = filename ?? basename(sourcePath);
  const ext = extname(resolvedFilename).toLowerCase();
  const allowed = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif"];
  if (!allowed.includes(ext)) {
    throw new ValidationError(
      `Unsupported image format "${ext}". Supported: ${allowed.join(", ")}`,
    );
  }
  const data = await nodeReadFile(sourcePath);
  const mimeMap: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif",
    ".tiff": "image/tiff", ".tif": "image/tiff",
  };
  const mimeType = mimeMap[ext] ?? "application/octet-stream";
  logger.info("Uploading image to ComfyUI via HTTP", { sourcePath, resolvedFilename });
  const result = await uploadImageHttp(resolvedFilename, data, mimeType);
  return { filename: result.name };
}
