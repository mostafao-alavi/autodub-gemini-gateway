import {
  CORS_HEADERS,
  buildRateLimitKey,
  computeShardIndex,
  extractApiKey,
  isWebSocketUpgrade,
  jsonResponse,
  validateProxyPath
} from './proxy-utils.js';

export { UsGeminiRelay } from './us-relay-do.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'autodub-gemini-gateway',
        locationHint: env.US_LOCATION_HINT || 'wnam',
        shards: Number(env.DO_SHARD_COUNT || 8),
        edgeColo: request.cf?.colo || null,
        timestamp: new Date().toISOString()
      });
    }

    const isWs = isWebSocketUpgrade(request);
    const pathCheck = validateProxyPath(url.pathname, isWs);
    if (!pathCheck.allowed) {
      return jsonResponse(
        {
          error: {
            code: pathCheck.status || 403,
            message: pathCheck.reason
          }
        },
        pathCheck.status || 403
      );
    }

    const keyCheck = extractApiKey(request, url);
    if (!keyCheck.valid) {
      return jsonResponse(
        {
          error: {
            code: 401,
            message: keyCheck.reason
          }
        },
        401
      );
    }

    const rateKey = buildRateLimitKey(request, keyCheck.key);
    if (env.GATEWAY_RATE_LIMITER && typeof env.GATEWAY_RATE_LIMITER.limit === 'function') {
      const { success } = await env.GATEWAY_RATE_LIMITER.limit({ key: rateKey });
      if (!success) {
        return jsonResponse(
          {
            error: {
              code: 429,
              message: 'Rate limit exceeded. Please wait before opening another stream.'
            }
          },
          429
        );
      }
    }

    const shardIdx = computeShardIndex(rateKey, env.DO_SHARD_COUNT || 8);
    const locationHint = env.US_LOCATION_HINT || 'wnam';
    const id = env.US_RELAY.idFromName(`us-shard-${shardIdx}`);
    const stub = env.US_RELAY.get(id, { locationHint });

    return stub.fetch(request);
  }
};
