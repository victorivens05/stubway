import type { IncomingMessage, ServerResponse } from "node:http";

export interface ParsedBody {
  raw: string;
  /** Parsed JSON when the body was valid JSON; otherwise the raw string; undefined when empty. */
  value: unknown;
}

export async function readBody(req: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw, value: undefined };
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return { raw, value: raw };
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

/** Flatten Node's header bag (which may contain arrays) into a string record. */
export function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
