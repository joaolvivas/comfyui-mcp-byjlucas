import { RegistryError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const REGISTRY_BASE = "https://api.comfy.org";

export interface RegistrySearchResult {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  latest_version: string;
  total_install: number;
  tags?: string[];
}

export interface NodePackDetails extends RegistrySearchResult {
  versions: Array<{ version: string; changelog?: string }>;
  nodes: string[];
  license?: string;
  created_at: string;
  updated_at: string;
}

export interface SearchNodesOptions {
  page?: number;
  limit?: number;
  tags?: string[];
}

async function registryFetch<T>(path: string): Promise<T> {
  const url = `${REGISTRY_BASE}${path}`;
  logger.debug("Registry API request", { url });

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RegistryError(
      `Registry API ${res.status}: ${res.statusText}`,
      { url, status: res.status, body },
    );
  }
  return res.json() as Promise<T>;
}

export async function searchNodes(
  query: string,
  options: SearchNodesOptions = {},
): Promise<RegistrySearchResult[]> {
  const { page = 1, limit = 10 } = options;

  // ── Upstream bug workaround: the Registry API at api.comfy.org/nodes accepts
  //    a `search` query parameter but ignores it, always returning the same
  //    paginated default list. Confirmed 2026-05-12.
  //    Fix: fetch a larger window and filter client-side by query against the
  //    id / name / description / author fields. Rank by total_install desc so
  //    canonical packs (cubiq's PuLID, kijai's WanVideoWrapper, etc.) win over
  //    obscure packs with the same substring.
  const fetchLimit = 100;
  const lowerQuery = query.trim().toLowerCase();

  const params = new URLSearchParams({
    page: "1",
    limit: String(fetchLimit),
  });
  // Still pass the param in case upstream fixes the filter eventually.
  if (lowerQuery) params.set("search", query);

  const data = await registryFetch<{ nodes?: RegistrySearchResult[] }>(
    `/nodes?${params}`,
  );
  const allNodes = Array.isArray(data) ? data : (data.nodes ?? []);

  // Client-side filter
  const matchScore = (n: RegistrySearchResult): number => {
    if (!lowerQuery) return 0;
    const id = (n.id ?? "").toLowerCase();
    const name = (n.name ?? "").toLowerCase();
    const desc = (n.description ?? "").toLowerCase();
    const author = (n.author ?? "").toLowerCase();
    let score = 0;
    if (id === lowerQuery) score += 1000;
    if (id.includes(lowerQuery)) score += 500;
    if (name.toLowerCase() === lowerQuery) score += 800;
    if (name.includes(lowerQuery)) score += 300;
    if (author.includes(lowerQuery)) score += 200;
    if (desc.includes(lowerQuery)) score += 100;
    // Boost by install popularity (log-scaled to avoid swamping query match).
    if (typeof n.total_install === "number" && n.total_install > 0) {
      score += Math.min(50, Math.floor(Math.log10(n.total_install + 1) * 10));
    }
    return score;
  };

  let filtered: RegistrySearchResult[];
  let matchedExact = false;
  if (lowerQuery) {
    const scored = allNodes
      .map((n) => ({ node: n, score: matchScore(n) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ node }) => node);
    if (scored.length > 0) {
      filtered = scored;
      matchedExact = true;
    } else {
      // Nothing matched in the first 100 nodes. The Comfy Registry is incomplete
      // (many canonical packs like cubiq/PuLID_ComfyUI, kijai/ComfyUI-WanVideoWrapper
      // exist on GitHub but were never published to api.comfy.org). Fall back to
      // returning the first page so the caller at least sees what the Registry
      // *does* know about. Tag the response with a synthetic marker so the tool
      // layer can prepend an explanatory note.
      filtered = allNodes;
      matchedExact = false;
    }
  } else {
    filtered = allNodes;
    matchedExact = true;
  }

  const start = (page - 1) * limit;
  const paged = filtered.slice(start, start + limit);
  logger.info(
    `Registry search "${query}": fetched ${allNodes.length}, matched ${matchedExact ? paged.length : 0}, returning ${paged.length} (page ${page}, limit ${limit}, matchedExact=${matchedExact})`,
  );
  // Stamp the "no match, returning default browse" signal onto the array.
  // Using a non-enumerable property so JSON serialization is unaffected.
  if (!matchedExact && lowerQuery) {
    Object.defineProperty(paged, "_unmatchedFallback", {
      value: true,
      enumerable: false,
    });
  }
  return paged;
}

export async function getNodePackDetails(
  id: string,
): Promise<NodePackDetails> {
  const data = await registryFetch<NodePackDetails>(`/nodes/${encodeURIComponent(id)}`);
  logger.info(`Fetched details for node pack "${id}"`);
  return data;
}
