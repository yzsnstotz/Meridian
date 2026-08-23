import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanupStagedAttachments, stageInlineAttachments, transformAttachments } from "./attachment-transform";

test("transformAttachments extracts text attachments from disk", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-attachment-transform-"));
  const filePath = path.join(tempDir, "notes.txt");

  try {
    await fs.promises.writeFile(filePath, "investigation notes", "utf8");
    const result = await transformAttachments(
      [{ path: filePath, filename: "notes.txt", mime_type: "text/plain" }],
      "codex"
    );

    assert.deepEqual(result.cleanupPaths, []);
    assert.equal(result.transformed.length, 1);
    assert.equal(result.transformed[0]?.kind, "text");
    assert.equal(result.transformed[0]?.content, "investigation notes");
    assert.deepEqual(result.rejected, []);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test("transformAttachments rejects image attachments for non-Claude agents", async () => {
  const result = await transformAttachments(
    [{ filename: "diagram.png", mime_type: "image/png", content_base64: Buffer.from("png").toString("base64") }],
    "codex"
  );

  assert.deepEqual(result.transformed, []);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.reason, "unsupported_capability");
});

test("stageInlineAttachments stages inline uploads and cleanup removes them", async () => {
  const staged = await stageInlineAttachments([
    {
      filename: "evidence.txt",
      mime_type: "text/plain",
      content_base64: Buffer.from("evidence payload", "utf8").toString("base64")
    }
  ]);

  const stagedPath = staged.attachments[0]?.path;
  assert.ok(stagedPath);
  assert.equal(await fs.promises.readFile(stagedPath as string, "utf8"), "evidence payload");
  assert.equal(staged.cleanupPaths.length, 1);

  await cleanupStagedAttachments(staged.cleanupPaths);
  assert.equal(fs.existsSync(stagedPath as string), false);
});
