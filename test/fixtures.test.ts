import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeRoutePath, loadCatalog, toRouteDir } from "../src/fixtures.js";
import { createFixture } from "../src/scaffold.js";
import { makeTempFixturesDir, removeTempDir, writeFixture, writeHandler } from "./helpers.js";

test("loadCatalog groups fixtures by directory into routes, sorted by path and name", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/payments-gateway/charges", "ok", { status: 201 });
    writeFixture(dir, "/payments-gateway/charges", "timeout", { status: 504 });
    writeFixture(dir, "/directory-api/accounts", "active", { status: 200 });

    const catalog = loadCatalog(dir);

    assert.deepEqual(
      catalog.map((r) => r.path),
      ["/directory-api/accounts", "/payments-gateway/charges"],
    );
    const charges = catalog.find((r) => r.path === "/payments-gateway/charges")!;
    assert.deepEqual(
      charges.fixtures.map((f) => f.name),
      ["ok", "timeout"],
    );
  } finally {
    removeTempDir(dir);
  }
});

test("loadCatalog defaults method to ANY and skips fixtures without a numeric status", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "no-method", { status: 200 });
    writeFixture(dir, "/widgets", "broken", { description: "missing status" });

    const catalog = loadCatalog(dir);

    const widgets = catalog.find((r) => r.path === "/widgets")!;
    assert.equal(widgets.fixtures.length, 1);
    assert.equal(widgets.fixtures[0]!.method, "ANY");
  } finally {
    removeTempDir(dir);
  }
});

test("loadCatalog ignores dot-directories such as .local", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "ok", { status: 200 });
    writeFixture(dir, "/.local/should-be-ignored", "ok", { status: 200 });

    const catalog = loadCatalog(dir);

    assert.deepEqual(
      catalog.map((r) => r.path),
      ["/widgets"],
    );
  } finally {
    removeTempDir(dir);
  }
});

test("canonicalizeRoutePath turns :id into [id], leaving other segments untouched", () => {
  assert.equal(canonicalizeRoutePath("/users/:id"), "/users/[id]");
  assert.equal(canonicalizeRoutePath("/users/[id]"), "/users/[id]");
  assert.equal(canonicalizeRoutePath("/payments-gateway/charges"), "/payments-gateway/charges");
});

test("toRouteDir maps a route path back onto disk under the fixtures root", () => {
  const dir = toRouteDir("/fx", "/users/:id");
  assert.equal(dir, "/fx/users/[id]");
});

test("loadCatalog keeps invalid files with a reason instead of guessing, e.g. an unknown method", () => {
  const dir = makeTempFixturesDir();
  try {
    writeFixture(dir, "/widgets", "typo", { method: "PSOT", status: 201 });
    writeFixture(dir, "/widgets", "bad-status", { status: 999 });
    writeFixture(dir, "/widgets", "informational", { status: 100 });
    writeFixture(dir, "/widgets", "bad-delay", { status: 200, timeoutMs: -5 });
    writeFixture(dir, "/widgets", "ok", { method: "post", status: 201 });

    const widgets = loadCatalog(dir).find((r) => r.path === "/widgets")!;

    assert.deepEqual(widgets.fixtures.map((f) => [f.name, f.method]), [["ok", "POST"]]);
    assert.deepEqual(widgets.invalidFixtures.map((f) => f.name).sort(), ["bad-delay", "bad-status", "informational", "typo"]);
    assert.match(widgets.invalidFixtures.find((f) => f.name === "typo")!.reason, /PSOT/);
  } finally {
    removeTempDir(dir);
  }
});

test("a route whose only fixture is invalid still exists, so a request can say why it 404s", () => {
  const dir = makeTempFixturesDir();
  try {
    mkdirSync(path.join(dir, "widgets"), { recursive: true });
    writeFileSync(path.join(dir, "widgets", "ok.json"), "{ not json");

    const widgets = loadCatalog(dir).find((r) => r.path === "/widgets")!;
    assert.equal(widgets.fixtures.length, 0);
    assert.match(widgets.invalidFixtures[0]!.reason, /invalid JSON/);
  } finally {
    removeTempDir(dir);
  }
});

test("createFixture refuses names and routes that would write outside the fixtures dir", () => {
  const dir = makeTempFixturesDir();
  try {
    assert.throws(() => createFixture(dir, { route: "/widgets", name: "../escape" }), /invalid fixture name/);
    assert.throws(() => createFixture(dir, { route: "/../../escape", name: "ok" }), /outside the fixtures dir/);
    assert.equal(existsSync(path.join(dir, "..", "escape.json")), false);
  } finally {
    removeTempDir(dir);
  }
});

test("createFixture validates the envelope and keeps an explicit null body", () => {
  const dir = makeTempFixturesDir();
  try {
    assert.throws(() => createFixture(dir, { route: "/widgets", name: "x", status: 999 }), /status/);
    assert.throws(() => createFixture(dir, { route: "/widgets", name: "y", timeoutMs: -1 }), /timeoutMs/);

    const file = createFixture(dir, { route: "/widgets", name: "empty", body: null });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).body, null);
  } finally {
    removeTempDir(dir);
  }
});

test("loadCatalog reads .js fixtures as object literals and reports broken ones", () => {
  const dir = makeTempFixturesDir();
  try {
    writeHandler(dir, "/widgets", "static", `{ method: "get", status: 200, body: { a: 1 } }`);
    writeHandler(dir, "/widgets", "echo", `({ status: 201, respond: (req) => ({ body: req.body }) });`);
    writeHandler(dir, "/widgets", "both", `{ status: 200, body: {}, respond: () => ({}) }`);
    writeHandler(dir, "/widgets", "syntax", `{ status: 200, body: }`);
    writeHandler(dir, "/widgets", "loop", `(() => { while (true) {} })()`);
    writeHandler(dir, "/widgets", "ok", `{ status: 200 }`);
    writeFixture(dir, "/widgets", "ok", { status: 201 });

    const widgets = loadCatalog(dir).find((r) => r.path === "/widgets")!;
    assert.deepEqual(widgets.fixtures.map((f) => f.name), ["echo", "ok", "static"]);
    assert.equal(widgets.fixtures.find((f) => f.name === "static")!.method, "GET");
    assert.equal(typeof widgets.fixtures.find((f) => f.name === "echo")!.respond, "function");
    const reasons = Object.fromEntries(widgets.invalidFixtures.map((f) => [path.basename(f.file), f.reason]));
    assert.match(reasons["both.js"]!, /not both/);
    assert.match(reasons["syntax.js"]!, /evaluating it threw/);
    assert.match(reasons["loop.js"]!, /timed out/);
    assert.match(reasons["ok.json"]!, /ok\.js already defines/);
  } finally {
    removeTempDir(dir);
  }
});
