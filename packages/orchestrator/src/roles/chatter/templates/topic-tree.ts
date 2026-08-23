export const TOPIC_TREE_MANIFEST = {
  version: 1 as const,
  layers: "tree" as const,
  index: "none" as const,
  bindings: {
    conversation_log: "turns/<date>/turn-<turn_id>.md",
    topic_entry: "topics/<topic>/<slug>.md"
  }
};
