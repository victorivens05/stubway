import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { ControlClient } from "../src/client.js";
import { createServer } from "node:http";
import { daemonStatus } from "../src/daemon.js";
import { resolveFixturesDir } from "../src/commands/start.js";
import path from "node:path";
import { loadCatalog } from "../src/fixtures.js";
import { createStubwayServer } from "../src/server.js";
import { StubwayState } from "../src/state.js";
import type { RuntimeConfig } from "../src/types.js";
import { makeTempFixturesDir, removeTempDir, writeFixture, writeHandler } from "./helpers.js";

/** `Response#json()` is typed `unknown`; tests only need structural access, not validation. */
async function json(res: Response): Promise<any> {
  return res.json();
}

/** Boot a real HTTP server backed by fixtures written to a temp dir; caller must call close(). */
function boot(setup: (fixturesDir: string) => void, overrides: Partial<RuntimeConfig> = {}) {
  const fixturesDir = makeTempFixturesDir();
  setup(fixturesDir);
  const runtime: RuntimeConfig = {
    port: 0,
    fixturesDir,
    proxy: null,
    record: false,
    persist: false,
    cwd: fixturesDir,
    ...overrides,
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

async function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

async function useFixtures(base: string, route: string, fixture: string | string[]): Promise<Response> {
  return postJson(`${base}/__stubway/use`, { route, fixture });
}

test("a handler fixture echoes the request, overrides status and headers, and the log holds its body", async () => {
  const { base, close } = await boot((dir) => {
    writeHandler(
      dir,
      "/cobrancas/[id]",
      "echo",
      `{
        method: "POST",
        status: 201,
        respond: (req) => ({
          headers: { "x-id": req.params.id },
          body: { id: randomInt(), valor: req.body.valor, splits: req.body.splits, modo: req.query.modo },
        }),
      }`,
    );
    writeHandler(dir, "/precos", "ok", `({ status: 200, respond: (req) => ({ status: 404, body: { erro: req.method } }) });`);
  });
  try {
    const sent = { valor: 150.5, splits: [{ recebedor: "a", valor: 100 }, { recebedor: "b", valor: 50.5 }] };
    const res = await postJson(`${base}/cobrancas/77?modo=pix`, sent);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-id"), "77");
    const body = await json(res);
    assert.equal(body.valor, 150.5);
    assert.deepEqual(body.splits, sent.splits);
    assert.equal(body.modo, "pix");
    assert.equal(typeof body.id, "number");
    assert.notEqual((await json(await postJson(`${base}/cobrancas/77`, sent))).id, body.id);

    const notFound = await fetch(`${base}/precos`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await json(notFound), { erro: "GET" });

    const list = await json(await fetch(`${base}/__stubway/log`));
    const detail = await json(await fetch(`${base}/__stubway/log/${list.entries[0].id}`));
    assert.deepEqual(detail.responseBody, body);
    assert.deepEqual(detail.requestBody, sent);
  } finally {
    await close();
  }
});

test("a handler that throws or reaches for Node answers 500 naming the fixture, and the log keeps the reason", async () => {
  const { base, close } = await boot((dir) => {
    writeHandler(dir, "/boom", "ok", `{ status: 200, respond: (req) => req.body.cliente.nome }`);
    writeHandler(dir, "/node", "ok", `{ status: 200, respond: () => ({ body: process.env }) }`);
    writeHandler(dir, "/shape", "ok", `{ status: 200, respond: () => ({ status: 99 }) }`);
  });
  try {
    const boom = await postJson(`${base}/boom`, {});
    assert.equal(boom.status, 500);
    const error = await json(boom);
    assert.equal(error.fixture, "ok");
    assert.match(error.reason, /reading 'nome'\) at ok\.js:1:\d+$/);

    assert.match((await json(await fetch(`${base}/node`))).reason, /process is not defined/);
    assert.match((await json(await fetch(`${base}/shape`))).reason, /"status" must be/);

    const log = await json(await fetch(`${base}/__stubway/log?bodies=1`));
    assert.equal(log.entries[0].status, 500);
    assert.match(log.entries[0].error, /nome/);
  } finally {
    await close();
  }
});

test("a handler failure doesn't consume its sequence step", async () => {
  let fixturesDir = "";
  const { base, close } = await boot((dir) => {
    fixturesDir = dir;
    writeHandler(dir, "/cobrancas", "pendente", `{ method: "GET", status: 200, respond: () => { throw new Error("bug") } }`);
    writeFixture(dir, "/cobrancas", "excluida", { method: "GET", status: 200, body: { status: "excluida" } });
  });
  try {
    await useFixtures(base, "/cobrancas", ["pendente", "excluida"]);
    assert.equal((await fetch(`${base}/cobrancas`)).status, 500);

    writeHandler(fixturesDir, "/cobrancas", "pendente", `{ method: "GET", status: 200, respond: () => ({ body: { status: "pendente" } }) }`);
    assert.equal((await json(await fetch(`${base}/cobrancas`))).status, "pendente");
    assert.equal((await json(await fetch(`${base}/cobrancas`))).status, "excluida");
  } finally {
    await close();
  }
});

test("a JSON fixture is served byte for byte", async () => {
  const body = { id: "ch_1", nested: { list: [1, "two", null] }, text: "{{not.known}}" };
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { status: 200, body });
  });
  try {
    const res = await fetch(`${base}/widgets`);
    assert.equal(await res.text(), JSON.stringify(body, null, 2));
  } finally {
    await close();
  }
});

