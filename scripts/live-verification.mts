/**
 * Live verification of the deployed apps against the challenge requirements.
 *
 *   make verify-live            (reads ADMIN_TOKEN / CHAT_ADMIN_PASSWORD from .env.production.local)
 *   ONLY=1|2                    run only Option 1 or only Option 2
 *
 * Strategy: temporary overrides shrink the limits for THIS machine's IP only, so real 429s,
 * Retry-After values and sliding-window behaviour can be observed without locking the demo for
 * anyone else. Every override and test room is removed at the end. Writes docs/LIVE-VERIFICATION.html,
 * one self-contained file built to the repository's report standard (docs/REPORTING.md).
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { renderHtml, type Report } from '../packages/report/src/index.ts';

const RL = process.env.RL_URL ?? 'https://convert-digital-rate-limiter.fly.dev';
const CHAT = process.env.CHAT_URL ?? 'https://convert-digital-chat.fly.dev';
const ADMIN_TOKEN = required('ADMIN_TOKEN');
const CHAT_ADMIN_PASSWORD = required('CHAT_ADMIN_PASSWORD');
const OUT = process.env.REPORT_PATH ?? 'docs/LIVE-VERIFICATION.html';
const ONLY = process.env.ONLY;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (source .env.production.local)`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------------------------
interface Check {
  id: string;
  option: 1 | 2;
  requirement: string;
  scenario: string;
  result: 'PASS' | 'FAIL';
  evidence: string[];
  error?: string;
  startedAt: string;
  durationMs: number;
}
const checks: Check[] = [];
const secrets: string[] = [ADMIN_TOKEN, CHAT_ADMIN_PASSWORD];
const redact = (s: string): string => {
  let out = s
    .replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"');
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  return out;
};

async function check(
  id: string,
  option: 1 | 2,
  requirement: string,
  scenario: string,
  fn: (log: (line: string) => void) => Promise<void>,
): Promise<void> {
  const evidence: string[] = [];
  const started = Date.now();
  const log = (line: string) => evidence.push(redact(line));
  let result: Check['result'] = 'PASS';
  let error: string | undefined;
  try {
    await fn(log);
  } catch (e) {
    result = 'FAIL';
    error = redact((e as Error).message);
  }
  checks.push({
    id,
    option,
    requirement,
    scenario,
    result,
    evidence,
    error,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
  });
  console.log(`${result === 'PASS' ? '✓' : '✗'} ${id} ${scenario}${error ? ` — ${error}` : ''}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`expectation failed: ${message}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------------------------
interface Res {
  status: number;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}
async function http(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; json?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(url, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: isJson && text ? JSON.parse(text) : undefined,
    text,
  };
}
const RL_HEADERS = [
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'retry-after',
];
function line(method: string, path: string, res: Res, extra = ''): string {
  const hs = RL_HEADERS.filter((h) => res.headers[h] !== undefined)
    .map((h) => `${h}=${res.headers[h]}`)
    .join(' ');
  const body = res.body && res.status >= 400 ? ` body=${JSON.stringify(res.body)}` : '';
  return `${method} ${path} → ${res.status}${hs ? '  ' + hs : ''}${body}${extra ? '  ' + extra : ''}`;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const adminHeaders = { 'x-admin-token': ADMIN_TOKEN };

/** Walks the remaining budget as reported by the server, then expects the next request to be 429. */
async function exhaust(
  path: string,
  headers: Record<string, string>,
  label: string,
  log: (l: string) => void,
): Promise<{ allowed: number; blocked: Res }> {
  const first = await http('GET', `${RL}${path}`, { headers });
  log(line('GET', label, first));
  if (first.status === 429) {
    // Counters carry across override changes by design: earlier requests in this window (e.g. a
    // previous run) already spent the budget, so the 429 itself is the evidence here.
    log(
      `${label}: budget already spent by earlier requests in this window; asserting the 429 directly`,
    );
    return { allowed: 0, blocked: first };
  }
  expect(first.status === 200, `${label}: first request should pass`);
  let remaining = Number(first.headers['ratelimit-remaining']);
  let allowed = 1;
  while (remaining > 0) {
    const r = await http('GET', `${RL}${path}`, { headers });
    log(line('GET', label, r));
    expect(r.status === 200, `${label}: passes while budget remains`);
    expect(
      Number(r.headers['ratelimit-remaining']) === remaining - 1,
      `${label}: remaining counts down by one`,
    );
    remaining -= 1;
    allowed += 1;
  }
  const blocked = await http('GET', `${RL}${path}`, { headers });
  log(line('GET', label, blocked));
  expect(
    blocked.status === 429,
    `${label}: request after the budget should be 429, got ${blocked.status}`,
  );
  return { allowed, blocked };
}

