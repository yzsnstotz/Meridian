import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverExistingRolesStatePaths,
  importRolesState
} from "./roles-state";

const roots: string[] = [];
const state = {
  roles: [],
  promptStore: {}
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Roles state migration", () => {
  it("discovers explicit and platform-relative legacy files without guessing a user name", () => {
    const root = makeRoot();
    const explicit = path.join(root, "custom-state.json");
    const xdgLegacy = path.join(root, ".local", "state", "meridian-roles", "state.json");
    fs.mkdirSync(path.dirname(xdgLegacy), { recursive: true });
    fs.writeFileSync(explicit, JSON.stringify(state));
    fs.writeFileSync(xdgLegacy, JSON.stringify(state));

    expect(discoverExistingRolesStatePaths({
      env: { STATE_FILE_PATH: explicit },
      homeDir: root,
      platform: "linux"
    })).toEqual([explicit, xdgLegacy]);
  });

  it("imports atomically, preserves the source, and is idempotent", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "legacy", "state.json");
    const targetPath = path.join(root, "new", "orchestrator-state.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, `${JSON.stringify(state, null, 2)}\n`);
    const sourceBefore = fs.readFileSync(sourcePath);

    expect(importRolesState({ sourcePath, targetPath })).toMatchObject({
      status: "imported",
      roles: 0,
      sourcePreserved: true
    });
    expect(importRolesState({ sourcePath, targetPath })).toMatchObject({
      status: "already_imported",
      sourcePreserved: true
    });
    expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it("dry-run writes nothing and conflicting target content is quarantined by refusal", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source.json");
    const targetPath = path.join(root, "target.json");
    fs.writeFileSync(sourcePath, JSON.stringify(state));

    expect(importRolesState({ sourcePath, targetPath, dryRun: true }).status).toBe("planned");
    expect(fs.existsSync(targetPath)).toBe(false);

    fs.writeFileSync(targetPath, JSON.stringify({
      roles: [],
      promptStore: {
        different: {
          system_prompt: "value",
          task_templates: {}
        }
      }
    }));
    expect(() => importRolesState({ sourcePath, targetPath })).toThrow(
      /refusing to overwrite/
    );
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-roles-migration-"));
  roots.push(root);
  return root;
}