test("a sequence answers in order, sticks on the last, and re-use resets it", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/cobrancas/[id]", "pendente", { method: "GET", status: 200, body: { status: "pendente" } });
    writeFixture(dir, "/cobrancas/[id]", "excluida", { method: "GET", status: 200, body: { status: "excluida" } });
    writeFixture(dir, "/cobrancas/[id]", "deleted", { method: "DELETE", status: 204 });
  });
  const read = async () => (await json(await fetch(`${base}/cobrancas/1`))).status;
  try {
    const use = await useFixtures(base, "/cobrancas/:id", ["pendente", "excluida"]);
    assert.equal(use.status, 200);
    assert.deepEqual((await json(use)).sequences.GET, { names: ["pendente", "excluida"], cursor: 0 });

    assert.equal(await read(), "pendente");
    const deleted = await fetch(`${base}/cobrancas/1`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(await read(), "excluida");
    assert.equal(await read(), "excluida");

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.deepEqual(
      log.entries.map((e: { fixture: string }) => e.fixture),
      ["pendente", "deleted", "excluida", "excluida"],
    );

    await useFixtures(base, "/cobrancas/:id", ["pendente", "excluida"]);
    assert.equal(await read(), "pendente");
  } finally {
    await close();
  }
});

test("routes and show report the sequence without advancing it", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/cobrancas", "pendente", { method: "GET", status: 200, body: { status: "pendente" } });
    writeFixture(dir, "/cobrancas", "excluida", { method: "GET", status: 200, body: { status: "excluida" } });
  });
  try {
    await useFixtures(base, "/cobrancas", ["pendente", "excluida"]);
    await fetch(`${base}/__stubway/routes`);
    const show = await json(await fetch(`${base}/__stubway/routes/show?path=${encodeURIComponent("/cobrancas")}`));
    assert.deepEqual(show.sequences.GET, { names: ["pendente", "excluida"], cursor: 0 });
    assert.equal(show.active.GET, "pendente");

    assert.equal((await json(await fetch(`${base}/cobrancas`))).status, "pendente");
  } finally {
    await close();
  }
});

test("POST /__stubway/use rejects a sequence mixing method slots", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/cobrancas", "pendente", { method: "GET", status: 200 });
    writeFixture(dir, "/cobrancas", "criada", { method: "POST", status: 201 });
  });
  try {
    const res = await useFixtures(base, "/cobrancas", ["pendente", "criada"]);
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /one method/);
  } finally {
    await close();
  }
});

test("GET /__stubway/log?bodies=1 includes request and response bodies", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { method: "POST", status: 201, body: { id: 1 } });
  });
  try {
    await postJson(`${base}/widgets`, { amount: 42 });
    const log = await json(await fetch(`${base}/__stubway/log?bodies=1`));
    assert.deepEqual(log.entries[0].requestBody, { amount: 42 });
    assert.deepEqual(log.entries[0].responseBody, { id: 1 });
  } finally {
    await close();
  }
});

