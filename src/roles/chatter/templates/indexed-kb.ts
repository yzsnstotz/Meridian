export const INDEXED_KB_MANIFEST = {
  version: 1 as const,
  layers: "tree" as const,
  index: "json" as const,
  bindings: {
    conversation_log: "turns/<date>/turn-<turn_id>.md",
    kb_entry: "kb/<topic>/<slug>.md"
  }
};
