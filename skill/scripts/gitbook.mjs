// GitBook API 읽기 전용 조회. 로그인 정보는 공식 CLI가 보관하고 갱신하며, 조회는 이 프로세스에서 직접 보낸다.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { limiter } from './lib.mjs';

export const CLI = fileURLToPath(new URL('../node_modules/@gitbook/cli/cli.js', import.meta.url));
const CAPTURE = new URL('./capture-auth.mjs', import.meta.url).href;
const COMMAND = fileURLToPath(new URL('./gblc.mjs', import.meta.url));

const CONCURRENCY = 10; // 동시에 보내는 요청 수. 호출하는 쪽은 마음껏 병렬로 요청한다.
const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000; // 호출 제한이 이보다 늦게 풀리면 기다리지 않고 끝낸다.

/** 로그인해야 해결되는 오류. 명령은 `code`를 보고 전용 종료 코드로 끝난다. 문구는 에이전트와 사용자가 함께 읽는다. */
function loginRequired(reason) {
  const message = [
    `로그인 필요: ${reason}`,
    '사용자에게 알린 뒤, 지금 이 명령을 실행한 에이전트가 같은 실행 권한으로 다음을 실행하고 사용자는 브라우저에서 승인합니다.',
    `  node "${COMMAND}" login`,
    '다른 앱이나 터미널에서 한 로그인은 이 환경에서 보이지 않을 수 있습니다.',
  ].join('\n');
  return Object.assign(new Error(message), { code: 'LOGIN_REQUIRED' });
}

/**
 * CLI의 `whoami`를 실행해, 필요하면 로그인을 갱신한 CLI가 쓰는 API 주소와 인증 값을 받는다.
 * 인증 값은 메모리에만 둔다. CLI의 표준 출력(계정 정보)은 로그인 여부만 확인하고 버린다.
 */
function cliCredentials() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', CAPTURE, CLI, 'whoami', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let credentials;
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('message', (message) => (credentials = message));
    child.stdout.on('data', (data) => out.push(data));
    child.stderr.on('data', (data) => err.push(data));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (credentials) return resolve(credentials);
      const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 500);
      if (signedOut(Buffer.concat(out))) return reject(loginRequired('이 환경에 저장된 GitBook 로그인이 없습니다.'));
      const message = [
        `GitBook 로그인 확인 실패 (종료 코드 ${code ?? '시간 초과'})`,
        '샌드박스에서 실행했다면 실행 승인을 받아 다시 실행하세요. 로그인이 만료됐다면 `login`을 다시 실행하세요.',
        detail,
      ];
      reject(new Error(message.filter(Boolean).join('\n')));
    });
  });
}

/** `whoami --json`은 저장된 로그인이 없으면 `{ "authenticated": false }`를 출력한다. */
function signedOut(stdout) {
  try {
    return JSON.parse(stdout.toString('utf8')).authenticated === false;
  } catch {
    return false;
  }
}

/** 호출 제한 응답이 알려 주는 대기 시간. 알려 주지 않으면 null. */
function rateLimitWait(headers) {
  const after = Number(headers.get('retry-after') ?? NaN);
  if (Number.isFinite(after)) return after * 1000;
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
  return Number.isFinite(reset) ? Math.max(reset * 1000 - Date.now(), 0) + 1000 : null;
}

