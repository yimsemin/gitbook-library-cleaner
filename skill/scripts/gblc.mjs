#!/usr/bin/env node
// GitBook 라이브러리 미사용 이미지 정리. 이 프로그램은 GitBook에 아무것도 쓰지 않는다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { api } from './gitbook.mjs';
import {
  browserScripts,
  decodeDeep,
  formatBytes,
  integerOption,
  parseSpace,
  planId,
  refers,
  selectBatch,
  verifyQuota,
} from './lib.mjs';
import { login } from './login.mjs';
import { scan } from './scan.mjs';

const USAGE = `사용법
  gblc.mjs login
  gblc.mjs scan <스페이스 URL|ID> [--cr <번호>] [--out <폴더>]
  gblc.mjs prepare --report <report.json> --approve <승인 ID> [--only <파일ID,...>] [--batch <개수>]
  gblc.mjs verify --pending <pending.json> [--next] [--wait <초>]
종료 코드: 0 성공, 1 실패, 2 사용법 오류, 3 로그인 필요`;

const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, data) => writeFileSync(path, JSON.stringify(data, null, 1));
const sum = (files) => files.reduce((total, f) => total + f.size, 0);

function summarize(result) {
  const groups = Object.groupBy(result.files, (f) => f.status);
  const line = (key, title) => {
    const files = groups[key] ?? [];
    return `${title}: ${files.length}개, ${formatBytes(sum(files))}`;
  };
  const c = result.coverage;
  return [
    `스페이스: ${result.space.title}`,
    `기준: ${result.changeRequest ? `Change Request #${result.changeRequest.number} (${result.changeRequest.subject})` : '본문'}`,
    `검사 범위: 문서 ${c.documents}개, 미병합 Change Request ${c.unmergedChangeRequests.map((n) => `#${n}`).join(', ') || '없음'}, 다른 스페이스 ${c.otherSpaces}개, 사이트 ${c.sites}개`,
    line('unused', '삭제 후보(미사용 이미지)'),
    line('referenced', '사용 중'),
    line('uncertain', '불확실(삭제 안 함)'),
    line('not-image', '이미지 아님(삭제 안 함)'),
    result.complete
      ? '검사 완전성: 모두 읽음'
      : `검사 불완전, 삭제 불가:\n  - ${result.problems.slice(0, 10).join('\n  - ')}`,
  ].join('\n');
}

async function runScan(input, values) {
  const spaceId = parseSpace(input);
  const result = await scan(spaceId, { changeRequest: values.cr });
  const out = resolve(values.out ?? join('gblc-reports', result.scannedAt.replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });

  const candidates = result.files.filter((f) => f.status === 'unused').sort((a, b) => a.name.localeCompare(b.name));
  const approval = planId(spaceId, result.changeRequest?.id, candidates.map((f) => f.id));
  const { sources, usage, ...report } = result;
  writeJSON(join(out, 'report.json'), { ...report, planId: approval });
  writeFileSync(
    join(out, 'candidates.tsv'),
    ['file_id\tfilename\tbytes', ...candidates.map((f) => `${f.id}\t${f.name}\t${f.size}`)].join('\n') + '\n',
  );

  console.log(summarize(result));
  console.log(`전체 목록: ${join(out, 'candidates.tsv')}`);
  console.log(`보고서: ${join(out, 'report.json')}`);
  if (result.complete && result.changeRequest && candidates.length) console.log(`승인 ID: ${approval}`);
  else if (!result.changeRequest) console.log('삭제하려면 --cr <번호>를 지정해 다시 검사하세요.');
  console.log('Dry run: 아무것도 삭제하지 않았습니다.');
}

/** 보고서와 승인 ID를 확인하고 승인된 파일 목록을 돌려준다. */
function loadApproval({ report: path, approve, only }) {
  const report = readJSON(path);
  const unused = report.files.filter((f) => f.status === 'unused');
  const expected = planId(report.space.id, report.changeRequest?.id, unused.map((f) => f.id));
  if (!report.changeRequest) throw new Error('Change Request 기준으로 검사한 보고서가 필요합니다');
  if (!report.complete) throw new Error('검사가 불완전한 보고서로는 삭제할 수 없습니다');
  if (approve !== expected) throw new Error('승인 ID가 보고서의 삭제 목록과 일치하지 않습니다');
  if (!only) return { report, approved: unused };
  const ids = new Set(only.split(','));
  const approved = unused.filter((f) => ids.has(f.id));
  if (approved.length !== ids.size) throw new Error('--only에 승인 목록에 없는 파일이 있습니다');
  return { report, approved };
}

