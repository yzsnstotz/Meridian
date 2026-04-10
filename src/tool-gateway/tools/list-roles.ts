import { z } from "zod";

import { buildServiceErrorData, requestRolesServiceJson } from "../service-client";
import type { ToolDefinition, ToolResult } from "../registry";

const RoleSummarySchema = z.object({
  thread_id: z.string().min(1),
  role_type: z.string().min(1),
  status: z.string().min(1),
  task_count: z.number().int().nonnegative()
});

const RolesPayloadSchema = z.union([
  RoleSummarySchema.array(),
  z.object({
    roles: RoleSummarySchema.array()
  })
]).transform((payload) => Array.isArray(payload) ? payload : payload.roles);

const listRolesTool: ToolDefinition = {
  name: "list-roles",
  description: "List configured Meridian roles by querying the local /api/roles endpoint",
  params: {},
  async execute(): Promise<ToolResult> {
    const response = await requestRolesServiceJson<unknown>("/api/roles");
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        data: buildServiceErrorData(response)
      };
    }

    const parsed = RolesPayloadSchema.safeParse(response.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Invalid response from Meridian-roles /api/roles",
        data: {
          base_url: response.base_url,
          status_code: response.status_code
        }
      };
    }

    return {
      ok: true,
      data: {
        roles: parsed.data,
        count: parsed.data.length
      }
    };
  }
};

export default listRolesTool;
