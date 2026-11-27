// 공식 GitBook CLI를 통한 읽기 전용 조회. 로그인 정보는 CLI가 관리한다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { limiter } from './lib.mjs';

export const CLI = fileURLToPath(new URL('../node_modules/@gitbook/cli/cli.js', import.meta.url));

// 동시에 실행하는 CLI 프로세스 수. 호출하는 쪽은 마음껏 병렬로 요청한다.
const limited = limiter(10);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) return resolve(stdout);
      const message = (Buffer.concat(err).toString('utf8') || stdout).trim().slice(0, 500);
      const error = new Error(`gitbook ${args.join(' ')} 실패 (${code ?? 'timeout'}): ${message}`);
      // 재시도 여부는 명령 인자(ID)를 뺀 CLI 출력만 보고 정한다.
      reject(Object.assign(error, { output: message }));
    });
  });
}

async function withRetry(args) {
  for (let attempt = 1; ; attempt++) {
    try {
      const stdout = await run([...args, '--json']);
      return JSON.parse(stdout);
    } catch (error) {
      if (attempt >= 3 || /authenticated|unknown option|\b(401|403|404)\b/i.test(error.output)) throw error;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

// 재시도까지 실패한 요청이 나오면 남은 요청은 시작하지 않는다.
const get = (args) => limited(() => withRetry(args));

/** 목록 조회는 마지막 페이지까지 읽는다. */
async function list(args) {
  const items = [];
  const seen = new Set();
  let page;
  do {
    const result = await get([...args, '--limit', '100', ...(page ? ['--page', page] : [])]);
    if (!Array.isArray(result.items)) throw new Error(`목록 형식이 예상과 다릅니다: ${args.join(' ')}`);
    items.push(...result.items);
    page = result.next?.page;
    if (page && seen.has(page)) throw new Error(`목록 페이지가 반복됩니다: ${args.join(' ')}`);
    seen.add(page);
  } while (page);
  return items;
}

// ID가 `-`로 시작할 수 있어 항상 `--이름=값` 형태로 넘긴다.
const space = (s) => `--spaceId=${s}`;
const request = (c) => `--changeRequestId=${c}`;
const org = (o) => `--organizationId=${o}`;

export const api = {
  space: (s) => get(['spaces', 'get', space(s)]),
  spaces: (o) => list(['spaces', 'list', `--organization=${o}`]),
  mainRevision: (s) => get(['spaces', 'content', 'list', space(s)]),
  mainFiles: (s) => list(['spaces', 'content', 'files', 'list', space(s)]),
  changeRequests: (s, status) => list(['spaces', 'change-requests', 'list', space(s), '--status', status]),
  changeRequestRevision: (s, c) => get(['spaces', 'change-requests', 'content', 'list', space(s), request(c)]),
  changeRequestFiles: (s, c) => list(['spaces', 'change-requests', 'content', 'files', 'list', space(s), request(c)]),
  document: (s, d) => get(['spaces', 'documents', 'get', space(s), `--documentId=${d}`]),
  sites: (o) => list(['organizations', 'sites', 'list', org(o)]),
  siteCustomization: (o, site) => get(['organizations', 'sites', 'customization', 'get', org(o), `--siteId=${site}`]),
  siteSpaces: (o, site) => list(['organizations', 'sites', 'site-spaces', 'list', org(o), `--siteId=${site}`]),
  siteSpaceCustomization: (o, site, siteSpace) =>
    get([
      ...['organizations', 'sites', 'site-spaces', 'customization', 'get', org(o)],
      `--siteId=${site}`,
      `--siteSpaceId=${siteSpace}`,
    ]),
};