/** 방금 한 검사(fresh)를 기준으로 다음 묶음의 스크립트와 검증 기준을 만든다. */
function writeBatch(request, fresh) {
  const { report, approved } = loadApproval(request);
  if (!fresh.complete) throw new Error(`재검사 불완전: ${fresh.problems.join(' / ')}`);
  const { batch, remaining } = selectBatch(approved, fresh.files, request.batch);
  if (!batch.length) return console.log('삭제할 파일이 남아 있지 않습니다.');
  // 삭제한 뒤 검증하지 못하는 상황을 피한다.
  const { rateLimit } = fresh.usage;
  const quota = verifyQuota(fresh.usage, fresh.files.length);
  if (quota.short) {
    const resetAt = new Date(rateLimit.reset * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    throw new Error(
      `API 호출이 ${rateLimit.remaining}건 남아 다음 검증(약 ${quota.needed}건)에 부족하므로 삭제 묶음을 만들지 않았습니다. ${resetAt} 이후에 prepare를 다시 실행하세요.`,
    );
  }

  const out = dirname(resolve(request.report));
  const job = {
    spaceId: report.space.id,
    changeRequestNumber: fresh.changeRequest.number,
    files: batch.map(({ id, name }) => ({ id, name })),
  };
  const template = readFileSync(new URL('./browser-delete.js', import.meta.url), 'utf8');
  const scripts = browserScripts(template, job);
  writeFileSync(join(out, 'delete.js'), scripts.delete);
  writeFileSync(join(out, 'next.js'), scripts.next);
  writeJSON(join(out, 'pending.json'), {
    ...job,
    request,
    changeRequestId: fresh.changeRequest.id,
    files: batch.map(({ id, name, size, uploadKey }) => ({ id, name, size, uploadKey })),
    mainRevision: fresh.space.revision,
    mainFileIds: fresh.mainFileIds,
    changeRequestFileIds: fresh.files.map((f) => f.id),
  });
  console.log(`이번에 삭제할 묶음: ${batch.length}개, ${formatBytes(sum(batch))} (남은 승인 파일 ${remaining}개)`);
  if (rateLimit) console.log(`API 호출: ${rateLimit.remaining}건 남음, 다음 검증에 약 ${quota.needed}건`);
  console.log(`Change Request 주소: ${report.changeRequest.url}`);
  console.log(`스크립트 폴더: ${out} (처음이거나 페이지를 새로 열었으면 delete.js, 아니면 next.js)`);
}

async function runPrepare(values) {
  const request = {
    report: resolve(values.report),
    approve: values.approve,
    only: values.only,
    batch: integerOption(values.batch, 'batch', { fallback: 50, min: 1 }),
  };
  const { report } = loadApproval(request); // 검사 전에 승인부터 확인한다.
  writeBatch(request, await scan(report.space.id, { changeRequest: report.changeRequest.number }));
}

async function runVerify(values) {
  const waitSeconds = integerOption(values.wait, 'wait', { fallback: 180, min: 0 });
  const pending = readJSON(values.pending);
  const { spaceId, changeRequestId } = pending;
  const targets = new Map(pending.files.map((f) => [f.id, f]));
  const deadline = Date.now() + waitSeconds * 1000;

  // 화면에서 삭제한 내용은 API에 늦게 반영된다.
  let current;
  for (;;) {
    current = new Set((await api.changeRequestFiles(spaceId, changeRequestId)).map((f) => f.id));
    if (![...targets.keys()].some((id) => current.has(id)) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const remaining = pending.files.filter((f) => current.has(f.id));
  const removed = pending.changeRequestFileIds.filter((id) => !current.has(id));
  const unexpected = removed.filter((id) => !targets.has(id));

  const fresh = await scan(spaceId, { changeRequest: pending.changeRequestNumber });
  const gone = pending.files.filter((f) => !current.has(f.id));
  const broken = [];
  for (const source of fresh.sources) {
    const text = decodeDeep(source.text);
    for (const f of gone) {
      // 본문은 아직 병합 전이어도, 삭제한 파일을 참조하면 병합 뒤에 깨진다.
      if (refers(f, text)) broken.push(`${f.name} ← ${source.label}`);
    }
  }
  const mainFiles = new Set(fresh.mainFileIds);
  const mainChanged =
    fresh.space.revision !== pending.mainRevision ||
    mainFiles.size !== pending.mainFileIds.length ||
    pending.mainFileIds.some((id) => !mainFiles.has(id));

  console.log(`삭제 확인: ${gone.length}/${pending.files.length}개, ${formatBytes(sum(gone))}`);
  for (const f of remaining) console.log(`  남아 있음: ${f.id}  ${f.name}`);
  console.log(`대상 밖 삭제: ${unexpected.length ? unexpected.join(', ') : '없음'}`);
  console.log(`깨진 참조: ${broken.length ? `\n  ${broken.join('\n  ')}` : '없음'}`);
  console.log(`본문(게시 기준) 변경: ${mainChanged ? '있음 - 확인 필요' : '없음'}`);
  if (!fresh.complete) console.log(`재검사 불완전: ${fresh.problems.join(' / ')}`);
  const ok = !remaining.length && !unexpected.length && !broken.length && !mainChanged && fresh.complete;
  console.log(ok ? '검증 통과' : '검증 실패 - 다음 묶음을 진행하지 마세요');
  process.exitCode = ok ? 0 : 1;
  // 방금 한 검사가 다음 묶음의 삭제 직전 재검사가 된다.
  if (ok && values.next) writeBatch(pending.request, fresh);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...Object.fromEntries(
      ['cr', 'out', 'report', 'approve', 'only', 'batch', 'pending', 'wait'].map((n) => [n, { type: 'string' }]),
    ),
    next: { type: 'boolean' },
  },
});

try {
  const [command, input] = positionals;
  if (command === 'login') {
    process.exitCode = await login();
  } else if (command === 'scan' && input) await runScan(input, values);
  else if (command === 'prepare' && values.report && values.approve) await runPrepare(values);
  else if (command === 'verify' && values.pending) await runVerify(values);
  else {
    console.log(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = error.code === 'LOGIN_REQUIRED' ? 3 : 1;
}
