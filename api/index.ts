import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from '../packages/core/src/api/app.js';
import { createMemoryNetworkSource } from '../packages/core/src/data/memory.js';
import { files } from '../packages/api-worker/src/data.generated.js';

/**
 * Vercel Node function entry (shared by `/api` and `/api/*`).
 * Same Elysia app as the local Bun/Node server.
 */
let app: ReturnType<typeof createApiApp> | undefined;

function getApp(): ReturnType<typeof createApiApp> {
  app ??= createApiApp(createMemoryNetworkSource(files as never));
  return app;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Prefer the original request path when Vercel rewrites to this function. */
function resolveUrl(req: IncomingMessage): URL {
  const host = firstHeader(req.headers.host) ?? 'localhost';
  const proto = firstHeader(req.headers['x-forwarded-proto']) ?? 'https';
  const original =
    firstHeader(req.headers['x-vercel-original-url']) ??
    firstHeader(req.headers['x-original-url']) ??
    firstHeader(req.headers['x-invoke-path']) ??
    req.url ??
    '/';
  try {
    return new URL(original, `${proto}://${host}`);
  } catch {
    return new URL(req.url ?? '/', `${proto}://${host}`);
  }
}

function buildRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const url = resolveUrl(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(body ? { body, duplex: 'half' } : {})
  } as RequestInit);
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const response = await getApp().fetch(buildRequest(req, body));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('[openmetro-api]', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
  }
}
