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
 * A single response definition, stored as one JSON file on disk.
 *
 *   { "method": "POST", "status": 201, "description": "...", "body": { ... } }
 *   { "status": 500, "timeoutMs": 3000, "description": "upstream hangs then errors" }
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
}

/** A route is a directory that directly contains one or more fixture files. */
export interface Route {
  /** URL path derived from the fixtures dir, e.g. "/payments-gateway/charges". */
  path: string;
  /** Absolute directory on disk. */
  dir: string;
  fixtures: Fixture[];
}

/** Active fixture per route, per method: selections[routePath][method] = fixtureName. */
export type Selections = Record<string, Partial<Record<FixtureMethod, string>>>;

/** One captured request/response pair. */
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