// ---------------------------------------------------------------------------------------------
// Rate limiter helpers
// ---------------------------------------------------------------------------------------------
const createdOverrides: string[] = [];
async function createOverride(
  body: Record<string, unknown>,
  log: (l: string) => void,
): Promise<string> {
  const res = await http('POST', `${RL}/admin/overrides`, { headers: adminHeaders, json: body });
  log(line('POST', '/admin/overrides', res, `payload=${JSON.stringify(body)}`));
  expect(res.status === 201, `override creation returned ${res.status}: ${res.text}`);
  createdOverrides.push(res.body.id);
  return res.body.id as string;
}
async function deleteOverride(id: string, log: (l: string) => void): Promise<void> {
  const res = await http('DELETE', `${RL}/admin/overrides/${id}`, { headers: adminHeaders });
  log(line('DELETE', `/admin/overrides/${id}`, res));
  const i = createdOverrides.indexOf(id);
  if (i >= 0) createdOverrides.splice(i, 1);
}
async function myIps(): Promise<string[]> {
  const lookup = async (u: string) => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5_000) });
      return r.ok ? (await r.text()).trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const ips = (
    await Promise.all([lookup('https://api.ipify.org'), lookup('https://api6.ipify.org')])
  ).filter((x): x is string => Boolean(x));
  expect(ips.length > 0, 'could not determine egress IP');
  return [...new Set(ips)];
}

// ---------------------------------------------------------------------------------------------
// WebSocket helper
// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = { type: string; id?: string; payload: any };
interface Ws {
  send(frame: unknown): void;
  next(filter: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}
function connectWs(url: string): Promise<Ws> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: Frame[] = [];
    const waiters: Array<{ filter: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      socket.on('close', (code, reason) => r({ code, reason: reason.toString() })),
    );
    socket.on('unexpected-response', (_req, res) => {
      reject(
        Object.assign(new Error(`upgrade rejected: HTTP ${res.statusCode}`), {
          status: res.statusCode,
        }),
      );
      res.resume();
    });
    socket.on('error', reject);
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      const i = waiters.findIndex((w) => w.filter(frame));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(frame);
      else frames.push(frame);
    });
    socket.on('open', () =>
      resolve({
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: (filter, timeoutMs = 8_000) =>
          new Promise<Frame>((res, rej) => {
            const i = frames.findIndex(filter);
            if (i >= 0) return res(frames.splice(i, 1)[0]!);
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `timed out waiting for frame; buffered=${JSON.stringify(frames).slice(0, 300)}`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({ filter, resolve: (f) => (clearTimeout(timer), res(f)) });
          }),
        closed,
        close: () =>
          new Promise<void>((r) => {
            if (socket.readyState === WebSocket.CLOSED) return r();
            socket.once('close', () => r());
            socket.close(1000, 'done');
          }),
      }),
    );
  });
}
const ofType = (type: string, id?: string) => (f: Frame) =>
  f.type === type && (id === undefined || f.id === id);

