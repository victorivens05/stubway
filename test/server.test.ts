import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadCatalog } from "../src/fixtures.js";
import { createStubwayServer } from "../src/server.js";
import { StubwayState } from "../src/state.js";
import type { RuntimeConfig } from "../src/types.js";
import { makeTempFixturesDir, removeTempDir, writeFixture } from "./helpers.js";

/** `Response#json()` is typed `unknown`; tests only need structural access, not validation. */
async function json(res: Response): Promise<any> {
  return res.json();
}

/** Boot a real HTTP server backed by fixtures written to a temp dir; caller must call close(). */
function boot(setup: (fixturesDir: string) => void) {
  const fixturesDir = makeTempFixturesDir();
  setup(fixturesDir);
  const runtime: RuntimeConfig = {
    port: 0,
    fixturesDir,
    proxy: null,
    record: false,
    persist: false,
    cwd: fixturesDir,
  };
  const state = new StubwayState(loadCatalog(fixturesDir), {}, runtime);
  const server = createStubwayServer(state);
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            removeTempDir(fixturesDir);
          }),
      });
    });
  });
}

test("serves a route's active fixture with its status and body", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/payments-gateway/charges", "ok", {
      method: "POST",
      status: 201,
      body: { id: "ch_1", status: "captured" },
    });
  });
  try {
    const res = await fetch(`${base}/payments-gateway/charges`, { method: "POST", body: "{}" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: "ch_1", status: "captured" });
  } finally {
    await close();
  }
});

test("dynamic segments capture the concrete value and are visible in the log's params", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/users/[id]", "ok", { method: "GET", status: 200, body: { ok: true } });
  });
  try {
    const res = await fetch(`${base}/users/42`);
    assert.equal(res.status, 200);

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].matchedRoute, "/users/[id]");
    assert.deepEqual(log.entries[0].params, { id: "42" });
  } finally {
    await close();
  }
});

test("an unmatched request 404s with a hint and is logged as unmatched", async () => {
  const { base, close } = await boot(() => {});
  try {
    const res = await fetch(`${base}/nothing-here`);
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.match(body.hint, /no route directory maps to/);

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries[0].unmatched, true);
  } finally {
    await close();
  }
});

test("POST /__stubway/use flips which fixture answers subsequent requests", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/payments-gateway/charges", "ok", { method: "POST", status: 201, body: { ok: true } });
    writeFixture(dir, "/payments-gateway/charges", "timeout", { method: "POST", status: 504, body: { error: true } });
  });
  try {
    const use = await fetch(`${base}/__stubway/use`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/payments-gateway/charges", fixture: "timeout" }),
    });
    assert.equal(use.status, 200);

    const res = await fetch(`${base}/payments-gateway/charges`, { method: "POST" });
    assert.equal(res.status, 504);
  } finally {
    await close();
  }
});

test("the log list omits request/response bodies; log/:id returns the full entry", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/payments-gateway/charges", "ok", {
      method: "POST",
      status: 201,
      body: { id: "ch_1" },
    });
  });
  try {
    await fetch(`${base}/payments-gateway/charges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 42 }),
    });

    const list = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(list.entries.length, 1);
    assert.equal("requestBody" in list.entries[0], false);
    assert.equal("responseBody" in list.entries[0], false);

    const id = list.entries[0].id;
    const detail = await json(await fetch(`${base}/__stubway/log/${id}`));
    assert.deepEqual(detail.requestBody, { amount: 42 });
    assert.deepEqual(detail.responseBody, { id: "ch_1" });

    const missing = await fetch(`${base}/__stubway/log/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("GET /__stubway/routes and /__stubway/routes/show report the active fixture", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/payments-gateway/charges", "ok", { method: "POST", status: 201 });
  });
  try {
    const routes = await json(await fetch(`${base}/__stubway/routes`));
    assert.equal(routes.routes.length, 1);
    assert.equal(routes.routes[0].active.POST, "ok");

    const show = await json(
      await fetch(`${base}/__stubway/routes/show?path=${encodeURIComponent("/payments-gateway/charges")}`),
    );
    assert.equal(show.path, "/payments-gateway/charges");

    const notFound = await fetch(`${base}/__stubway/routes/show?path=${encodeURIComponent("/missing")}`);
    assert.equal(notFound.status, 404);
  } finally {
    await close();
  }
});

test("POST /__stubway/log/clear empties the log", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
  });
  try {
    await fetch(`${base}/widgets`);
    const cleared = await json(await fetch(`${base}/__stubway/log/clear`, { method: "POST" }));
    assert.equal(cleared.cleared, 1);

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries.length, 0);
  } finally {
    await close();
  }
});
