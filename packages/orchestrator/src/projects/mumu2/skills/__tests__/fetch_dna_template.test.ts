import { describe, test, expect } from "vitest";
import { fetchDnaTemplate, FetchDnaTemplateInputSchema } from "../fetch_dna_template";

describe("fetch_dna_template", () => {
  test("input schema requires id", () => {
    const r = FetchDnaTemplateInputSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  test("input schema rejects empty id", () => {
    const r = FetchDnaTemplateInputSchema.safeParse({ id: "" });
    expect(r.success).toBe(false);
  });

  test("calls ADS read-only-query with kind=dna_template", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const transport = {
      post: async (url: string, body: unknown) => {
        calls.push({ url, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "dna_template",
            id: "dna1",
            content: { id: "dna1", name: "x", beats: [] }
          })
        };
      }
    };
    const result = await fetchDnaTemplate({ id: "dna1" }, { transport });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/mumu2/read-only-query");
    expect(calls[0].body).toEqual({ kind: "dna_template", id: "dna1" });
    expect((result as { name: string }).name).toBe("x");
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
      fetchDnaTemplate({ id: "missing" }, { transport })
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("throws on malformed ADS response missing content field", async () => {
    const transport = {
      post: async () => ({
        ok: true,
        status: 200,
        // no content field
        json: async () => ({ kind: "dna_template", id: "x" })
      })
    };
    await expect(
      fetchDnaTemplate({ id: "x" }, { transport })
    ).rejects.toThrow(/MALFORMED_RESPONSE/);
  });
});
