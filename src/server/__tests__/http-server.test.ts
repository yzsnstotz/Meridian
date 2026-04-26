import { describe, expect, it } from "vitest";

import { mapPublicAsset } from "../http-server";

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
});
