export const FLAT_LOG_MANIFEST = {
  version: 1 as const,
  layers: "flat" as const,
  index: "none" as const,
  bindings: {
    conversation_log: "turns/<date>/turn-<turn_id>.md"
  }
};
