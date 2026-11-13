export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

export const ALLOWED_HTTP_PREFIXES = ['/v1beta/', '/v1alpha/'];
export const ALLOWED_WS_PREFIX = '/ws/google.ai.generativelanguage.';
const MIN_API_KEY_LENGTH = 20;

const ALLOWED_UPSTREAM_HEADERS = new Set([
  'content-type',
  'x-goog-api-key',
  'x-goog-api-client',
  'accept'
]);

const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key, x-goog-api-client, Accept',
  'Access-Control-Max-Age': '86400'
});

export function withCorsHeaders(headersInit = {}) {
  const headers = new Headers(headersInit);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  const headers = withCorsHeaders(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export function isWebSocketUpgrade(request) {
  const upgrade = request.headers.get('Upgrade');
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

export function validateProxyPath(pathname, isWsUpgrade) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    return { allowed: false, kind: null, reason: 'Invalid request path.' };
  }

  if (pathname.startsWith(ALLOWED_WS_PREFIX)) {
    if (!isWsUpgrade) {
      return {
        allowed: false,
        kind: 'ws',
        status: 426,
        reason: 'WebSocket endpoint requires Upgrade: websocket header.'
      };
    }
    return { allowed: true, kind: 'ws' };
  }

  if (ALLOWED_HTTP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (isWsUpgrade) {
      return {
        allowed: false,
        kind: 'http',
        status: 400,
        reason: 'WebSocket upgrade is not valid on REST endpoints.'
      };
    }
    return { allowed: true, kind: 'http' };
  }

  return {
    allowed: false,
    kind: null,
    status: 403,
    reason: 'Path is not on the Gemini API allowlist.'
  };
}

export function extractApiKey(request, url) {
  const queryKey = (url.searchParams.get('key') || '').trim();
  const headerKey = (request.headers.get('x-goog-api-key') || '').trim();
  const key = queryKey || headerKey;

  if (!key) {
    return { valid: false, reason: 'Missing Gemini API key (?key= or x-goog-api-key).' };
  }

  if (key.length < MIN_API_KEY_LENGTH || /\s/.test(key)) {
    return { valid: false, reason: 'Malformed Gemini API key.' };
  }

  return { valid: true, key };
}

export function buildRateLimitKey(request, apiKey) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown-ip';
  const keyPrefix = apiKey.slice(0, 12);
  return `${ip}:${keyPrefix}`;
}

export function computeShardIndex(key, shardCount = 8) {
  const count = Number.isFinite(Number(shardCount)) && Number(shardCount) > 0
    ? Math.floor(Number(shardCount))
    : 8;

  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function buildUpstreamUrl(requestUrl, baseOrigin = GEMINI_ORIGIN) {
  const incoming = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  const upstream = new URL(incoming.pathname + incoming.search, baseOrigin);
  return upstream.toString();
}

export function sanitizeUpstreamHeaders(incomingHeaders, { isWsUpgrade = false } = {}) {
  const headers = new Headers();
  const src = new Headers(incomingHeaders);

  for (const [key, value] of src.entries()) {
    const lower = key.toLowerCase();
    if (ALLOWED_UPSTREAM_HEADERS.has(lower)) {
      headers.set(lower, value);
    }
  }

  if (isWsUpgrade) {
    headers.set('Upgrade', 'websocket');
  }

  return headers;
}

export function normalizeCloseCode(code) {
  const numeric = Number(code);
  if (!Number.isInteger(numeric)) return 1000;
  if (RESERVED_CLOSE_CODES.has(numeric)) {
    return numeric === 1005 ? 1000 : 1011;
  }
  if (numeric === 1000 || (numeric >= 3000 && numeric <= 4999)) {
    return numeric;
  }
  if (numeric >= 1001 && numeric <= 1014) {
    return numeric;
  }
  return 1000;
}

export function truncateCloseReason(reason, maxBytes = 120) {
  if (!reason || typeof reason !== 'string') return '';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(reason);
  if (bytes.length <= maxBytes) return reason;

  let end = reason.length;
  while (end > 0 && encoder.encode(reason.slice(0, end)).length > maxBytes) {
    end--;
  }
  return reason.slice(0, end);
}

export function safeCloseWebSocket(socket, code = 1000, reason = '') {
  if (!socket) return;
  try {
    const safeCode = normalizeCloseCode(code);
    const safeReason = truncateCloseReason(reason);
    socket.close(safeCode, safeReason);
  } catch {
    try {
      socket.close();
    } catch {
      // Socket already closed
    }
  }
}

/**
 * Bridges bidirectional messages, close events, and errors between client and upstream WebSockets.
 * Accepts both sockets so frame forwarding starts immediately without race conditions.
 */
export function createWebSocketRelay(clientServerSocket, upstreamSocket) {
  let closed = false;

  if (typeof upstreamSocket.accept === 'function') {
    upstreamSocket.accept();
  }
  if (typeof clientServerSocket.accept === 'function') {
    clientServerSocket.accept();
  }

  const closeBoth = (code, reason) => {
    if (closed) return;
    closed = true;
    safeCloseWebSocket(clientServerSocket, code, reason);
    safeCloseWebSocket(upstreamSocket, code, reason);
  };

  clientServerSocket.addEventListener('message', (event) => {
    if (closed) return;
    try {
      upstreamSocket.send(event.data);
    } catch {
      closeBoth(1011, 'Upstream send failed');
    }
  });

  upstreamSocket.addEventListener('message', (event) => {
    if (closed) return;
    try {
      clientServerSocket.send(event.data);
    } catch {
      closeBoth(1011, 'Client send failed');
    }
  });

  clientServerSocket.addEventListener('close', (event) => {
    closeBoth(event?.code ?? 1000, event?.reason || '');
  });

  upstreamSocket.addEventListener('close', (event) => {
    closeBoth(event?.code ?? 1000, event?.reason || '');
  });

  clientServerSocket.addEventListener('error', () => {
    closeBoth(1011, 'Client socket error');
  });

  upstreamSocket.addEventListener('error', () => {
    closeBoth(1011, 'Upstream socket error');
  });

  return {
    isClosed: () => closed,
    closeBoth
  };
}
