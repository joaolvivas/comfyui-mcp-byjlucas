import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  createWorkflow,
  modifyWorkflow,
  TEMPLATE_NAMES,
  type ModifyOperation,
} from "../services/workflow-composer.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_input"),
    node_id: z.string(),
    input_name: z.string(),
    value: z.any(),
  }),
  z.object({
    op: z.literal("add_node"),
    class_type: z.string(),
    inputs: z.record(z.any()).optional(),
    id: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove_node"),
    node_id: z.string(),
  }),
  z.object({
    op: z.literal("connect"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
  }),
  z.object({
    op: z.literal("insert_between"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
    new_class_type: z.string(),
    new_inputs: z.record(z.any()).optional(),
  }),
]);

export function registerWorkflowComposeTools(server: McpServer): void {
  // 1. create_workflow
  server.tool(
    "create_workflow",
    `Create a ComfyUI workflow from a named template. Available templates: ${TEMPLATE_NAMES.join(", ")}. Returns the complete workflow JSON ready for execution or further modification.`,
    {
      template: z
        .enum(TEMPLATE_NAMES as [string, ...string[]])
        .describe("Template name: txt2img, img2img, upscale, or inpaint"),
      params: z
        .record(z.any())
        .optional()
        .default({})
        .describe(
          "Template parameters (e.g. checkpoint, positive_prompt, negative_prompt, width, height, steps, cfg, seed, sampler_name, scheduler, denoise, image_path, mask_path, upscale_model)",
        ),
    },
    async ({ template, params }) => {
      try {
        logger.info("Creating workflow", { template, params });
        const workflow = createWorkflow(template, params);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(workflow, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // 2. modify_workflow
  server.tool(
    "modify_workflow",
    "Apply modification operations to an existing ComfyUI workflow. Supports: set_input, add_node, remove_node, connect, insert_between. Returns the modified workflow JSON and IDs of any newly added nodes.",
    {
      workflow: z
        .union([z.string(), z.record(z.any())])
        .describe("ComfyUI workflow JSON (as a JSON string or object)"),
      operations: z
        .array(operationSchema)
        .describe(
          "Array of operations to apply in order. Each has an 'op' field: set_input, add_node, remove_node, connect, or insert_between",
        ),
    },
    async ({ workflow, operations }) => {
      try {
        logger.info("Modifying workflow", { opCount: operations.length });
        const parsed = parseWorkflow(workflow);
        const result = modifyWorkflow(parsed, operations as ModifyOperation[]);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workflow: result.workflow,
                  added_node_ids: result.added_ids,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // 3. get_node_info
  server.tool(
    "get_node_info",
    "Query ComfyUI's /object_info endpoint to get node type definitions. " +
      "Returns a structural summary by default (input/output type names, no dropdown values). " +
      "Pass verbose=true to get the FULL definition including model dropdowns — warning: this can " +
      "be 100s of KB per Loader node (UNETLoader, CheckpointLoaderSimple, LoraLoader etc. embed " +
      "the entire local model list).",
    {
      node_type: z
        .string()
        .optional()
        .describe(
          "Filter by node class_type name (case-insensitive substring match). Omit to list all available nodes.",
        ),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return full definition including model dropdown values. " +
            "Default false (returns structural summary only — safe for context). " +
            "Use verbose=true only when you specifically need to enumerate model names " +
            "for a single node, and prefer the /models/<category> REST endpoint instead.",
        ),
    },
    async ({ node_type, verbose }) => {
      try {
        logger.info("Getting node info", { filter: node_type, verbose });
        const info = await getObjectInfo();

        let entries = Object.entries(info);
        if (node_type) {
          const lower = node_type.toLowerCase();
          entries = entries.filter(([name]) => name.toLowerCase().includes(lower));
        }

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: node_type
                  ? `No nodes found matching "${node_type}"`
                  : "No node definitions returned from ComfyUI",
              },
            ],
          };
        }

        // VERBOSE: full JSON (may be huge — only for explicit single-node deep dives).
        if (verbose) {
          if (entries.length > 5) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `verbose=true matched ${entries.length} nodes — refusing to dump that much. ` +
                    `Narrow node_type to <=5 matches, or set verbose=false for a summary.`,
                },
              ],
            };
          }
          const result = Object.fromEntries(entries);
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          };
        }

        // Default: structural summary — names of inputs/outputs, no dropdown values.
        const summary = entries.map(([name, def]) => {
          const inputTypes = def.input?.required ?? {};
          const inputTypesOpt = def.input?.optional ?? {};
          const summariseInputs = (obj: Record<string, unknown>) =>
            Object.fromEntries(
              Object.entries(obj).map(([inputName, spec]) => {
                // spec is typically [typeOrEnum, options?] — we keep only the type tag,
                // dropping the enum value list which is what makes Loader nodes huge.
                if (Array.isArray(spec)) {
                  const first = spec[0];
                  if (Array.isArray(first)) {
                    return [inputName, `enum(${first.length} values)`];
                  }
                  return [inputName, String(first)];
                }
                return [inputName, typeof spec];
              }),
            );
          return {
            name,
            display_name: def.display_name,
            category: def.category,
            description: def.description || "",
            input_required: summariseInputs(inputTypes as Record<string, unknown>),
            input_optional: summariseInputs(inputTypesOpt as Record<string, unknown>),
            output_types: def.output ?? [],
            output_names: def.output_name ?? [],
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: summary.length,
                  nodes: summary,
                  hint:
                    entries.length === 1
                      ? "Pass verbose=true to get the full definition with model dropdown values for this single node."
                      : "Filter with node_type to narrow results. Pass verbose=true on a single node match for full dropdowns.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
