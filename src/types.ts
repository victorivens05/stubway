/** Shared domain types for Stubway. */

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** "ANY" matches a request regardless of method and acts as a fallback. */
export type FixtureMethod = HttpMethod | "ANY";

/**
 * A single response definition, stored as one file on disk: a JSON envelope, or a `.js`
 * handler fixture whose envelope may carry `respond(req)` in place of `body`.
 *
 *   { "method": "POST", "status": 201, "description": "...", "body": { ... } }
 *   { status: 201, respond: (req) => ({ body: { valor: req.body.valor } }) }
 */
export interface Fixture {
  /** File name without extension, e.g. "ok", "boom", "invalid-card". */
  name: string;
  /** Absolute path to the source file. */
  file: string;
  /** Defaults to "ANY" when omitted in the file. */
  method: FixtureMethod;
  status: number;
  description?: string;
  /** Extra response headers merged onto the reply. */
  headers?: Record<string, string>;
  /** Response body. Objects/arrays are sent as JSON; strings sent verbatim. */
  body?: unknown;
  /** Delay before responding, in milliseconds. Models slow upstreams / timeouts. */
  timeoutMs?: number;
  /** Handler fixtures only. Its status and headers override the envelope's; it alone gives the body. */
  respond?: (req: HandlerRequest) => unknown;
}

/** What a handler fixture's `respond` receives. */
export interface HandlerRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, the raw string otherwise, undefined when empty. */
  body: unknown;
}

/** A fixture file that failed to load, kept so a selection naming it can say why. */
export interface InvalidFixture {
  name: string;
  file: string;
  reason: string;
}

/** A route is a directory that directly contains one or more fixture files. */
export interface Route {
  /** URL path derived from the fixtures dir, e.g. "/payments-gateway/charges". */
  path: string;
  /** Absolute directory on disk. */
  dir: string;
  fixtures: Fixture[];
  invalidFixtures: InvalidFixture[];
}

/** Fixtures served in order, one per request; `cursor` stays on the last one once reached. */
export interface FixtureSequence {
  names: string[];
  cursor: number;
}

export type Selection = string | FixtureSequence;

/** Active fixture per route, per method: selections[routePath][method] = name or sequence. */
export type Selections = Record<string, Partial<Record<FixtureMethod, Selection>>>;

/**
 * pending: received, response not sent yet (e.g. waiting out a fixture's timeoutMs).
 * aborted: the client closed the connection before the response was sent.
 * failed: stubway itself threw while answering.
 */
export type LogState = "pending" | "done" | "aborted" | "failed";

/** One captured request/response pair, logged on receipt and completed when answered. */
export interface LogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  query: string;
  matchedRoute: string | null;
  /** Values captured from dynamic route segments, e.g. { id: "123" } for /users/[id]. */
  params: Record<string, string>;
  fixture: string | null;
  status: number | null;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseBody: unknown;
  unmatched: boolean;
  proxied: boolean;
  durationMs: number;
  state: LogState;
  /** Why stubway answered with its own error: a broken selection, a handler failure, a crash. */
  error: string | null;
}

/** Effective runtime configuration for a running daemon. */
export interface RuntimeConfig {
  port: number;
  fixturesDir: string;
  proxy: string | null;
  record: boolean;
  persist: boolean;
  cwd: string;
}

/** Shape of the persisted config.json (selections + run config only). */
export interface PersistedConfig {
  port?: number;
  fixturesDir?: string;
  proxy?: string | null;
  record?: boolean;
  selections?: Selections;
}
