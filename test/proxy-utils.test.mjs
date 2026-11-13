import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRateLimitKey,
  buildUpstreamUrl,
  computeShardIndex,
  createWebSocketRelay,
  extractApiKey,
  normalizeCloseCode,
  sanitizeUpstreamHeaders,
  truncateCloseReason,
  validateProxyPath
} from '../src/proxy-utils.js';

function createMockSocket() {
  const listeners = new Map();
  return {
    accepted: false,
    sent: [],
    closedWith: null,
    accept() {
      this.accepted = true;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    emit(type, event) {
      for (const fn of listeners.get(type) || []) {
        fn(event);
      }
    },
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closedWith = { code, reason };
    }
  };
}

test('validateProxyPath allows Gemini REST and WebSocket endpoints only', () => {
  assert.deepEqual(validateProxyPath('/v1beta/models', false), { allowed: true, kind: 'http' });
  assert.deepEqual(validateProxyPath('/v1alpha/models/foo:generateContent', false), { allowed: true, kind: 'http' });
  assert.deepEqual(
    validateProxyPath('/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', true),
    { allowed: true, kind: 'ws' }
  );

  const missingUpgrade = validateProxyPath(
    '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    false
  );
  assert.equal(missingUpgrade.allowed, false);
  assert.equal(missingUpgrade.status, 426);

  const wsOnRest = validateProxyPath('/v1beta/models', true);
  assert.equal(wsOnRest.allowed, false);
  assert.equal(wsOnRest.status, 400);

  const blocked = validateProxyPath('/etc/passwd', false);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 403);
});

test('extractApiKey validates query or header key before Durable Object routing', () => {
  const reqNoHeader = new Request('https://gw.example.com/v1beta/models?key=AIzaSyTestKey1234567890');
  assert.deepEqual(extractApiKey(reqNoHeader, new URL(reqNoHeader.url)), {
    valid: true,
    key: 'AIzaSyTestKey1234567890'
  });

  const reqHeader = new Request('https://gw.example.com/v1beta/models', {
    headers: { 'x-goog-api-key': 'AQ.Ab8RN6TestHeaderKey12345' }
  });
  assert.deepEqual(extractApiKey(reqHeader, new URL(reqHeader.url)), {
    valid: true,
    key: 'AQ.Ab8RN6TestHeaderKey12345'
  });

  const reqMissing = new Request('https://gw.example.com/v1beta/models');
  assert.equal(extractApiKey(reqMissing, new URL(reqMissing.url)).valid, false);

  const reqShort = new Request('https://gw.example.com/v1beta/models?key=short');
  assert.equal(extractApiKey(reqShort, new URL(reqShort.url)).valid, false);
});

test('sanitizeUpstreamHeaders strips client IP/origin headers and preserves API headers', () => {
  const sanitized = sanitizeUpstreamHeaders(
    {
      origin: 'chrome-extension://abcdef',
      referer: 'https://www.youtube.com/watch?v=123',
      'cf-connecting-ip': '1.2.3.4',
      'cf-ipcountry': 'IR',
      'x-forwarded-for': '1.2.3.4',
      cookie: 'session=abc',
      'content-type': 'application/json',
      'x-goog-api-key': 'AIzaSySecret1234567890123'
    },
    { isWsUpgrade: true }
  );

  assert.equal(sanitized.has('origin'), false);
  assert.equal(sanitized.has('referer'), false);
  assert.equal(sanitized.has('cf-connecting-ip'), false);
  assert.equal(sanitized.has('cf-ipcountry'), false);
  assert.equal(sanitized.has('x-forwarded-for'), false);
  assert.equal(sanitized.has('cookie'), false);
  assert.equal(sanitized.get('content-type'), 'application/json');
  assert.equal(sanitized.get('x-goog-api-key'), 'AIzaSySecret1234567890123');
  assert.equal(sanitized.get('upgrade'), 'websocket');
});

test('buildUpstreamUrl preserves pathname and query string', () => {
  assert.equal(
    buildUpstreamUrl('https://gemini.my-domain.com/v1beta/models?key=abc123&pageSize=10'),
    'https://generativelanguage.googleapis.com/v1beta/models?key=abc123&pageSize=10'
  );
});

test('computeShardIndex deterministically stays within shard bounds', () => {
  for (const key of ['ip1:key1', 'ip2:key2', 'ip3:key3', 'ip4:key4']) {
    const idx = computeShardIndex(key, 8);
    assert.ok(idx >= 0 && idx < 8);
    assert.equal(idx, computeShardIndex(key, 8));
  }
});

test('buildRateLimitKey scopes by client IP and key prefix', () => {
  const req = new Request('https://gw.example.com/v1beta/models', {
    headers: { 'cf-connecting-ip': '203.0.113.9' }
  });
  assert.equal(buildRateLimitKey(req, 'AQ.Ab8RN6LongApiKeyValueHere'), '203.0.113.9:AQ.Ab8RN6Lon');
});

test('normalizeCloseCode and truncateCloseReason enforce RFC 6455 constraints', () => {
  assert.equal(normalizeCloseCode(1000), 1000);
  assert.equal(normalizeCloseCode(1005), 1000);
  assert.equal(normalizeCloseCode(1006), 1011);
  assert.equal(normalizeCloseCode(1015), 1011);
  assert.equal(normalizeCloseCode(1007), 1007);
  assert.equal(normalizeCloseCode(4001), 4001);

  const longPersian = 'خطا '.repeat(60);
  const truncated = truncateCloseReason(longPersian, 120);
  assert.ok(new TextEncoder().encode(truncated).length <= 120);
});

test('createWebSocketRelay forwards messages bidirectionally and maps reserved close codes', () => {
  const clientServer = createMockSocket();
  const upstream = createMockSocket();
  const relay = createWebSocketRelay(clientServer, upstream);

  assert.equal(clientServer.accepted, true);
  assert.equal(upstream.accepted, true);

  clientServer.emit('message', { data: '{"setup":{"model":"models/gemini-3.5-live-translate-preview"}}' });
  upstream.emit('message', { data: '{"setupComplete":{}}' });

  assert.deepEqual(upstream.sent, ['{"setup":{"model":"models/gemini-3.5-live-translate-preview"}}']);
  assert.deepEqual(clientServer.sent, ['{"setupComplete":{}}']);

  upstream.emit('close', { code: 1006, reason: 'network drop' });
  assert.equal(relay.isClosed(), true);
  assert.deepEqual(clientServer.closedWith, { code: 1011, reason: 'network drop' });
  assert.deepEqual(upstream.closedWith, { code: 1011, reason: 'network drop' });
});
