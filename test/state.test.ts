import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCatalog } from "../src/fixtures.js";
import { advanceSequence, restoreSelections, StateError, StubwayState } from "../src/state.js";
import type { FixtureMethod, Route, RuntimeConfig } from "../src/types.js";
import type { FixtureResolution } from "../src/state.js";
import { makeTempFixturesDir, removeTempDir, writeFixture } from "./helpers.js";

function servedName(resolution: FixtureResolution): string | undefined {
  return resolution.kind === "served" ? resolution.fixture.name : undefined;
}

/** Resolve and consume the step, as the server does once a fixture answered. */
function serve(state: StubwayState, route: Route, method: FixtureMethod): FixtureResolution {
  const resolution = state.resolveFixture(route, method);
  if (resolution.kind === "served" && resolution.sequence) advanceSequence(resolution.sequence);
  return resolution;
}

function makeRuntime(fixturesDir: string): RuntimeConfig {
  return { port: 0, fixturesDir, proxy: null, record: false, persist: false, cwd: fixturesDir };
}

test("matchRoute prefers a static segment over a dynamic one at the same position", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/users/me", "self", { status: 200 });
    writeFixture(dir, "/users/[id]", "ok", { status: 200 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));

    assert.equal(state.matchRoute("/users/me")?.route.path, "/users/me");
    const dynamic = state.matchRoute("/users/42");
    assert.equal(dynamic?.route.path, "/users/[id]");
    assert.deepEqual(dynamic?.params, { id: "42" });
  } finally {
    removeTempDir(dir);
  }
});

test("resolveFixture falls back to default/ok/success, then alphabetical, when nothing is selected", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "boom", { status: 500 });
    writeFixture(dir, "/widgets", "ok", { status: 200 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));
    const route = state.getRoute("/widgets")!;

    assert.equal(servedName(state.resolveFixture(route, "ANY")), "ok");
  } finally {
    removeTempDir(dir);
  }
});

test("setSelection flips the active fixture for a route+method, scoped to that method", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
    writeFixture(dir, "/widgets", "boom", { status: 500 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));

    state.setSelection("/widgets", "boom");
    const route = state.getRoute("/widgets")!;
    assert.equal(servedName(state.resolveFixture(route, "ANY")), "boom");
  } finally {
    removeTempDir(dir);
  }
});

test("setSelection throws StateError for an unknown route or fixture name", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));

    assert.throws(() => state.setSelection("/missing", "ok"), StateError);
    assert.throws(() => state.setSelection("/widgets", "missing-fixture"), StateError);
  } finally {
    removeTempDir(dir);
  }
});

test("queryLog filters by route and since, and getLogEntry finds the most recent match by id", () => {
  const dir = makeTempFixturesDir();
  const state = new StubwayState([], {}, makeRuntime(dir));
  try {
    const first = state.record({
      method: "GET",
      path: "/a",
      query: "",
      matchedRoute: "/a",
      params: {},
      fixture: "ok",
      status: 200,
      requestHeaders: {},
      requestBody: null,
      responseBody: null,
      unmatched: false,
      proxied: false,
      durationMs: 1,
      state: "done",
      error: null,
    });
    const second = state.record({
      method: "GET",
      path: "/b",
      query: "",
      matchedRoute: "/b",
      params: {},
      fixture: "ok",
      status: 200,
      requestHeaders: {},
      requestBody: null,
      responseBody: null,
      unmatched: false,
      proxied: false,
      durationMs: 1,
      state: "done",
      error: null,
    });
    // record() timestamps with Date.now(), which can tie within the same test tick — pin
    // them explicitly so the `since` filter below is deterministic.
    first.timestamp = "2024-01-01T00:00:00.000Z";
    second.timestamp = "2024-01-01T00:00:01.000Z";
    const cutoff = "2024-01-01T00:00:00.500Z";

    assert.deepEqual(
      state.queryLog({ route: "/a" }).map((e) => e.id),
      [first.id],
    );
    assert.deepEqual(
      state.queryLog({ since: cutoff }).map((e) => e.id),
      [second.id],
    );
    assert.equal(state.getLogEntry(second.id)?.path, "/b");
    assert.equal(state.getLogEntry("does-not-exist"), undefined);

    assert.equal(state.clearLog(), 2);
    assert.equal(state.queryLog().length, 0);
  } finally {
    removeTempDir(dir);
  }
});

