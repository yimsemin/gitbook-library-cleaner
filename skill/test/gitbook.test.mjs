import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '../scripts/gitbook.mjs';
import { scan } from '../scripts/scan.mjs';

const reply = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

/** 정해진 순서로 응답하는 클라이언트. */
function fakeClient(replies) {
  const calls = [];
  const waits = [];
  let logins = 0;
  const api = createClient({
    credentials: async () => ({ endpoint: 'https://api.invalid', authorization: `Bearer ${++logins}` }),
    fetch: async (url, { headers }) => {
      calls.push([url, headers.authorization]);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => waits.push(ms),
  });
  return { api, calls, waits };
}

test('temporary failures are retried, honoring the rate limit wait', async () => {
  const { api, waits } = fakeClient([
    new TypeError('fetch failed'),
    reply(429, {}, { 'retry-after': '7' }),
    reply(200, { id: 's' }),
  ]);
  assert.deepEqual(await api.space('s'), { id: 's' });
  assert.deepEqual(waits, [3000, 7000]);
});

test('unreadable responses end in an error, never in empty content', async () => {
  const broken = () => new Response('{"nodes": [', { status: 200 });
  await assert.rejects(fakeClient([broken(), broken(), broken()]).api.document('s', 'd'), /조회 실패/);

  const missing = fakeClient([reply(404)]);
  await assert.rejects(missing.api.document('s', 'd'), { status: 404 });
  await assert.rejects(missing.api.space('s'), { status: 404 }); // 실패 뒤에는 새 요청을 보내지 않는다.
  assert.equal(missing.calls.length, 1);

  const limited = fakeClient([reply(429, {}, { 'retry-after': '3600' })]);
  await assert.rejects(limited.api.space('s'), /60분 뒤/);
  assert.deepEqual(limited.waits, []);
});

test('a failed login check is retried before giving up', async () => {
  let failures = 2;
  const options = {
    credentials: async () => {
      if (failures-- > 0) throw new Error('refresh failed');
      return { endpoint: 'https://api.invalid', authorization: 'Bearer t' };
    },
    fetch: async () => reply(200, { id: 's' }),
    sleep: async () => {},
  };
  assert.deepEqual(await createClient(options).space('s'), { id: 's' });
  failures = 3;
  await assert.rejects(createClient(options).space('s'), /refresh failed/);
});

test('usage counts requests and keeps the lowest remaining quota of the current window', async () => {
  const quota = (remaining, reset) => ({ 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': reset });
  const { api } = fakeClient([
    reply(200, {}, quota(90, 100)),
    reply(200, {}, quota(95, 100)),
    reply(200, {}, quota(4999, 3700)),
  ]);
  await api.space('a');
  await api.space('b');
  assert.deepEqual(api.usage(), { requests: 2, rateLimit: { remaining: 90, reset: 100 } });
  await api.space('c');
  assert.deepEqual(api.usage(), { requests: 3, rateLimit: { remaining: 4999, reset: 3700 } });
});

test('an expired login is renewed once', async () => {
  const renewed = fakeClient([reply(401), reply(200, { id: 's' })]);
  await renewed.api.space('s');
  assert.deepEqual(
    renewed.calls.map(([, authorization]) => authorization),
    ['Bearer 1', 'Bearer 2'],
  );
  await assert.rejects(fakeClient([reply(401), reply(401)]).api.space('s'), { status: 401 });
});

test('lists are read to the last page', async () => {
  const { api, calls } = fakeClient([reply(200, { items: [1], next: { page: 'p2' } }), reply(200, { items: [2] })]);
  assert.deepEqual(await api.changeRequests('s', 'open'), [1, 2]);
  assert.match(calls[1][0], /spaces\/s\/change-requests\?status=open&limit=100&page=p2$/);
});

// CLI 버전을 올렸을 때 로그인 재사용이 깨지면 여기서 드러난다. 임시 설정 폴더와 로컬 서버만 쓴다.
test('the saved CLI login is refreshed by the CLI and reused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gblc-'));
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(`${request.url} ${request.headers.authorization ?? ''}`.trim());
    const body = request.url === '/token' ? { access_token: 'new', expires_in: 3600 } : { id: 'me' };
    response.writeHead(request.url.startsWith('/.well-known') ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { APPDATA: home, HOME: home, XDG_CONFIG_HOME: home, GITBOOK_OAUTH_ENDPOINT: endpoint });
    delete process.env.GITBOOK_TOKEN;
    const folder = {
      win32: ['gitbook-nodejs', 'Config'],
      darwin: ['Library', 'Preferences', 'gitbook-nodejs'],
    }[process.platform] ?? ['gitbook-nodejs'];
    const config = join(home, ...folder, 'config.json');
    mkdirSync(join(home, ...folder), { recursive: true });
    const oauth = { issuer: endpoint, clientId: 'c', accessToken: 'old', refreshToken: 'r', expiresAt: 0 };
    writeFileSync(config, JSON.stringify({ envs: { default: { endpoint, oauth } } }));

    await createClient().space('s');

    assert.equal(seen.at(-1), '/v1/spaces/s Bearer new');
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).envs.default.oauth.accessToken, 'new');
  } finally {
    process.env = previous;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/** 이미지 하나와 문서 하나가 있는 스페이스. overrides로 조회를 바꾼다. */
function fakeSpace(overrides = {}) {
  const file = { id: 'file1', name: 'a.png', size: 1, contentType: 'image/png', downloadURL: '/uploads/key1/a.png' };
  const revision = { pages: [{ type: 'document', documentId: 'd1', title: '문서' }] };
  return {
    usage: () => ({ requests: 0, rateLimit: null }),
    space: async () => ({ title: '대상', organization: 'o', revision: 'r1' }),
    spaces: async () => [{ id: 's', title: '대상' }],
    mainRevision: async () => revision,
    mainFiles: async () => [file],
    changeRequests: async () => [],
    document: async () => ({ nodes: [] }),
    sites: async () => [],
    ...overrides,
  };
}

test('a change during the scan makes it incomplete', async () => {
  assert.equal((await scan('s', { api: fakeSpace() })).complete, true);
  let revision = 0;
  const api = fakeSpace({ space: async () => ({ title: '대상', organization: 'o', revision: ++revision }) });
  const result = await scan('s', { api });
  assert.equal(result.complete, false);
  assert.match(result.problems.join(), /검사 중에 내용이 바뀌었습니다/);
});

test('a document that cannot be read stops the scan', async () => {
  await assert.rejects(scan('s', { api: fakeSpace({ document: async () => ({}) }) }), /문서 형식/);
});
