export type ChatterPolicyErrorCode = "denied_mode" | "denied_skill";

export class ChatterPolicyError extends Error {
  constructor(public readonly code: ChatterPolicyErrorCode, message: string) {
    super(message);
    this.name = "ChatterPolicyError";
  }
}

const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "chatter.memory.read",
  "chatter.memory.write",
  "chatter.memory.list",
  "chatter.suggest_observation",
  "chatter.skill.dispatch_coding_job"
]);

const SKILL_PREFIX = "chatter.skill.";
const STRUCTURED_TOOLS: ReadonlySet<string> = new Set([
  "structured.upsert",
  "structured.get",
  "structured.query",
  "structured.delete",
  "structured.list"
]);

export function assertModeAllowed(
  mode: "stateless" | "session",
  allowedModes: ReadonlyArray<"stateless" | "session">
): void {
  if (!allowedModes.includes(mode)) {
    throw new ChatterPolicyError(
      "denied_mode",
      `mode '${mode}' not in allowed_modes [${allowedModes.join(", ")}]`
    );
  }
}

export function assertSkillAllowed(
  toolName: string,
  skillAllowlist: ReadonlyArray<string>
): void {
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return;
  if (STRUCTURED_TOOLS.has(toolName)) {
    if (skillAllowlist.includes(toolName)) return;
    throw new ChatterPolicyError(
      "denied_skill",
      `skill '${toolName}' not in allowlist [${skillAllowlist.join(", ")}]`
    );
  }
  if (!toolName.startsWith(SKILL_PREFIX)) {
    throw new ChatterPolicyError("denied_skill", `unknown tool '${toolName}'`);
  }
  const skill = toolName.slice(SKILL_PREFIX.length);
  if (skill === "" || !skillAllowlist.includes(skill)) {
    throw new ChatterPolicyError(
      "denied_skill",
      `skill '${skill}' not in allowlist [${skillAllowlist.join(", ")}]`
    );
  }
}