function sequenceState(dir: string): StubwayState {
  writeFixture(dir, "/cobrancas", "pendente", { method: "GET", status: 200 });
  writeFixture(dir, "/cobrancas", "excluida", { method: "GET", status: 200 });
  writeFixture(dir, "/cobrancas", "excluir", { method: "DELETE", status: 204 });
  writeFixture(dir, "/cobrancas", "criada", { method: "POST", status: 201 });
  return new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));
}

test("serving walks a sequence in order and sticks on the last name", () => {
  const dir = makeTempFixturesDir();
  try {
    const state = sequenceState(dir);
    state.setSelection("/cobrancas", ["pendente", "excluida"]);
    const route = state.getRoute("/cobrancas")!;

    assert.equal(servedName(serve(state, route, "GET")), "pendente");
    assert.equal(servedName(serve(state, route, "GET")), "excluida");
    assert.equal(servedName(serve(state, route, "GET")), "excluida");
  } finally {
    removeTempDir(dir);
  }
});

test("a request in another method slot does not consume the sequence", () => {
  const dir = makeTempFixturesDir();
  try {
    const state = sequenceState(dir);
    state.setSelection("/cobrancas", ["pendente", "excluida"]);
    const route = state.getRoute("/cobrancas")!;

    assert.equal(servedName(serve(state, route, "DELETE")), "excluir");
    assert.equal(servedName(serve(state, route, "GET")), "pendente");
  } finally {
    removeTempDir(dir);
  }
});

test("setSelection again resets the cursor", () => {
  const dir = makeTempFixturesDir();
  try {
    const state = sequenceState(dir);
    const route = state.getRoute("/cobrancas")!;
    state.setSelection("/cobrancas", ["pendente", "excluida"]);
    serve(state, route, "GET");
    state.setSelection("/cobrancas", ["pendente", "excluida"]);

    assert.equal(servedName(serve(state, route, "GET")), "pendente");
  } finally {
    removeTempDir(dir);
  }
});

test("setSelection rejects a sequence mixing method slots or naming an unknown fixture", () => {
  const dir = makeTempFixturesDir();
  try {
    const state = sequenceState(dir);
    assert.throws(() => state.setSelection("/cobrancas", ["pendente", "criada"]), StateError);
    assert.throws(() => state.setSelection("/cobrancas", ["pendente", "missing"]), StateError);
  } finally {
    removeTempDir(dir);
  }
});

test("resolveFixture, activeByMethod and sequencesByMethod do not advance the cursor", () => {
  const dir = makeTempFixturesDir();
  try {
    const state = sequenceState(dir);
    state.setSelection("/cobrancas", ["pendente", "excluida"]);
    const route = state.getRoute("/cobrancas")!;

    state.resolveFixture(route, "GET");
    state.activeByMethod(route);
    assert.deepEqual(state.sequencesByMethod(route), { GET: { names: ["pendente", "excluida"], cursor: 0 } });
    assert.equal(servedName(serve(state, route, "GET")), "pendente");
  } finally {
    removeTempDir(dir);
  }
});

test("queryLog accepts since as epoch milliseconds", () => {
  const dir = makeTempFixturesDir();
  const state = new StubwayState([], {}, makeRuntime(dir));
  try {
    const entry = state.record({
      method: "GET", path: "/a", query: "", matchedRoute: "/a", params: {}, fixture: "ok", status: 200,
      requestHeaders: {}, requestBody: null, responseBody: null, unmatched: false, proxied: false, durationMs: 1,
      state: "done",
      error: null,
    });
    entry.timestamp = "2024-01-01T00:00:00.400Z";
    const at = Date.parse(entry.timestamp);

    assert.equal(state.queryLog({ since: String(at) }).length, 1);
    assert.equal(state.queryLog({ since: String(at + 1) }).length, 0);
  } finally {
    removeTempDir(dir);
  }
});

