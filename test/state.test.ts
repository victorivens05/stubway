import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../src/fixtures.js";
import { StateError, StubwayState } from "../src/state.js";
import type { RuntimeConfig } from "../src/types.js";
import { makeTempFixturesDir, removeTempDir, writeFixture } from "./helpers.js";

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

    assert.equal(state.resolveFixture(route, "ANY")?.name, "ok");
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
    assert.equal(state.resolveFixture(route, "ANY")?.name, "boom");
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
