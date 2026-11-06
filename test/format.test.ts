import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRoute } from "../src/format.js";

test("show lists a route's problems even when none of its fixtures is valid", () => {
  const text = formatRoute({
    path: "/widgets",
    active: {},
    sequences: {},
    problems: ["ok.json is invalid: invalid JSON"],
    fixtures: [],
  });
  assert.match(text, /ok\.json is invalid/);
  assert.doesNotMatch(text, /no fixtures yet/);
});