test("restoreSelections rewinds saved sequences and keeps single names", () => {
  const rewound = restoreSelections({
    "/cobrancas": { GET: { names: ["pendente", "excluida"], cursor: 1 }, POST: "criada" },
  });
  assert.deepEqual(rewound, {
    "/cobrancas": { GET: { names: ["pendente", "excluida"], cursor: 0 }, POST: "criada" },
  });
});

test("a saved selection whose route vanished before the restart still reports the broken selection", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/users/[id]", "ok", { status: 200 });
    const state = new StubwayState([], restoreSelections({ "/users/me": { ANY: "error" } }), makeRuntime(dir));
    state.reload();

    const match = state.matchRoute("/users/me")!;
    assert.equal(match.route.path, "/users/me");
    assert.equal(serve(state, match.route, "GET").kind, "brokenSelection");
  } finally {
    removeTempDir(dir);
  }
});

test("a selected fixture that became invalid or was deleted is a broken selection, not a silent default", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "ok", { method: "POST", status: 201 });
    writeFixture(dir, "/widgets", "error", { method: "POST", status: 500 });
    writeFixture(dir, "/widgets", "gone", { method: "POST", status: 410 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));
    state.setSelection("/widgets", "error");
    writeFileSync(path.join(dir, "widgets", "error.json"), "{ broken");
    state.reload();
    const route = state.getRoute("/widgets")!;

    const broken = state.resolveFixture(route, "POST");
    assert.equal(broken.kind, "brokenSelection");
    assert.match(broken.kind === "brokenSelection" ? broken.reason : "", /"error" is invalid: invalid JSON/);
    assert.equal(state.problemsFor(route).length, 2);

    state.setSelection("/widgets", "gone");
    rmSync(path.join(dir, "widgets", "gone.json"));
    state.reload();
    const deleted = state.resolveFixture(state.getRoute("/widgets")!, "POST");
    assert.match(deleted.kind === "brokenSelection" ? deleted.reason : "", /no longer exists/);
  } finally {
    removeTempDir(dir);
  }
});

test("with nothing selected, the method's own fixture beats an ANY fixture named default", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "default", { status: 200 });
    writeFixture(dir, "/widgets", "post", { method: "POST", status: 201 });
    const state = new StubwayState(loadCatalog(dir), {}, makeRuntime(dir));
    const route = state.getRoute("/widgets")!;

    assert.equal(servedName(state.resolveFixture(route, "POST")), "post");
    assert.equal(servedName(state.resolveFixture(route, "GET")), "default");
  } finally {
    removeTempDir(dir);
  }
});

test("queryLog filters by method and limit, and rejects an unreadable since", () => {
  const dir = makeTempFixturesDir();
  const state = new StubwayState([], {}, makeRuntime(dir));
  try {
    for (const method of ["GET", "POST", "GET", "GET"]) {
      state.record({
        method, path: "/a", query: "", matchedRoute: "/a", params: {}, fixture: "ok", status: 200,
        requestHeaders: {}, requestBody: null, responseBody: null, unmatched: false, proxied: false,
        durationMs: 1, state: "done", error: null,
      });
    }
    assert.equal(state.queryLog({ method: "get" }).length, 3);
    assert.deepEqual(state.queryLog({ limit: 2 }).map((e) => e.method), ["GET", "GET"]);
    assert.throws(() => state.queryLog({ since: "yesterday-ish" }), StateError);
    assert.throws(() => state.queryLog({ since: "999999999999999999999999999" }), StateError);
  } finally {
    removeTempDir(dir);
  }
});
