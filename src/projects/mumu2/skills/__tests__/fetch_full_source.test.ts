import { describe, test, expect } from "vitest";
import { fetchFullSource, FetchFullSourceInputSchema } from "../fetch_full_source";

describe("fetch_full_source", () => {
  test("input schema requires id", () => {
    const r = FetchFullSourceInputSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  test("input schema rejects empty id", () => {
    const r = FetchFullSourceInputSchema.safeParse({ id: "" });
    expect(r.success).toBe(false);
  });

  test("input schema rejects unknown extra fields (strict)", () => {
    const r = FetchFullSourceInputSchema.safeParse({ id: "s1", extra: 1 });
    expect(r.success).toBe(false);
  });

  test("calls ADS read-only-query with kind=source", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const transport = {
      post: async (url: string, body: unknown) => {
        calls.push({ url, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "source",
            id: "s1",
            content: { id: "s1", title: "参考稿", text: "全文……", created_at: "2026-05-01" }
          })
        };
      }
    };
    const result = await fetchFullSource({ id: "s1" }, { transport });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/mumu2/read-only-query");
    expect(calls[0].body).toEqual({ kind: "source", id: "s1" });
    expect((result as { title: string }).title).toBe("参考稿");
    expect((result as { text: string }).text).toBe("全文……");
  });

  test("throws on 404 from ADS", async () => {
    const transport = {
      post: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "NOT_FOUND" })
      })
    };
    await expect(
      fetchFullSource({ id: "missing" }, { transport })
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("throws on 403 from ADS (cross-user lookup)", async () => {
    const transport = {
      post: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: "FORBIDDEN" })
      })
    };
    await expect(
      fetchFullSource({ id: "other" }, { transport })
    ).rejects.toThrow(/FORBIDDEN/);
  });

  test("throws on malformed ADS response missing content field", async () => {
    const transport = {
      post: async () => ({
        ok: true,
        status: 200,
        // no content field
        json: async () => ({ kind: "source", id: "x" })
      })
    };
    await expect(
      fetchFullSource({ id: "x" }, { transport })
    ).rejects.toThrow(/MALFORMED_RESPONSE/);
  });

  test("falls back to HTTP_<status> when error body is unreadable", async () => {
    const transport = {
      post: async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("body not json");
        }
      })
    };
    await expect(
      fetchFullSource({ id: "x" }, { transport })
    ).rejects.toThrow(/HTTP_500/);
  });
});
