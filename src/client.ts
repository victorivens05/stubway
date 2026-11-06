import { CONTROL_PREFIX } from "./constants.js";
import { version as clientVersion } from "./version.js";
import type { LogFilter } from "./state.js";
import type { FixtureSequence, LogEntry } from "./types.js";

export interface FixtureDto {
  name: string;
  method: string;
  status: number;
  description?: string;
  timeoutMs?: number;
  /** A `.js` fixture whose body comes from respond(req). */
  handler: boolean;
}

export interface RouteDto {
  path: string;
  active: Record<string, string>;
  /** Sequences keyed by the method slot that holds them. */
  sequences: Record<string, FixtureSequence>;
  /** Invalid fixture files and selections that can't be served. */
  problems: string[];
  fixtures: FixtureDto[];
}

/** Lean log entry as returned by the list endpoint — no request/response bodies. */
export type LogEntryDto = Omit<LogEntry, "query" | "requestHeaders" | "requestBody" | "responseBody">;

/** Full log entry as returned by `log show <id>` — includes headers and bodies. */
export type LogEntryDetailDto = LogEntry;

export type LogQuery = LogFilter;

export class DaemonUnreachableError extends Error {}

const CONTROL_TIMEOUT_MS = 10_000;

function logQueryString(params: LogQuery, withBodies: boolean): string {
  const query = new URLSearchParams();
  if (params.route) query.set("route", params.route);
  if (params.method) query.set("method", params.method);
  if (params.since) query.set("since", params.since);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (withBodies) query.set("bodies", "1");
  return query.toString() ? `?${query}` : "";
}

/**
 * Thin HTTP client for the daemon's control API. Before every call it checks the daemon
 * runs this CLI's version and, when `expectedPid` is given (the port came from a pidfile),
 * that it is that process, so a stale pidfile never redirects a mutation to another daemon.
 */
export class ControlClient {
  private readonly base: string;

  constructor(
    private readonly port: number,
    private readonly expectedPid?: number,
  ) {
    this.base = `http://127.0.0.1:${port}${CONTROL_PREFIX}`;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health");
  }

  async routes(): Promise<RouteDto[]> {
    const data = await this.request<{ routes: RouteDto[] }>("GET", "/routes");
    return data.routes;
  }

  async route(path: string): Promise<RouteDto> {
    return this.request("GET", `/routes/show?path=${encodeURIComponent(path)}`);
  }

  /** One name sets the active fixture; several set a sequence served one per request. */
  async use(route: string, fixture: string | string[]): Promise<RouteDto> {
    return this.request("POST", "/use", { route, fixture });
  }

  async log(params: LogQuery = {}): Promise<{ count: number; entries: LogEntryDto[] }> {
    return this.request("GET", `/log${logQueryString(params, false)}`);
  }

  /** Same listing as `log`, with each entry's headers and bodies. */
  async logWithBodies(params: LogQuery = {}): Promise<{ count: number; entries: LogEntryDetailDto[] }> {
    return this.request("GET", `/log${logQueryString(params, true)}`);
  }

  async logEntry(id: string): Promise<LogEntryDetailDto> {
    return this.request("GET", `/log/${encodeURIComponent(id)}`);
  }

  async clearLog(): Promise<{ cleared: number }> {
    return this.request("POST", "/log/clear");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (path !== "/health") await this.verifyDaemon();
    return this.send<T>(method, path, body);
  }

  private async verifyDaemon(): Promise<void> {
    const health = await this.send<{ version?: string; pid?: number }>("GET", "/health");
    if (this.expectedPid !== undefined && health.pid !== this.expectedPid) {
      throw new Error(
        `this project's daemon (pid ${this.expectedPid}) is gone; port ${this.port} is answered by another ` +
          `stubway (pid ${health.pid ?? "unknown"}). Start this project's daemon with "stubway start", or pass -p.`,
      );
    }
    if (health.version !== clientVersion) {
      throw new Error(
        `the daemon on port ${this.port} runs stubway ${health.version ?? "0.1.0"} and this CLI is ${clientVersion}. ` +
          `Restart it: stubway stop && stubway start`,
      );
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new DaemonUnreachableError(
        `cannot reach stubway daemon at ${this.base} (${(err as Error).message}). Is "stubway start" running?`,
      );
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(data.error ?? `control API error ${res.status}`);
    }
    return data as T;
  }
}
