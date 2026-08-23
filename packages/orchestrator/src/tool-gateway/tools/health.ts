import { z } from "zod";

import { buildServiceErrorData, requestRolesServiceJson } from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const HealthPayloadSchema = z.object({
  ok: z.literal(true),
  version: z.string().min(1),
  uptime: z.number().nonnegative(),
  agents_count: z.number().int().nonnegative().optional(),
  roles_count: z.number().int().nonnegative().optional()
}).transform((payload) => {
  const count = payload.roles_count ?? payload.agents_count ?? 0;

  return {
    ok: true as const,
    version: payload.version,
    uptime: payload.uptime,
    agents_count: payload.agents_count ?? count,
    roles_count: payload.roles_count ?? count
  };
});

const healthTool: ToolDefinition = {
  name: "health",
  description: "Check Meridian-roles service health via the local /api/health endpoint",
  params: {},
  async execute(): Promise<ToolResult> {
    const response = await requestRolesServiceJson<unknown>("/api/health");
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        data: buildServiceErrorData(response)
      };
    }

    const parsed = HealthPayloadSchema.safeParse(response.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Invalid response from Meridian-roles /api/health",
        data: {
          base_url: response.base_url,
          status_code: response.status_code
        }
      };
    }

    return {
      ok: true,
      data: parsed.data
    };
  }
};

export default healthTool;