test("a selected fixture that breaks answers 500, and the log entry carries the reason", async () => {
  let fixturesDir = "";
  const { base, close } = await boot((dir) => {
    fixturesDir = dir;
    writeFixture(dir, "/widgets", "ok", { method: "POST", status: 201 });
    writeFixture(dir, "/widgets", "error", { method: "POST", status: 500, body: { real: "outage" } });
  });
  try {
    await useFixtures(base, "/widgets", "error");
    writeFileSync(path.join(fixturesDir, "widgets", "error.json"), "{ broken");

    const res = await fetch(`${base}/widgets`, { method: "POST" });
    assert.equal(res.status, 500);
    assert.equal((await json(res)).fixture, "error");

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries[0].fixture, "error");
    assert.equal(log.entries[0].state, "done");
    assert.match(log.entries[0].error, /"error" is invalid/);

    const show = await json(await fetch(`${base}/__stubway/routes/show?path=/widgets`));
    assert.ok(show.problems.some((p: string) => /POST selection/.test(p)));
  } finally {
    await close();
  }
});

test("a request waiting on timeoutMs is logged as pending with its fixture, then done", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/slow", "ok", { status: 200, timeoutMs: 300, body: { ok: true } });
  });
  try {
    const inFlight = fetch(`${base}/slow`);
    await new Promise((r) => setTimeout(r, 100));
    const during = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(during.entries[0].state, "pending");
    assert.equal(during.entries[0].fixture, "ok");
    assert.equal(during.entries[0].status, null);

    await (await inFlight).text();
    const after = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(after.entries[0].state, "done");
    assert.equal(after.entries[0].status, 200);
  } finally {
    await close();
  }
});

test("a client that gives up during timeoutMs leaves an aborted entry", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/slow", "ok", { status: 200, timeoutMs: 400 });
  });
  try {
    const controller = new AbortController();
    const inFlight = fetch(`${base}/slow`, { signal: controller.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await inFlight;
    await new Promise((r) => setTimeout(r, 450));

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries[0].state, "aborted");
    assert.match(log.entries[0].error, /closed the connection/);
  } finally {
    await close();
  }
});

test("GET /__stubway/log filters by method and limit and rejects bad since or limit", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
  });
  try {
    await fetch(`${base}/widgets`);
    await fetch(`${base}/widgets`, { method: "POST" });
    await fetch(`${base}/widgets`);

    assert.equal((await json(await fetch(`${base}/__stubway/log?method=POST`))).count, 1);
    assert.equal((await json(await fetch(`${base}/__stubway/log?limit=2`))).count, 2);
    assert.equal((await fetch(`${base}/__stubway/log?since=nope`)).status, 400);
    assert.equal((await fetch(`${base}/__stubway/log?limit=0`)).status, 400);
  } finally {
    await close();
  }
});

test("a 404 on a route with only invalid fixtures names the invalid files", async () => {
  const { base, close } = await boot((dir) => {
    mkdirSync(path.join(dir, "widgets"), { recursive: true });
    writeFileSync(path.join(dir, "widgets", "ok.json"), "{ not json");
  });
  try {
    const res = await fetch(`${base}/widgets`);
    assert.equal(res.status, 404);
    assert.match((await json(res)).hint, /ok\.json \(invalid JSON/);
  } finally {
    await close();
  }
});

function portOf(base: string): number {
  return Number(new URL(base).port);
}

test("ControlClient refuses a daemon that isn't the process the pidfile recorded", async () => {
  const { base, close } = await boot((dir) => writeFixture(dir, "/widgets", "ok", { status: 200 }));
  try {
    await assert.rejects(new ControlClient(portOf(base), process.pid + 1).routes(), /is gone/);
    assert.equal((await new ControlClient(portOf(base), process.pid).routes()).length, 1);
  } finally {
    await close();
  }
});

test("daemonStatus prunes a pidfile whose process doesn't answer health as itself", async () => {
  const { base, close } = await boot(() => {});
  const project = makeTempFixturesDir();
  const pidfile = path.join(project, ".stubway", ".local", "daemon.json");
  const writePidfile = (pid: number, port: number) => {
    mkdirSync(path.dirname(pidfile), { recursive: true });
    writeFileSync(pidfile, JSON.stringify({ pid, port }));
  };
  try {
    writePidfile(process.pid, portOf(base));
    assert.equal((await daemonStatus(project)).running, true);

    writePidfile(process.ppid, portOf(base));
    assert.equal((await daemonStatus(project)).running, false);
    assert.equal(existsSync(pidfile), false);
  } finally {
    removeTempDir(project);
    await close();
  }
});

test("new fixture with -p writes into the fixtures dir of the daemon on that port", async () => {
  let served = "";
  const { base, close } = await boot((dir) => {
    served = dir;
  });
  try {
    assert.equal(await resolveFixturesDir({ port: String(portOf(base)) }), served);
  } finally {
    await close();
  }
});

test("a selected route whose last file is deleted reports the broken selection, not a sibling route", async () => {
  let fixturesDir = "";
  const { base, close } = await boot((dir) => {
    fixturesDir = dir;
    writeFixture(dir, "/users/me", "error", { status: 500 });
    writeFixture(dir, "/users/[id]", "ok", { status: 200 });
  });
  try {
    await useFixtures(base, "/users/me", "error");
    rmSync(path.join(fixturesDir, "users", "me"), { recursive: true });

    const res = await fetch(`${base}/users/me`);
    assert.equal(res.status, 500);
    assert.match((await json(res)).reason, /no longer exists/);
  } finally {
    await close();
  }
});

test("an upload cut short is still logged, as aborted", async () => {
  const { base, close } = await boot((dir) => writeFixture(dir, "/widgets", "ok", { method: "POST", status: 201 }));
  try {
    await new Promise<void>((resolve) => {
      const socket = connect(portOf(base), "127.0.0.1", () => {
        socket.write("POST /widgets HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{\"partial\":");
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 100);
      });
    });
    await new Promise((r) => setTimeout(r, 100));

    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].state, "aborted");
  } finally {
    await close();
  }
});

