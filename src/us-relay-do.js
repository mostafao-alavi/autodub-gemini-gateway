import { DurableObject } from 'cloudflare:workers';
import {
  buildUpstreamUrl,
  createWebSocketRelay,
  isWebSocketUpgrade,
  jsonResponse,
  sanitizeUpstreamHeaders,
  withCorsHeaders
} from './proxy-utils.js';

export class UsGeminiRelay extends DurableObject {
  async fetch(request) {
    const isWs = isWebSocketUpgrade(request);
    const upstreamUrl = buildUpstreamUrl(request.url);
    const upstreamHeaders = sanitizeUpstreamHeaders(request.headers, { isWsUpgrade: isWs });

    if (isWs) {
      return this.handleWebSocket(upstreamUrl, upstreamHeaders);
    }

    return this.handleHttp(request, upstreamUrl, upstreamHeaders);
  }

  async handleHttp(request, upstreamUrl, upstreamHeaders) {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: hasBody ? request.body : undefined
      });

      const responseHeaders = withCorsHeaders(upstreamResp.headers);
      responseHeaders.set('X-Relay-Region', this.ctx?.id?.name || 'us-relay');

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: responseHeaders
      });
    } catch (err) {
      return jsonResponse(
        {
          error: {
            code: 502,
            message: `Upstream Gemini HTTP fetch failed: ${err?.message || String(err)}`
          }
        },
        502
      );
    }
  }

  async handleWebSocket(upstreamUrl, upstreamHeaders) {
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'GET',
        headers: upstreamHeaders
      });
    } catch (err) {
      return jsonResponse(
        {
          error: {
            code: 502,
            message: `Upstream Gemini WebSocket connect failed: ${err?.message || String(err)}`
          }
        },
        502
      );
    }

    const upstreamSocket = upstreamResp?.webSocket;
    if (!upstreamSocket) {
      const bodyText = await upstreamResp.text().catch(() => '');
      const headers = withCorsHeaders(upstreamResp.headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }
      return new Response(bodyText || 'Upstream WebSocket upgrade rejected by Gemini.', {
        status: upstreamResp.status || 502,
        headers
      });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    createWebSocketRelay(serverSocket, upstreamSocket);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket
    });
  }
}
