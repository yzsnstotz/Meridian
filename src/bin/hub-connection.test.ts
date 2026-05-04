import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  clearCallerIdentity,
  connectToHub,
  hubHttpRequest,
  setCallerIdentity
} from "./hub-connection";

interface TestIdentity {
  caller_id: string;
  caller_key: string;
  caller_label: string;
  caller_version?: string;
}

const TEST_IDENTITY: TestIdentity = {
  caller_id: "meridian-cli",
  caller_key: "test-cli-key",
  caller_label: "Meridian CLI"
};

function withCallerIdentity<T>(callback: () => Promise<T>, identity: TestIdentity = TEST_IDENTITY): Promise<T> {
  setCallerIdentity({ ...identity });
  return callback().finally(() => {
    clearCallerIdentity();
  });
}

async function withHttpServer(
  listener: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>,
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  let handlerError: unknown = null;
  const server = http.createServer((request, response) => {
    void Promise.resolve(listener(request, response)).catch((error) => {
      handlerError = error;
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await callback(`http://127.0.0.1:${address.port}`);
    if (handlerError) {
      throw handlerError;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function reserveClosedBaseUrl(): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return baseUrl;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

async function withEnv(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>
): Promise<void> {
  const original = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    original.set(key, process.env[key]);
    const nextValue = values[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("hubHttpRequest sends bearer auth from WEB_GUI_TOKEN and parses JSON", { concurrency: false }, async () => {
  await withHttpServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/run");
    assert.equal(request.headers.authorization, "Bearer secret-token");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(await readRequestBody(request), JSON.stringify({ content: "ship it" }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, trace: "abc" }));
  }, async (baseUrl) => {
    await withEnv(
      {
        MERIDIAN_HTTP: baseUrl,
        WEB_GUI_TOKEN: "secret-token"
      },
      async () => {
        await withCallerIdentity(async () => {
          const response = await hubHttpRequest("POST", "/api/run", { content: "ship it" });
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.body, { ok: true, trace: "abc" });
        });
      }
    );
  });
});

test("hubHttpRequest injects X-Meridian-Caller-Id and X-Meridian-Caller-Key headers", { concurrency: false }, async () => {
  await withHttpServer(async (request, response) => {
    assert.equal(request.headers["x-meridian-caller-id"], "meridian-cli");
    assert.equal(request.headers["x-meridian-caller-key"], "test-cli-key");
    assert.equal(request.headers["x-meridian-caller-version"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withEnv(
      {
        MERIDIAN_HTTP: baseUrl,
        WEB_GUI_TOKEN: undefined
      },
      async () => {
        await withCallerIdentity(async () => {
          const response = await hubHttpRequest("GET", "/api/health");
          assert.equal(response.statusCode, 200);
        });
      }
    );
  });
});

test("hubHttpRequest includes optional X-Meridian-Caller-Version header when configured", { concurrency: false }, async () => {
  await withHttpServer(async (request, response) => {
    assert.equal(request.headers["x-meridian-caller-id"], "meridian-cli");
    assert.equal(request.headers["x-meridian-caller-key"], "test-cli-key");
    assert.equal(request.headers["x-meridian-caller-version"], "9.9.9");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withEnv(
      {
        MERIDIAN_HTTP: baseUrl,
        WEB_GUI_TOKEN: undefined
      },
      async () => {
        await withCallerIdentity(
          async () => {
            const response = await hubHttpRequest("GET", "/api/health");
            assert.equal(response.statusCode, 200);
          },
          { ...TEST_IDENTITY, caller_version: "9.9.9" }
        );
      }
    );
  });
});

test("hubHttpRequest throws caller_identity_not_set before setCallerIdentity is called", { concurrency: false }, async () => {
  clearCallerIdentity();
  await withEnv(
    { MERIDIAN_HTTP: "http://127.0.0.1:1", WEB_GUI_TOKEN: undefined },
    async () => {
      await assert.rejects(() => hubHttpRequest("GET", "/api/health"), /caller_identity_not_set/);
    }
  );
});

test("hubHttpRequest reuses token embedded in MERIDIAN_HTTP when WEB_GUI_TOKEN is unset", { concurrency: false }, async () => {
  await withHttpServer(async (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/health");
    assert.equal(request.headers.authorization, "Bearer query-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withEnv(
      {
        MERIDIAN_HTTP: `${baseUrl}?token=query-token`,
        WEB_GUI_TOKEN: ""
      },
      async () => {
        await withCallerIdentity(async () => {
          const response = await hubHttpRequest("GET", "/api/health");
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.body, { ok: true });
        });
      }
    );
  });
});

test("connectToHub treats any HTTP response from /api/health as API reachability", { concurrency: false }, async () => {
  await withHttpServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/health");
    assert.equal(request.headers.authorization, "Bearer query-token");
    assert.equal(request.headers["x-meridian-caller-id"], "meridian-cli");
    assert.equal(request.headers["x-meridian-caller-key"], "test-cli-key");
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Please provide a valid access token" }));
  }, async (baseUrl) => {
    await withEnv(
      {
        MERIDIAN_HTTP: `${baseUrl}?token=query-token`,
        WEB_GUI_TOKEN: ""
      },
      async () => {
        await withCallerIdentity(async () => {
          const connection = await connectToHub();
          assert.deepEqual(connection, {
            httpBase: `${baseUrl}/`,
            authenticated: true,
            transport: "http"
          });
        });
      }
    );
  });
});

test("connectToHub throws when the Meridian API cannot be reached", { concurrency: false }, async () => {
  const baseUrl = await reserveClosedBaseUrl();

  await withEnv(
    {
      MERIDIAN_HTTP: baseUrl,
      WEB_GUI_TOKEN: undefined
    },
    async () => {
      await withCallerIdentity(async () => {
        await assert.rejects(connectToHub(), /Cannot reach Meridian API/);
      });
    }
  );
});

test("CLI bootstrap: deriveBuiltinCallerKey throws bootstrap_key_missing when MERIDIAN_INTERNAL_BOOTSTRAP_KEY is absent", { concurrency: false }, async () => {
  clearCallerIdentity();
  await withEnv({ MERIDIAN_INTERNAL_BOOTSTRAP_KEY: undefined }, async () => {
    const { deriveBuiltinCallerKey } = await import("../shared/caller-bootstrap");
    assert.throws(
      () => deriveBuiltinCallerKey("meridian-cli"),
      /bootstrap_key_missing/
    );
  });
});