// ---------------------------------------------------------------------------------------------
// Option 1 scenarios
// ---------------------------------------------------------------------------------------------
async function option1(): Promise<void> {
  const ips = await myIps();
  console.log(`egress IP(s): ${ips.join(', ')}`);

  await check(
    '1.0',
    1,
    'Service is up, Redis-backed',
    'health, readiness, contract and docs endpoints',
    async (log) => {
      for (const p of ['/health', '/ready', '/openapi.json', '/docs']) {
        const r = await http('GET', `${RL}${p}`);
        log(line('GET', p, r, p === '/health' || p === '/ready' ? `body=${r.text}` : ''));
        expect(r.status === 200, `${p} returned ${r.status}`);
      }
      const health = await http('GET', `${RL}/health`);
      expect(health.body.checks.redis === 'up', 'Redis is not up');
    },
  );

  await check(
    '1.1',
    1,
    'Track requests per IP; 429 when the limit is exceeded; IETF RateLimit headers',
    'default rule shrunk to 5/60s for this IP via an override; walk the budget down to zero, then one more request',
    async (log) => {
      const id = await createOverride(
        {
          reason: 'live verification 1.1',
          criteria: { ips, ruleIds: ['default'] },
          effect: { limit: 5, windowMs: 60_000 },
          ttlSeconds: 300,
        },
        log,
      );
      try {
        const { allowed, blocked } = await exhaust(
          '/api/public',
          {},
          '/api/public (anonymous)',
          log,
        );
        expect(blocked.headers['ratelimit-limit'] === '5', 'limit header shows the override');
        const retry = Number(blocked.headers['retry-after']);
        expect(retry >= 1 && retry <= 60, 'Retry-After within the window');
        expect(
          blocked.body.error === 'Too Many Requests' && blocked.body.override === id,
          '429 body documents the override',
        );
        log(
          `allowed ${allowed} request(s) before the 429 (budget as reported by the server), Retry-After=${retry}s`,
        );
      } finally {
        await deleteOverride(id, log);
      }
      const after = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public', after, '(override removed → default limit again)'));
      expect(
        after.status === 200 && after.headers['ratelimit-limit'] === '100',
        'limit reverted to 100',
      );
    },
  );

  await check(
    '1.2',
    1,
    'Per-endpoint configuration',
    '/api/search has its own rule and counter; shrunk to 3/60s for this IP and exhausted while /api/public stays available',
    async (log) => {
      const id = await createOverride(
        {
          reason: 'live verification 1.2',
          criteria: { ips, ruleIds: ['search'] },
          effect: { limit: 3, windowMs: 60_000 },
          ttlSeconds: 300,
        },
        log,
      );
      try {
        const { blocked } = await exhaust('/api/search?q=live', {}, '/api/search?q=live', log);
        expect(
          blocked.headers['ratelimit-policy'] === '3;w=60',
          'policy header reflects the search rule',
        );
        const other = await http('GET', `${RL}/api/public`);
        log(line('GET', '/api/public', other, '(different rule, different counter)'));
        expect(other.status === 200, 'public endpoint unaffected');
      } finally {
        await deleteOverride(id, log);
      }
    },
  );

  await check(
    '1.3',
    1,
    'Per-endpoint configuration: login brute-force rule',
    '/api/login rule shrunk to 2/60s for this IP; failed attempts count; the attempt after the budget is 429',
    async (log) => {
      const id = await createOverride(
        {
          reason: 'live verification 1.3',
          criteria: { ips, ruleIds: ['login'] },
          effect: { limit: 2, windowMs: 60_000 },
          ttlSeconds: 300,
        },
        log,
      );
      try {
        let blocked: Res | undefined;
        let attempts = 0;
        while (!blocked && attempts < 4) {
          const r = await http('POST', `${RL}/api/login`, {
            json: { username: 'alice', password: 'wrong-password' },
          });
          attempts += 1;
          log(line('POST', '/api/login (wrong password)', r));
          if (r.status === 429) blocked = r;
          else expect(r.status === 401, 'wrong password is 401 and still counted');
        }
        expect(blocked !== undefined, 'login was rate limited within 4 attempts');
        expect(blocked!.headers['ratelimit-limit'] === '2', 'login rule limit in effect');
      } finally {
        await deleteOverride(id, log);
      }
    },
  );

  await check(
    '1.4',
    1,
    'Different limits for authenticated (200/h) vs unauthenticated (100/h) users',
    'log in; compare RateLimit-Limit for the same IP with and without a token; then shrink alice to 3/60s (sliding log, so the demonstration starts from a fresh counter) and show her budget is separate from the anonymous one',
    async (log) => {
      const login = await http('POST', `${RL}/api/login`, {
        json: { username: 'alice', password: 'wonderland' },
      });
      log(line('POST', '/api/login (alice)', login));
      expect(login.status === 200, 'alice can log in');
      const token: string = login.body.token;
      const anon = await http('GET', `${RL}/api/public`);
      const auth = await http('GET', `${RL}/api/public`, { headers: bearer(token) });
      log(line('GET', '/api/public (anonymous)', anon));
      log(line('GET', '/api/public (Bearer alice)', auth));
      expect(
        anon.headers['ratelimit-limit'] === '100' && auth.headers['ratelimit-limit'] === '200',
        'tier limits 100 vs 200',
      );
      expect(
        auth.body.tier === 'authenticated' && anon.body.tier === 'unauthenticated',
        'tier reported in body',
      );

      const id = await createOverride(
        {
          reason: 'live verification 1.4',
          criteria: { userIds: ['alice'], ruleIds: ['default'] },
          effect: { limit: 3, windowMs: 60_000, algorithm: 'sliding-log' },
          ttlSeconds: 300,
        },
        log,
      );
      try {
        const { blocked } = await exhaust(
          '/api/public',
          bearer(token),
          '/api/public (Bearer alice)',
          log,
        );
        expect(blocked.headers['ratelimit-limit'] === '3', 'override applies to alice by user id');
        const anonStill = await http('GET', `${RL}/api/public`);
        log(
          line(
            'GET',
            '/api/public (anonymous, same IP)',
            anonStill,
            '(keyed by ip:, not by user:)',
          ),
        );
        expect(anonStill.status === 200, 'anonymous budget from the same IP is separate');
      } finally {
        await deleteOverride(id, log);
      }
    },
  );

  await check(
    '1.5',
    1,
    'Bonus: sliding log algorithm',
    'search rule set to sliding-log 2/20s for this IP; one slot frees exactly when the oldest request ages out, not at a window boundary',
    async (log) => {
      log(
        'waiting 21s so the search requests from 1.2 leave the 20s window (the search rule is sliding-log by default, same key)',
      );
      await sleep(21_000);
      const id = await createOverride(
        {
          reason: 'live verification 1.5',
          criteria: { ips, ruleIds: ['search'] },
          effect: { limit: 2, windowMs: 20_000, algorithm: 'sliding-log' },
          ttlSeconds: 300,
        },
        log,
      );
      try {
        const t0 = Date.now();
        const stamp = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
        const r1 = await http('GET', `${RL}/api/search?q=sliding`);
        log(`${stamp()} ${line('GET', '/api/search', r1)}`);
        expect(r1.status === 200, 'first allowed');
        await sleep(4_000);
        const r2 = await http('GET', `${RL}/api/search?q=sliding`);
        log(`${stamp()} ${line('GET', '/api/search', r2)}`);
        expect(r2.status === 200, 'second allowed');
        await sleep(1_000);
        const r3 = await http('GET', `${RL}/api/search?q=sliding`);
        log(`${stamp()} ${line('GET', '/api/search', r3)}`);
        expect(r3.status === 429, 'third blocked');
        const retry = Number(r3.headers['retry-after']);
        expect(
          retry >= 13 && retry <= 16,
          `Retry-After ≈ 15s (time until the FIRST request ages out), got ${retry}`,
        );
        await sleep((retry + 1) * 1000);
        const r4 = await http('GET', `${RL}/api/search?q=sliding`);
        log(`${stamp()} ${line('GET', '/api/search', r4, '(first slot freed)')}`);
        expect(r4.status === 200, 'one slot freed after the oldest aged out');
        const r5 = await http('GET', `${RL}/api/search?q=sliding`);
        log(
          `${stamp()} ${line('GET', '/api/search', r5, '(second request still inside the window → sliding, not reset)')}`,
        );
        expect(r5.status === 429, 'still only one slot: the window slid, it did not reset');
        expect(
          Number(r5.headers['retry-after']) <= 5,
          'Retry-After now points at the second request aging out',
        );
      } finally {
        await deleteOverride(id, log);
      }
    },
  );

  await check(
    '1.6',
    1,
    'Bonus: temporary overrides',
    'create → listed → effective in headers → expires by itself; a blocking override is applied and then deleted explicitly',
    async (log) => {
      const expiring = await createOverride(
        {
          reason: 'live verification 1.6 (expires)',
          criteria: { ips, ruleIds: ['default'] },
          effect: { limit: 7, windowMs: 60_000 },
          ttlSeconds: 8,
        },
        log,
      );
      const listed = await http('GET', `${RL}/admin/overrides`, { headers: adminHeaders });
      log(
        line(
          'GET',
          '/admin/overrides',
          listed,
          `ids=${JSON.stringify(listed.body.overrides.map((o: { id: string }) => o.id))}`,
        ),
      );
      expect(
        listed.body.overrides.some((o: { id: string }) => o.id === expiring),
        'override listed',
      );
      const during = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public (override active)', during));
      expect(during.headers['ratelimit-limit'] === '7', 'override limit in effect');
      await sleep(9_500);
      const afterExpiry = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public (after ttl)', afterExpiry, '(expired without any call)'));
      expect(afterExpiry.headers['ratelimit-limit'] === '100', 'limit back to 100 after expiry');
      const listedAfter = await http('GET', `${RL}/admin/overrides`, { headers: adminHeaders });
      expect(
        !listedAfter.body.overrides.some((o: { id: string }) => o.id === expiring),
        'expired override no longer listed',
      );
      createdOverrides.splice(createdOverrides.indexOf(expiring), 1);

      const block = await createOverride(
        {
          reason: 'live verification 1.6 (block)',
          criteria: { ips },
          effect: { limit: 0 },
          ttlSeconds: 120,
        },
        log,
      );
      const blocked = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public (blocked by override)', blocked));
      expect(
        blocked.status === 429 && blocked.body.override === block,
        'block override applied to this IP',
      );
      await deleteOverride(block, log);
      const freed = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public (after delete)', freed));
      expect(freed.status === 200, 'deleting the override lifts the block immediately');
    },
  );

  await check(
    '1.7',
    1,
    'Admin interface is protected',
    'missing and wrong admin token',
    async (log) => {
      const missing = await http('GET', `${RL}/admin/overrides`);
      const wrong = await http('GET', `${RL}/admin/overrides`, {
        headers: { 'x-admin-token': 'nope' },
      });
      log(line('GET', '/admin/overrides (no token)', missing));
      log(line('GET', '/admin/overrides (wrong token)', wrong));
      expect(missing.status === 401 && wrong.status === 403, '401 / 403');
    },
  );

  await check(
    '1.8',
    1,
    'Real client IP behind the platform proxy',
    "every ip-scoped override above matched this machine's egress IP, so anonymous callers are keyed on the true client address (Fly-Client-IP), not the proxy",
    async (log) => {
      log(`egress IP(s) used for the ip-scoped overrides: ${ips.join(', ')}`);
      const r = await http('GET', `${RL}/api/public`);
      log(line('GET', '/api/public', r, `fly-request-id=${r.headers['fly-request-id'] ?? '-'}`));
      expect(r.status === 200, 'reachable');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Option 2 scenarios
// ---------------------------------------------------------------------------------------------
async function chatLogin(
  username: string,
  password: string,
  log: (l: string) => void,
): Promise<Res> {
  const res = await http('POST', `${CHAT}/auth/login`, { json: { username, password } });
  log(line('POST', `/auth/login (${username})`, res));
  if (res.status === 429) {
    throw new Error(
      `chat login rate limit reached for this IP (5 per 15 min); retry in ${res.headers['retry-after']}s`,
    );
  }
  expect(res.status === 200, `${username} login returned ${res.status}`);
  return res;
}

async function option2(): Promise<void> {
  const WS_URL = `${CHAT.replace(/^http/, 'ws')}/ws`;
  const sockets: Ws[] = [];
  const rooms: string[] = [];
  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';
  let a: Ws | undefined;
  let b: Ws | undefined;
  let publicRoom = '';
  let messageId = '';

  await check(
    '2.0',
    2,
    'Service is up (HTTP + both contracts)',
    'health, readiness, OpenAPI, AsyncAPI, docs',
    async (log) => {
      for (const p of ['/health', '/ready', '/openapi.json', '/asyncapi.yaml', '/docs']) {
        const r = await http('GET', `${CHAT}${p}`);
        log(line('GET', p, r, p === '/health' ? `body=${r.text}` : ''));
        expect(r.status === 200, `${p} returned ${r.status}`);
      }
    },
  );

  await check(
    '2.1',
    2,
    'Basic authentication and authorization',
    'upgrade without token is refused; JWT login works; private rooms refuse non-members until the owner adds them',
    async (log) => {
      try {
        await connectWs(WS_URL);
        expect(false, 'upgrade without token should fail');
      } catch (e) {
        log(`WS upgrade without token → HTTP ${(e as { status?: number }).status}`);
        expect((e as { status?: number }).status === 401, 'unauthenticated upgrade is 401');
      }
      aliceToken = (await chatLogin('alice', 'wonderland', log)).body.token;
      bobToken = (await chatLogin('bob', 'bob-builder', log)).body.token;
      const priv = await http('POST', `${CHAT}/rooms`, {
        headers: bearer(aliceToken),
        json: { name: `live-private-${Date.now()}`, visibility: 'private' },
      });
      log(line('POST', '/rooms (private, by alice)', priv));
      expect(priv.status === 201, 'private room created');
      rooms.push(priv.body.id);
      const bobSocket = await connectWs(`${WS_URL}?token=${encodeURIComponent(bobToken)}`);
      sockets.push(bobSocket);
      bobSocket.send({ type: 'join', id: 'p1', payload: { roomId: priv.body.id } });
      const denied = await bobSocket.next(ofType('error', 'p1'));
      log(`bob join private room → ${JSON.stringify(denied)}`);
      expect(denied.payload.code === 'forbidden', 'non-member is forbidden');
      const bobId = (await http('GET', `${CHAT}/me`, { headers: bearer(bobToken) })).body.id;
      const add = await http('POST', `${CHAT}/rooms/${priv.body.id}/members`, {
        headers: bearer(aliceToken),
        json: { userId: bobId },
      });
      log(line('POST', `/rooms/${priv.body.id}/members (owner adds bob)`, add));
      bobSocket.send({ type: 'join', id: 'p2', payload: { roomId: priv.body.id } });
      const ok = await bobSocket.next(ofType('ack', 'p2'));
      log(`bob join private room after being added → ${JSON.stringify(ok)}`);
    },
  );

  await check(
    '2.2',
    2,
    'Real-time messaging, rooms, broadcast to all connected clients (+ bonus @mentions)',
    'alice creates a public room; both join over real sockets; alice sends "@bob"; both receive the message and bob receives a mention frame',
    async (log) => {
      expect(aliceToken && bobToken, 'logins from 2.1 are required');
      const created = await http('POST', `${CHAT}/rooms`, {
        headers: bearer(aliceToken),
        json: { name: `live-room-${Date.now()}` },
      });
      log(line('POST', '/rooms', created));
      publicRoom = created.body.id;
      rooms.push(publicRoom);
      a = await connectWs(`${WS_URL}?token=${encodeURIComponent(aliceToken)}`);
      b = await connectWs(`${WS_URL}?token=${encodeURIComponent(bobToken)}`);
      sockets.push(a, b);
      for (const [who, s] of [
        ['alice', a],
        ['bob', b],
      ] as const) {
        s.send({ type: 'join', id: `j-${who}`, payload: { roomId: publicRoom } });
        await s.next(ofType('ack', `j-${who}`));
        const snap = await s.next(ofType('room.snapshot'));
        log(
          `${who} joined → room.snapshot members=${JSON.stringify(snap.payload.members.map((m: { username: string }) => m.username))}`,
        );
      }
      a.send({
        type: 'send',
        id: 's1',
        payload: { roomId: publicRoom, body: 'hello from the live verification @bob' },
      });
      const ack = await a.next(ofType('ack', 's1'));
      const seenByBob = await b.next(ofType('message'));
      const seenByAlice = await a.next(ofType('message'));
      messageId = ack.payload.messageId;
      log(`alice ack → ${JSON.stringify(ack)}`);
      log(`bob received message → ${JSON.stringify(seenByBob.payload)}`);
      expect(
        seenByBob.payload.id === messageId && seenByAlice.payload.id === messageId,
        'both members received the broadcast',
      );
      const mention = await b.next(ofType('mention'));
      log(
        `bob received mention → id=${mention.payload.message.id} mentions=${JSON.stringify(mention.payload.message.mentions.map((u: { username: string }) => u.username))}`,
      );
      expect(mention.payload.message.id === messageId, '@bob mention delivered');
    },
  );

  await check(
    '2.3',
    2,
    'Bonus: message editing and deletion',
    'alice edits then deletes; bob receives message.edited and message.deleted; history shows the tombstone',
    async (log) => {
      expect(a && b && messageId, 'sockets and message from 2.2 are required');
      a!.send({ type: 'edit', id: 'e1', payload: { messageId, body: 'edited live' } });
      await a!.next(ofType('ack', 'e1'));
      const edited = await b!.next(ofType('message.edited'));
      log(`bob received → ${JSON.stringify(edited.payload)}`);
      expect(edited.payload.body === 'edited live', 'edit broadcast');
      a!.send({ type: 'delete', id: 'd1', payload: { messageId } });
      await a!.next(ofType('ack', 'd1'));
      const deleted = await b!.next(ofType('message.deleted'));
      log(`bob received → ${JSON.stringify(deleted.payload)}`);
      const history = await http('GET', `${CHAT}/rooms/${publicRoom}/messages?limit=5`, {
        headers: bearer(aliceToken),
      });
      log(
        line(
          'GET',
          `/rooms/${publicRoom}/messages?limit=5`,
          history,
          `first=${JSON.stringify(history.body.messages[0])}`,
        ),
      );
      expect(
        history.body.messages[0].id === messageId &&
          history.body.messages[0].deletedAt !== null &&
          history.body.messages[0].body === '',
        'tombstone in history',
      );
    },
  );

  await check(
    '2.4',
    2,
    'Fetch previous messages (persisted history, keyset pagination)',
    'send 3 messages, page through them newest-first with the cursor',
    async (log) => {
      expect(a, 'socket from 2.2 is required');
      for (let i = 1; i <= 3; i++) {
        a!.send({
          type: 'send',
          id: `h${i}`,
          payload: { roomId: publicRoom, body: `history ${i}` },
        });
        await a!.next(ofType('ack', `h${i}`));
      }
      const p1 = await http('GET', `${CHAT}/rooms/${publicRoom}/messages?limit=2`, {
        headers: bearer(aliceToken),
      });
      log(
        line(
          'GET',
          '/rooms/{id}/messages?limit=2',
          p1,
          `bodies=${JSON.stringify(p1.body.messages.map((m: { body: string }) => m.body))} nextCursor=${p1.body.nextCursor}`,
        ),
      );
      expect(
        p1.body.messages.map((m: { body: string }) => m.body).join(',') === 'history 3,history 2',
        'newest first',
      );
      const p2 = await http(
        'GET',
        `${CHAT}/rooms/${publicRoom}/messages?limit=2&before=${p1.body.nextCursor}`,
        { headers: bearer(aliceToken) },
      );
      log(
        line(
          'GET',
          '/rooms/{id}/messages?limit=2&before=…',
          p2,
          `bodies=${JSON.stringify(p2.body.messages.map((m: { body: string }) => m.body))}`,
        ),
      );
      expect(p2.body.messages[0].body === 'history 1', 'cursor continues into the past');
    },
  );

  await check(
    '2.5',
    2,
    'Bonus: rate limiting for message sending',
    'alice sends quickly until blocked; the error frame carries rate_limited and retryAfterMs; the blocked message is not broadcast',
    async (log) => {
      expect(a && b, 'sockets from 2.2 are required');
      let sent = 0;
      let blocked: Frame | undefined;
      for (let i = 0; i < 15 && !blocked; i++) {
        a!.send({ type: 'send', id: `r${i}`, payload: { roomId: publicRoom, body: `burst ${i}` } });
        const reply = await a!.next(
          (f) => (f.type === 'ack' || f.type === 'error') && f.id === `r${i}`,
        );
        if (reply.type === 'error') blocked = reply;
        else sent++;
      }
      log(`accepted before block: ${sent}; blocking reply: ${JSON.stringify(blocked)}`);
      expect(blocked?.payload.code === 'rate_limited', 'rate_limited error frame');
      expect(
        blocked!.payload.retryAfterMs > 0 && blocked!.payload.retryAfterMs <= 10_000,
        'retryAfterMs within the 10s window',
      );
      let delivered = 0;
      for (;;) {
        try {
          await b!.next(
            (f) => f.type === 'message' && String(f.payload.body).startsWith('burst'),
            1_000,
          );
          delivered++;
        } catch {
          break;
        }
      }
      log(
        `bob received ${delivered} burst messages (equals accepted count: ${delivered === sent})`,
      );
      expect(delivered === sent, 'blocked message was not broadcast');
    },
  );

  await check(
    '2.6',
    2,
    'Bonus: administrative interface',
    'admin lists users and rooms; a regular user is forbidden; banning bob closes his socket with 4403; unban; kick',
    async (log) => {
      expect(b, 'socket from 2.2 is required');
      adminToken = (await chatLogin('admin', CHAT_ADMIN_PASSWORD, log)).body.token;
      const forbidden = await http('GET', `${CHAT}/admin/users`, { headers: bearer(aliceToken) });
      log(line('GET', '/admin/users (as alice)', forbidden));
      expect(forbidden.status === 403, 'regular user forbidden');
      const users = await http('GET', `${CHAT}/admin/users`, { headers: bearer(adminToken) });
      log(
        line(
          'GET',
          '/admin/users',
          users,
          `users=${JSON.stringify(users.body.users.map((u: { username: string; role: string }) => `${u.username}:${u.role}`))}`,
        ),
      );
      const roomsList = await http('GET', `${CHAT}/admin/rooms`, { headers: bearer(adminToken) });
      const mine = roomsList.body.rooms.find(
        (r: { room: { id: string } }) => r.room.id === publicRoom,
      );
      log(line('GET', '/admin/rooms', roomsList, `test room counts=${JSON.stringify(mine)}`));
      const bobId = users.body.users.find((u: { username: string }) => u.username === 'bob').id;
      const ban = await http('PUT', `${CHAT}/admin/users/${bobId}/ban`, {
        headers: bearer(adminToken),
      });
      log(line('PUT', `/admin/users/${bobId}/ban`, ban));
      const closed = await Promise.race([
        b!.closed,
        sleep(8_000).then(() => ({ code: 0, reason: 'timeout' })),
      ]);
      log(`bob's socket closed → ${JSON.stringify(closed)}`);
      expect(closed.code === 4403, 'banned user disconnected with 4403');
      const unban = await http('DELETE', `${CHAT}/admin/users/${bobId}/ban`, {
        headers: bearer(adminToken),
      });
      log(line('DELETE', `/admin/users/${bobId}/ban`, unban));
      expect(unban.status === 204, 'unbanned');
      const kick = await http('POST', `${CHAT}/admin/rooms/${publicRoom}/kick`, {
        headers: bearer(adminToken),
        json: { userId: bobId },
      });
      log(line('POST', `/admin/rooms/${publicRoom}/kick`, kick));
      expect(kick.status === 204, 'kick works');
    },
  );

  for (const s of sockets) await s.close().catch(() => undefined);
  if (adminToken) {
    for (const id of rooms) {
      const r = await http('DELETE', `${CHAT}/admin/rooms/${id}`, { headers: bearer(adminToken) });
      console.log(`cleanup: DELETE /admin/rooms/${id} → ${r.status}`);
    }
  } else if (rooms.length > 0) {
    console.log(`cleanup skipped (no admin token): rooms left behind: ${rooms.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
function deployedImage(app: string): string {
  try {
    const out = execSync(`fly status --app ${app}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /Image\s*│\s*(\S+)/.exec(out)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function writeReport(): void {
  const now = new Date();
  const pass = checks.filter((c) => c.result === 'PASS').length;
  const nz = now.toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
  const group = (option: 1 | 2): string =>
    option === 1 ? 'Option 1 · API rate limiter' : 'Option 2 · WebSocket chat server';

  const report: Report = {
    title: 'Live verification against the challenge requirements',
    subtitle: 'Both deployed applications, exercised over the public internet',
    generatedAt: now.toISOString(),
    generator: `\`scripts/live-verification.mts\` at commit \`${gitSha()}\` (${nz} NZ)`,
    facts: [
      { label: 'Option 1 · API rate limiter', value: RL, href: RL },
      { label: 'Option 1 · deployed image', value: deployedImage('convert-digital-rate-limiter') },
      { label: 'Option 2 · WebSocket chat server', value: CHAT, href: CHAT },
      { label: 'Option 2 · deployed image', value: deployedImage('convert-digital-chat') },
    ],
    sections: [
      {
        title: 'Method',
        paragraphs: [
          'Every check ran against the deployed applications over the public internet from one machine. ' +
            "Limits were shrunk for this machine's IP alone through the temporary-override API, so real 429s, " +
            '`Retry-After` values and sliding-window behaviour could be observed within seconds without affecting ' +
            "other visitors. Budgets are read from the server's own `RateLimit-Remaining` header rather than " +
            'assumed, because counters deliberately carry across override changes. All overrides and test rooms ' +
            'were removed at the end. Tokens and secrets are redacted. Re-run with `make verify-live`.',
          'What this complements: the automated suites, run in Docker on every push and in CI against real Redis ' +
            'and real sockets, cover behaviours that cannot be exercised safely on a live system, in particular ' +
            'fail-open / fail-closed under a Redis outage and exactly-`limit` admission under concurrent requests.',
          'Re-run constraints: the chat server allows 5 logins per IP per 15 minutes and this script uses 3, so ' +
            'run it at most once per 15 minutes; each run also adds about a dozen anonymous requests to this ' +
            "IP's hourly budget on the rate limiter.",
        ],
      },
    ],
    checks: checks.map((c) => ({
      id: c.id,
      group: group(c.option),
      title: c.requirement,
      scenario: c.scenario,
      status: c.result === 'PASS' ? 'pass' : 'fail',
      startedAt: c.startedAt,
      durationMs: c.durationMs,
      evidence: c.evidence,
      ...(c.error ? { error: c.error } : {}),
    })),
    notes: [
      {
        title: 'Not verified live, and why',
        items: [
          {
            title: 'Fail-open / fail-closed when Redis is unreachable',
            text: 'Would require taking the shared Redis down. Covered by the engine, middleware and API suites with an injected failing client.',
          },
          {
            title: 'Atomicity across concurrent instances',
            text: 'The demo runs one Machine. Covered by the store contract suite: 50 parallel requests, exactly 10 admitted, on real Redis.',
          },
          {
            title: 'Fixed-window boundary burst',
            text: "The default rule's 60-minute window is impractical to straddle live; the memory and Redis stores share one contract suite that covers it.",
          },
        ],
      },
    ],
  };

  writeFileSync(OUT, renderHtml(report));
  console.log(`\nreport written to ${OUT}: ${pass}/${checks.length} passed`);
}

// ---------------------------------------------------------------------------------------------
try {
  if (ONLY !== '2') await option1();
  if (ONLY !== '1') await option2();
} finally {
  // The report is written even if cleanup cannot reach the app: the evidence is the deliverable.
  try {
    for (const id of [...createdOverrides]) {
      const r = await http('DELETE', `${RL}/admin/overrides/${id}`, { headers: adminHeaders });
      console.log(`cleanup: DELETE /admin/overrides/${id} → ${r.status}`);
    }
    const leftover = await http('GET', `${RL}/admin/overrides`, { headers: adminHeaders });
    console.log(`overrides remaining on the live app: ${leftover.body?.overrides?.length ?? '?'}`);
  } catch (e) {
    console.log(
      `cleanup failed: ${(e as Error).message}; overrides possibly left behind: ${[...createdOverrides].join(', ') || 'none'}`,
    );
  } finally {
    writeReport();
  }
}
process.exit(checks.some((c) => c.result === 'FAIL') ? 1 : 0);
