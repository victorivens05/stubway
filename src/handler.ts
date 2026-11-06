import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import type { HandlerRequest } from "./types.js";

const HANDLER_TIMEOUT_MS = 1000;
const RANDOM_INT_BOUND = 2 ** 31;

/**
 * Evaluate a `.js` fixture: an object literal, optionally wrapped in parentheses, run in a fresh
 * vm context that holds only the JS built-ins plus `uuid()` and `randomInt()`. A `respond`
 * function comes back wrapped so every call runs in that context under the same timeout.
 * Throws whatever the file throws; the caller reports it as an invalid fixture.
 */
export function evaluateFixtureScript(source: string, file: string): unknown {
  const context = vm.createContext({
    uuid: () => randomUUID(),
    randomInt: () => randomInt(1, RANDOM_INT_BOUND),
  });
  const expression = `(\n${source.trim().replace(/;$/, "")}\n)`;
  const envelope: unknown = vm.runInContext(expression, context, {
    filename: file,
    lineOffset: -1,
    timeout: HANDLER_TIMEOUT_MS,
  });
  if (!isObject(envelope) || typeof envelope.respond !== "function") return envelope;

  context.fixture = envelope;
  const respond = (req: HandlerRequest): unknown => {
    context.req = req;
    try {
      return vm.runInContext("fixture.respond(req)", context, { timeout: HANDLER_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`${errorMessage(err)}${locationIn(err, file)}`);
    }
  };
  return { ...envelope, respond };
}

/** Errors thrown inside a vm context aren't instances of this realm's Error. */
export function errorMessage(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err ? String(err.message) : String(err);
}

/** " at ok.js:4:28" when the error's stack points into the fixture file, else "". */
function locationIn(err: unknown, file: string): string {
  const stack = typeof err === "object" && err !== null && "stack" in err ? String(err.stack) : "";
  const frame = stack.split("\n").find((line) => line.includes(`(${file}:`));
  const position = frame?.match(/:(\d+:\d+)\)$/)?.[1];
  return position ? ` at ${path.basename(file)}:${position}` : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
