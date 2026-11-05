import { CONTROL_PREFIX } from "./constants.js";

export interface FixtureDto {
  name: string;
  method: string;
  status: number;
  description?: string;
  timeoutMs?: number;
}

export interface RouteDto {
  path: string;
  active: Record<string, string>;
  fixtures: FixtureDto[];
}

/** Lean log entry as returned by the list endpoint — no request/response bodies. */
export interface LogEntryDto {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  matchedRoute: string | null;
  params: Record<string, string>;
  fixture: string | null;
  status: number | null;
  unmatched: boolean;
  proxied: boolean;
  durationMs: number;
}

/** Full log entry as returned by `log show <id>` — includes headers and bodies. */
export interface LogEntryDetailDto extends LogEntryDto {
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseBody: unknown;
}

export class DaemonUnreachableError extends Error {}

/** Thin HTTP client for the daemon's control API. */
export class ControlClient {
  private readonly base: string;

  constructor(port: number) {
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

  async use(route: string, fixture: string): Promise<RouteDto> {
    return this.request("POST", "/use", { route, fixture });
  }

  async log(params: { route?: string; since?: string } = {}): Promise<{ count: number; entries: LogEntryDto[] }> {
    const query = new URLSearchParams();
    if (params.route) query.set("route", params.route);
    if (params.since) query.set("since", params.since);
    const suffix = query.toString() ? `?${query}` : "";
    return this.request("GET", `/log${suffix}`);
  }

  async logEntry(id: string): Promise<LogEntryDetailDto> {
    return this.request("GET", `/log/${encodeURIComponent(id)}`);
  }

  async clearLog(): Promise<{ cleared: number }> {
    return this.request("POST", "/log/clear");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
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
