import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, getSystemStats, getQueue } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";
import { MODEL_SUBDIRS } from "../services/model-resolver.js";

/**
 * Health check: a single call that aggregates the diagnostic signals an
 * operator needs before dispatching a batch:
 *   1. ComfyUI reachable + version
 *   2. GPU + VRAM available
 *   3. Queue depth (any contention?)
 *   4. Critical model categories populated (no "empty dropdowns" surprises)
 *   5. Any custom-node tracebacks in recent logs
 *
 * Designed for Lucas's remote-pod setup (RunPod via Cloudflare tunnel or
 * SSH). Returns a concise multi-line report rather than raw JSON, so it
 * fits in Hermes's per-job report.md easily.
 */
export function registerHealthCheckTools(server: McpServer): void {
  server.tool(
    "health_check",
    "Aggregate pre-flight diagnostic. Returns a single text report covering: " +
      "ComfyUI version + reachability, GPU/VRAM state, queue depth, model " +
      "category populations (critical for catching extra_model_paths.yaml " +
      "misconfig), and recent custom-node errors. Call before each batch " +
      "to catch infra problems before burning GPU time.",
    {},
    async () => {
      const lines: string[] = [];
      lines.push("## Health Check\n");

      // 1. System stats
      try {
        const stats = (await getSystemStats()) as unknown as Record<string, any>;
        const sys = stats.system ?? {};
        const dev = stats.devices?.[0] ?? {};
        const vramTotalGB = dev.vram_total ? (dev.vram_total / 1024 ** 3).toFixed(1) : "?";
        const vramFreeGB = dev.vram_free ? (dev.vram_free / 1024 ** 3).toFixed(1) : "?";
        const ramFreeGB = sys.ram_free ? (sys.ram_free / 1024 ** 3).toFixed(1) : "?";
        lines.push(
          `**ComfyUI**: ${sys.comfyui_version ?? "?"} | ` +
            `Python ${(sys.python_version ?? "").split(" ")[0] || "?"} | ` +
            `PyTorch ${sys.pytorch_version ?? "?"}`,
        );
        lines.push(
          `**GPU**: ${dev.name ?? "?"} | VRAM free ${vramFreeGB}/${vramTotalGB} GB | RAM free ${ramFreeGB} GB`,
        );
      } catch (err) {
        return errorToToolResult(
          new Error(
            `ComfyUI unreachable: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }

      // 2. Queue
      try {
        const q = await getQueue();
        const running = q.queue_running?.length ?? 0;
        const pending = q.queue_pending?.length ?? 0;
        lines.push(`**Queue**: ${running} running, ${pending} pending`);
      } catch (err) {
        lines.push(
          `**Queue**: ERROR — ${err instanceof Error ? err.message : err}`,
        );
      }

      // 3. Model category populations (via REST /models/<cat>)
      const client = getClient();
      const criticalCats = [
        "checkpoints",
        "diffusion_models",
        "loras",
        "vae",
        "text_encoders",
        "controlnet",
      ];
      const modelLines: string[] = [];
      let totalModelsSeen = 0;
      for (const cat of criticalCats) {
        try {
          const res = await client.fetchApi(`/models/${cat}`);
          if (!res.ok) {
            modelLines.push(`- ${cat}: REST ${res.status}`);
            continue;
          }
          const files = (await res.json()) as unknown;
          const count = Array.isArray(files) ? files.length : 0;
          totalModelsSeen += count;
          if (count === 0) {
            modelLines.push(`- ${cat}: **EMPTY** ⚠️ (check extra_model_paths.yaml)`);
          } else {
            // Show first 3 model names as sanity check
            const preview = (files as string[]).slice(0, 3).join(", ");
            const more = count > 3 ? ` (+${count - 3} more)` : "";
            modelLines.push(`- ${cat}: ${count} — ${preview}${more}`);
          }
        } catch (err) {
          modelLines.push(
            `- ${cat}: ERROR ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      lines.push(`**Models** (${totalModelsSeen} total in critical categories):`);
      lines.push(...modelLines);

      // 4. Recent custom-node errors in logs
      try {
        const res = await client.fetchApi("/internal/logs");
        const text = await res.text();
        const parsed = (() => {
          try {
            const j = JSON.parse(text);
            return typeof j === "string" ? j : text;
          } catch {
            return text;
          }
        })();
        const recentLines = parsed.split("\n").slice(-200);
        const errorLines = recentLines.filter(
          (l) => l.includes("ERROR") || l.includes("Traceback"),
        );
        if (errorLines.length === 0) {
          lines.push(`**Recent log errors**: none in last 200 lines ✅`);
        } else {
          const sample = errorLines.slice(-5).map((l) => `  ${l.trim()}`).join("\n");
          lines.push(
            `**Recent log errors**: ${errorLines.length} in last 200 lines ⚠️\n${sample}`,
          );
        }
      } catch (err) {
        lines.push(
          `**Logs**: unreachable — ${err instanceof Error ? err.message : err}`,
        );
      }

      // 5. Summary verdict
      const allCatsPopulated = !modelLines.some((l) => l.includes("EMPTY"));
      const verdict = allCatsPopulated ? "✅ READY" : "⚠️ DEGRADED";
      lines.push(`\n**Verdict**: ${verdict}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
