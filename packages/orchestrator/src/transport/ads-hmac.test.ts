import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ADS_CALLER_ID_HEADER,
  ADS_CALLER_SIGNATURE_HEADER,
  AdsHmacTransportConfigError,
  createAdsHmacTransport,
  type AdsHmacTransportOptions
} from "./ads-hmac";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetchMock(): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

function baseOptions(overrides: Partial<AdsHmacTransportOptions> = {}): AdsHmacTransportOptions {
  return {
    baseUrl: "https://ads.example.com",
    callerId: "meridian-roles",
    hmacKey: "service-secret",
    userId: "user-abc",
    ...overrides
  };
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const normalized = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === normalized) return value;
    }
    return undefined;
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function expectedSignature(key: string, bodyJson: string): string {
  return createHmac("sha256", key).update(Buffer.from(bodyJson, "utf8")).digest("hex");
}

describe("createAdsHmacTransport — config errors", () => {
  it("throws AdsHmacTransportConfigError when baseUrl is missing", () => {
    expect(() => createAdsHmacTransport(baseOptions({ baseUrl: "" }))).toThrow(AdsHmacTransportConfigError);
    expect(() => createAdsHmacTransport(baseOptions({ baseUrl: "" }))).toThrow(/baseUrl/);
  });

  it("throws AdsHmacTransportConfigError when callerId is missing", () => {
    expect(() => createAdsHmacTransport(baseOptions({ callerId: "" }))).toThrow(AdsHmacTransportConfigError);
    expect(() => createAdsHmacTransport(baseOptions({ callerId: "" }))).toThrow(/callerId/);
  });

  it("throws AdsHmacTransportConfigError when hmacKey is missing", () => {
    expect(() => createAdsHmacTransport(baseOptions({ hmacKey: "" }))).toThrow(AdsHmacTransportConfigError);
    expect(() => createAdsHmacTransport(baseOptions({ hmacKey: "" }))).toThrow(/hmacKey/);
  });

  it("throws AdsHmacTransportConfigError when userId is missing (trust-anchor invariant)", () => {
    expect(() => createAdsHmacTransport(baseOptions({ userId: "" }))).toThrow(AdsHmacTransportConfigError);
    expect(() => createAdsHmacTransport(baseOptions({ userId: "" }))).toThrow(/userId/);
  });
});

describe("createAdsHmacTransport — post()", () => {
  it("sends a signed POST with correct URL, body, and headers", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl }));

    const response = await transport.post("/api/mumu2/read-only-query", { query: "dna_template", id: "t-1" });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call.url).toBe("https://ads.example.com/api/mumu2/read-only-query");
    expect(call.init?.method).toBe("POST");

    const sentBody = JSON.parse(call.init?.body as string);
    expect(sentBody).toEqual({ query: "dna_template", id: "t-1", user_id: "user-abc" });

    expect(headerValue(call.init?.headers, "content-type")).toMatch(/application\/json/);
    expect(headerValue(call.init?.headers, ADS_CALLER_ID_HEADER)).toBe("meridian-roles");

    const sig = headerValue(call.init?.headers, ADS_CALLER_SIGNATURE_HEADER);
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(`sha256=${expectedSignature("service-secret", call.init?.body as string)}`);
  });

  it("overrides any caller-supplied user_id with the bound userId (privilege-escalation defense)", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl, userId: "bound-user" }));

    await transport.post("/api/mumu2/q", { user_id: "spoofed", other: "x" });

    const sentBody = JSON.parse(calls[0].init?.body as string);
    expect(sentBody.user_id).toBe("bound-user");
    expect(sentBody.other).toBe("x");
  });

  it("normalizes a trailing slash on baseUrl (no double-slash in fetched URL)", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl, baseUrl: "https://x/" }));

    await transport.post("/y", {});

    expect(calls[0].url).toBe("https://x/y");
  });

  it("normalizes multiple trailing slashes on baseUrl", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl, baseUrl: "https://x///" }));

    await transport.post("/y", {});

    expect(calls[0].url).toBe("https://x/y");
  });

  it("throws when path does not start with '/'", async () => {
    const { fetchImpl } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl }));

    await expect(transport.post("no-leading-slash", {})).rejects.toThrow(/path must start with '\/'/);
  });

  it("throws when body is an array", async () => {
    const { fetchImpl } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl }));

    await expect(transport.post("/x", [])).rejects.toThrow(/body must be a plain object/);
  });

  it("throws when body is a string", async () => {
    const { fetchImpl } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl }));

    await expect(transport.post("/x", "string")).rejects.toThrow(/body must be a plain object/);
  });

  it("treats a null body as { user_id }", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl, userId: "u-1" }));

    await transport.post("/x", null);

    expect(calls[0].init?.body).toBe('{"user_id":"u-1"}');
  });

  it("treats an undefined body as { user_id }", async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const transport = createAdsHmacTransport(baseOptions({ fetchImpl, userId: "u-2" }));

    await transport.post("/x", undefined);

    expect(calls[0].init?.body).toBe('{"user_id":"u-2"}');
  });
});

describe("createAdsHmacTransport — HMAC determinism", () => {
  it("produces identical signatures for the same key + body", async () => {
    const { fetchImpl: fetch1, calls: calls1 } = makeFetchMock();
    const { fetchImpl: fetch2, calls: calls2 } = makeFetchMock();

    const t1 = createAdsHmacTransport(baseOptions({ fetchImpl: fetch1 }));
    const t2 = createAdsHmacTransport(baseOptions({ fetchImpl: fetch2 }));

    await t1.post("/x", { a: 1, b: 2 });
    await t2.post("/x", { a: 1, b: 2 });

    expect(calls1[0].init?.body).toBe(calls2[0].init?.body);
    expect(headerValue(calls1[0].init?.headers, ADS_CALLER_SIGNATURE_HEADER)).toBe(
      headerValue(calls2[0].init?.headers, ADS_CALLER_SIGNATURE_HEADER)
    );
  });

  it("produces different signatures for different hmacKeys on the same body", async () => {
    const { fetchImpl: fetch1, calls: calls1 } = makeFetchMock();
    const { fetchImpl: fetch2, calls: calls2 } = makeFetchMock();

    const t1 = createAdsHmacTransport(baseOptions({ fetchImpl: fetch1, hmacKey: "key-one" }));
    const t2 = createAdsHmacTransport(baseOptions({ fetchImpl: fetch2, hmacKey: "key-two" }));

    await t1.post("/x", { a: 1 });
    await t2.post("/x", { a: 1 });

    expect(calls1[0].init?.body).toBe(calls2[0].init?.body);
    expect(headerValue(calls1[0].init?.headers, ADS_CALLER_SIGNATURE_HEADER)).not.toBe(
      headerValue(calls2[0].init?.headers, ADS_CALLER_SIGNATURE_HEADER)
    );
  });
});
