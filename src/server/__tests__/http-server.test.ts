import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapPublicAsset, selectPublicDir } from "../http-server";

describe("mapPublicAsset", () => {
  it("serves scheduler detail for scheduler ids opened through the generic role route", () => {
    expect(mapPublicAsset("/role/scheduler-bf02b39c")).toEqual({
      fileName: "scheduler.html",
      contentType: "text/html; charset=utf-8"
    });
  });

  it("keeps non-scheduler role ids on the generic role detail page", () => {
    expect(mapPublicAsset("/role/agent-dispatcher-752732c4")).toEqual({
      fileName: "role.html",
      contentType: "text/html; charset=utf-8"
    });
  });

  it("serves the system monitor page and script as top-level public assets", () => {
    expect(mapPublicAsset("/monitor")).toEqual({
      fileName: "monitor.html",
      contentType: "text/html; charset=utf-8"
    });
    expect(mapPublicAsset("/monitor.js")).toEqual({
      fileName: "monitor.js",
      contentType: "text/javascript; charset=utf-8"
    });
  });
});

describe("selectPublicDir", () => {
  it("falls back to source assets when a compiled public directory exists without static files", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-public-dir-"));
    const compiledPublicDir = path.join(root, "dist", "web", "public");
    const sourcePublicDir = path.join(root, "src", "web", "public");

    await fs.mkdir(compiledPublicDir, { recursive: true });
    await fs.mkdir(sourcePublicDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(sourcePublicDir, "index.html"), "", "utf8"),
      fs.writeFile(path.join(sourcePublicDir, "app.js"), "", "utf8"),
      fs.writeFile(path.join(sourcePublicDir, "style.css"), "", "utf8"),
      fs.writeFile(path.join(sourcePublicDir, "scheduler.html"), "", "utf8")
    ]);

    expect(selectPublicDir(compiledPublicDir, sourcePublicDir)).toBe(sourcePublicDir);

    await fs.rm(root, { recursive: true, force: true });
  });
});
