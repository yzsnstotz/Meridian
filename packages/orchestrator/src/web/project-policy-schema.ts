import { z } from "zod";

import { ReplyChannelSchema } from "../types";

export const ProjectPolicyModeSchema = z.enum(["session", "stateless"]);
export type ProjectPolicyMode = z.infer<typeof ProjectPolicyModeSchema>;

export const SeedsInitSchema = z
  .object({
    mode: z.enum(["none", "copy_on_provision"]),
    source_path: z.string().min(1).optional()
  })
  .strict();
export type SeedsInit = z.infer<typeof SeedsInitSchema>;

export const ProjectPolicySchema = z
  .object({
    project_id: z.string().min(1),
    thread_id_pattern: z.string().min(1),
    memory_folder_pattern: z.string().min(1),
    manifest_path: z.string().min(1),
    seeds_source_path: z.string().min(1).optional(),
    allowed_modes: z.array(ProjectPolicyModeSchema).min(1),
    skill_allowlist: z.array(z.string().min(1)),
    llm_agent_kind: z.string().min(1),
    credential_id: z.string().min(1).nullable(),
    user_reply_channel_template: ReplyChannelSchema,
    seeds_init: SeedsInitSchema
  })
  .strict();

export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

export interface InterpolatedProjectPolicy extends ProjectPolicy {
  thread_id: string;
  memory_folder: string;
  user_reply_channel: ProjectPolicy["user_reply_channel_template"];
}
