// The HTTP server: one process, one in-memory store, four surfaces. Requests
// are read whole, routed to the git / REST / GraphQL / MCP handlers, and the
// reply they return is written out. A request that throws anywhere is a JSON
// 500, never a dead process. Every reply carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { routeGit, type GitRequest } from './githttp.ts';
import { routeGraphQL } from './graphql.ts';
import { routeMcp } from './mcp.ts';
import { errorReply, jsonReply, type Reply } from './reply.ts';
import { routeRest, splitPath, type RestRequest } from './rest.ts';
import { createStore } from './store.ts';

/** Read the request body whole. GET/HEAD requests have none. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return Promise.resolve(Buffer.alloc(0));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Write one handler reply onto the socket. */
function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = {
    'content-type': reply.contentType,
    'x-github-request-id': requestId,
    ...reply.headers,
  };
  if (reply.body === null) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  if (Buffer.isBuffer(reply.body)) {
    headers['content-length'] = String(reply.body.length);
    res.writeHead(reply.status, headers);
    res.end(reply.body);
    return;
  }
  // A string body is written as-is: Buffer.byteLength sizes it without
  // allocating and copying the whole body first (2,000 read replies a round).
  headers['content-length'] = String(Buffer.byteLength(reply.body));
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}

/** Build the server. It binds nothing until the caller listens on a port. */
export function createApp(): Server {
  const store = createStore();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let nextRequestId = 1;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req-${nextRequestId}`;
    nextRequestId += 1;
    try {
      // The suite sends origin-form URLs (path + query). Splitting them by
      // hand is cheaper than a full URL parse on every request (2,000 read
      // calls a round); only a non-path URL falls back to the URL parser.
      const rawUrl = req.url ?? '/';
      let pathname: string;
      let query: URLSearchParams;
      if (rawUrl.startsWith('/')) {
        const q = rawUrl.indexOf('?');
        pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
        query = new URLSearchParams(q < 0 ? '' : rawUrl.slice(q + 1));
      } else {
        const url = new URL(rawUrl, 'http://entry');
        pathname = url.pathname;
        query = url.searchParams;
      }
      const segments = splitPath(pathname);
      const method = req.method ?? 'GET';
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
      const body = await readBody(req);

      // The env's boot check: 200 {"ok":true}.
      if (method === 'GET' && (pathname === '/healthz' || pathname === '/healthz/')) {
        sendReply(res, jsonReply(200, { ok: true }), requestId);
        return;
      }

      let reply: Reply | null = null;
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const gitRequest: GitRequest = { method, segments, query, headers, body };
        reply = routeGit({ store, expectedToken }, gitRequest);
      }
      // GraphQL v4.
      if (reply === null && segments[0] === 'api' && segments[1] === 'graphql') {
        reply = routeGraphQL({ store, host, expectedToken }, method, segments, { headers, bodyText: body.toString('utf8') });
      }
      // MCP.
      if (reply === null && segments[0] === 'mcp') {
        reply = routeMcp({ store, expectedToken, host }, method, segments, headers, body.toString('utf8'));
      }
      // REST v3.
      if (reply === null && segments[0] === 'api' && segments[1] === 'v3') {
        let parsedBody: unknown;
        let malformedBody = false;
        if (body.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            malformedBody = true;
          }
        }
        const restRequest: RestRequest = {
          method,
          segments,
          query,
          body: parsedBody,
          malformedBody,
          headers,
        };
        reply = routeRest({ store, expectedToken, host }, restRequest);
      }
      if (reply === null) reply = errorReply(404, 'Not Found');
      sendReply(res, reply, requestId);
    } catch (error) {
      // Never let one bad request kill the process.
      try {
        sendReply(res, errorReply(500, error instanceof Error ? error.message : 'Internal Server Error'), requestId);
      } catch {
        res.destroy();
      }
    }
  }

  return server;
}