/** 인자는 테스트에서만 바꾼다. */
export function createClient({ credentials = cliCredentials, fetch = globalThis.fetch, sleep = delay } = {}) {
  const limited = limiter(CONCURRENCY);
  let session = null; // 동시에 시작한 요청들이 로그인 확인 한 번을 같이 쓴다.
  let sent = 0;
  let rateLimit = null; // 응답이 알려 준 { remaining, reset(초) }

  async function login() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await credentials();
      } catch (error) {
        if (error.code === 'LOGIN_REQUIRED' || attempt >= ATTEMPTS) throw error;
        await sleep(attempt * 3000);
      }
    }
  }

  /** 응답은 보낸 순서와 다르게 도착하므로, 같은 제한 구간에서는 가장 적게 남은 값을 둔다. */
  function track(headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN);
    const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    const newer = !rateLimit || reset > rateLimit.reset;
    if (newer || (reset === rateLimit.reset && remaining < rateLimit.remaining)) rateLimit = { remaining, reset };
  }

  async function request(path) {
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      const current = (session ??= login());
      const { endpoint, authorization } = await current;
      let response;
      let detail;
      try {
        sent++;
        response = await fetch(`${endpoint}/v1/${path}`, {
          headers: { authorization, 'user-agent': 'gitbook-library-cleaner' },
          signal: AbortSignal.timeout(60_000),
        });
        track(response.headers);
        if (response.ok) {
          const body = await response.json();
          if (body && typeof body === 'object') return body;
          detail = '응답 형식이 예상과 다릅니다';
        } else {
          detail = (await response.text()).slice(0, 500);
        }
      } catch (error) {
        detail = error.cause?.message ?? error.message;
      }
      const status = response?.status;
      // 실행 중에 만료된 로그인은 CLI로 한 번 갱신한다.
      if (status === 401) {
        if (renewed) throw Object.assign(loginRequired(`GitBook이 로그인을 거부했습니다 (401). ${detail}`), { status });
        renewed = true;
        if (session === current) session = null;
        attempt--;
        continue;
      }
      // 연결 실패, 읽다 끊긴 응답, 호출 제한, 서버 오류만 다시 시도한다.
      const temporary = !status || response.ok || status === 429 || status >= 500;
      const wait = (status === 429 && rateLimitWait(response.headers)) || attempt * 3000;
      if (!temporary || attempt >= ATTEMPTS || wait > MAX_WAIT_MS) {
        const hint = status === 429 ? ` (호출 제한: ${Math.ceil(wait / 60_000)}분 뒤에 다시 실행하세요)` : '';
        const error = new Error(`GitBook 조회 실패 (${status ?? '연결 실패'})${hint}: ${path}: ${detail}`);
        throw Object.assign(error, { status });
      }
      await sleep(wait);
    }
  }

  // 재시도까지 실패한 요청이 나오면 남은 요청은 시작하지 않는다.
  const get = (path) => limited(() => request(path));

  /** 목록 조회는 마지막 페이지까지 읽는다. */
  async function list(path, query = {}) {
    const items = [];
    const seen = new Set();
    let page;
    do {
      const params = new URLSearchParams({ ...query, limit: '100', ...(page ? { page } : {}) });
      const result = await get(`${path}?${params}`);
      if (!Array.isArray(result.items)) throw new Error(`목록 형식이 예상과 다릅니다: ${path}`);
      items.push(...result.items);
      page = result.next?.page;
      if (page && seen.has(page)) throw new Error(`목록 페이지가 반복됩니다: ${path}`);
      seen.add(page);
    } while (page);
    return items;
  }

  const id = encodeURIComponent;
  const space = (s) => `spaces/${id(s)}`;
  const changeRequest = (s, c) => `${space(s)}/change-requests/${id(c)}`;
  const org = (o) => `orgs/${id(o)}`;
  const site = (o, s) => `${org(o)}/sites/${id(s)}`;

  return {
    /** 지금까지 보낸 조회 요청 수와 마지막으로 확인한 호출 제한. */
    usage: () => ({ requests: sent, rateLimit }),
    space: (s) => get(space(s)),
    spaces: (o) => list(`${org(o)}/spaces`),
    mainRevision: (s) => get(`${space(s)}/content`),
    mainFiles: (s) => list(`${space(s)}/content/files`),
    changeRequests: (s, status) => list(`${space(s)}/change-requests`, { status }),
    changeRequestRevision: (s, c) => get(`${changeRequest(s, c)}/content`),
    changeRequestFiles: (s, c) => list(`${changeRequest(s, c)}/content/files`),
    document: (s, d) => get(`${space(s)}/documents/${id(d)}`),
    sites: (o) => list(`${org(o)}/sites`),
    siteCustomization: (o, s) => get(`${site(o, s)}/customization`),
    siteSpaces: (o, s) => list(`${site(o, s)}/site-spaces`),
    siteSpaceCustomization: (o, s, siteSpace) => get(`${site(o, s)}/site-spaces/${id(siteSpace)}/customization`),
  };
}

export const api = createClient();
