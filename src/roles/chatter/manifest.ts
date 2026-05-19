import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ChatterTemplateName } from "../../types";
import {
  FLAT_LOG_MANIFEST,
  TOPIC_TREE_MANIFEST,
  INDEXED_KB_MANIFEST
} from "./templates";

export const ChatterManifestSchema = z
  .object({
    version: z.literal(1),
    layers: z.enum(["flat", "tree"]),
    index: z.enum(["none", "json"]),
    bindings: z.record(z.string().min(1), z.string().min(1))
  })
  .strict();

export type ChatterManifest = z.infer<typeof ChatterManifestSchema>;

export function loadManifestFromTemplate(name: ChatterTemplateName): ChatterManifest {
  switch (name) {
    case "flat-log":
      return ChatterManifestSchema.parse(FLAT_LOG_MANIFEST);
    case "topic-tree":
      return ChatterManifestSchema.parse(TOPIC_TREE_MANIFEST);
    case "indexed-kb":
      return ChatterManifestSchema.parse(INDEXED_KB_MANIFEST);
  }
}

export function loadManifestFromFile(absPath: string): ChatterManifest {
  const raw = readFileSync(absPath, "utf8");
  const json = JSON.parse(raw);
  return ChatterManifestSchema.parse(json);
}
