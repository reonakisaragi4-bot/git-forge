// The one reply shape every surface returns to the HTTP layer: a status, a
// body (a string, a Buffer, or null for no body) and its content type, plus
// any extra headers. Handlers never touch the socket.

export interface Reply {
  status: number;
  body: string | Buffer | null;
  contentType: string;
  headers: Record<string, string>;
}

export function jsonReply(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  const body = `${JSON.stringify(value)}\n`;
  return { status, body, contentType: 'application/json; charset=utf-8', headers };
}

export function textReply(status: number, text: string, contentType: string, headers: Record<string, string> = {}): Reply {
  return { status, body: text, contentType, headers };
}

export function bufferReply(status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): Reply {
  return { status, body, contentType, headers };
}

export function emptyReply(status: number, headers: Record<string, string> = {}): Reply {
  return { status, body: null, contentType: 'application/json; charset=utf-8', headers };
}

/** A JSON error body: always an object with a string `message`. */
export function errorReply(status: number, message: string, headers: Record<string, string> = {}): Reply {
  return jsonReply(status, { message }, headers);
}

/** Parse an Authorization header into its bearer token, or null. */
export function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('Bearer ')) return null;
  const token = trimmed.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Whether the request's bearer token is the expected one (any non-empty token when none is set). */
export function isAuthorized(headers: Record<string, string | string[] | undefined>, expected: string): boolean {
  const token = bearerToken(headers);
  if (token === null || token === '') return false;
  if (expected === '') return true;
  return token === expected;
}