test("HEAD and 204 responses log no body, matching what the client received", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { status: 200, body: { a: 1 } });
    writeFixture(dir, "/gone", "ok", { status: 204, body: { never: "sent" } });
  });
  try {
    await fetch(`${base}/widgets`, { method: "HEAD" });
    await fetch(`${base}/gone`, { method: "DELETE" });
    const log = await json(await fetch(`${base}/__stubway/log?bodies=1`));
    assert.deepEqual(log.entries.map((e: { responseBody: unknown }) => e.responseBody), [null, null]);
  } finally {
    await close();
  }
});

test("with --record, a fixture that can't be written keeps the proxied outcome and reports the error", async () => {
  const upstream = await boot((dir) => writeFixture(dir, "/widgets", "ok", { method: "POST", status: 201, body: { id: 7 } }));
  const readOnly = makeTempFixturesDir();
  chmodSync(readOnly, 0o555);
  const { base, close } = await boot(() => {}, { proxy: upstream.base, record: true, fixturesDir: readOnly });
  try {
    const res = await fetch(`${base}/widgets`, { method: "POST" });
    assert.equal(res.status, 201);

    const log = await json(await fetch(`${base}/__stubway/log?bodies=1`));
    const entry = log.entries[0];
    assert.equal(entry.status, 201);
    assert.equal(entry.proxied, true);
    assert.deepEqual(entry.responseBody, { id: 7 });
    assert.match(entry.error, /recording the fixture failed/);
  } finally {
    chmodSync(readOnly, 0o755);
    removeTempDir(readOnly);
    await close();
    await upstream.close();
  }
});

async function fakeHealthServer(health: Record<string, unknown>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(health));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("ControlClient refuses a daemon running another stubway version, with a restart hint", async () => {
  const old = await fakeHealthServer({ ok: true, version: "0.1.0" });
  try {
    await assert.rejects(new ControlClient(old.port).routes(), /runs stubway 0\.1\.0.*stubway stop && stubway start/);
  } finally {
    await old.close();
  }
});

test("a plain OPTIONS call is logged; only a CORS preflight is answered without logging", async () => {
  const { base, close } = await boot(() => {});
  try {
    await fetch(`${base}/capabilities`, { method: "OPTIONS" });
    await fetch(`${base}/capabilities`, { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });
    const log = await json(await fetch(`${base}/__stubway/log`));
    assert.equal(log.count, 1);
    assert.equal(log.entries[0].unmatched, true);
  } finally {
    await close();
  }
});

test("HEAD keeps the fixture's content type and logs no body, even for a stubway error", async () => {
  const { base, close } = await boot((dir) => {
    writeFixture(dir, "/widgets", "ok", { status: 200, body: { a: 1 } });
    writeHandler(dir, "/broken", "ok", `{ status: 200, respond: () => { throw new Error("broken handler") } }`);
  });
  try {
    const head = await fetch(`${base}/widgets`, { method: "HEAD" });
    assert.match(head.headers.get("content-type") ?? "", /application\/json/);
    const failed = await fetch(`${base}/broken`, { method: "HEAD" });
    assert.equal(failed.status, 500);

    const log = await json(await fetch(`${base}/__stubway/log?bodies=1`));
    assert.deepEqual(log.entries.map((e: { responseBody: unknown }) => e.responseBody), [null, null]);
    assert.match(log.entries[1].error, /broken handler/);
  } finally {
    await close();
  }
});
