// 참조 판정 로직. 네트워크를 쓰지 않으며, 의심스러우면 "참조됨"으로 본다.
import { createHash } from 'node:crypto';

/** 퍼센트 인코딩을 여러 겹 풀어낸다. 잘못된 시퀀스는 그대로 둔다. */
export function decodeDeep(text) {
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === text) break;
    text = next;
  }
  return text;
}

export function uploadKey(downloadURL) {
  const match = /\/uploads\/([^/?#]+)\//.exec(decodeDeep(downloadURL ?? ''));
  return match ? match[1] : null;
}

/** 리비전에서 파일 목록 자체를 뺀, 참조가 들어 있을 수 있는 부분. */
export function revisionText(revision) {
  const { files, ...rest } = revision;
  return JSON.stringify(rest);
}

/** 문서 ID를 수집한다. 내용을 읽을 수 없는 항목은 problems에 남긴다. */
export function collectDocuments(revision) {
  const documents = [];
  const problems = [];
  const walk = (pages) => {
    for (const page of pages ?? []) {
      if (page.type === 'document') {
        // 빈 페이지는 documentId가 없다.
        if (page.documentId) documents.push(page.documentId);
        if (page.computed) problems.push(`computed page: ${page.title}`);
      } else if (page.type !== 'group' && page.type !== 'link') {
        problems.push(`unsupported page type "${page.type}": ${page.title}`);
      }
      walk(page.pages);
    }
  };
  if (!Array.isArray(revision.pages)) problems.push('revision has no page list');
  walk(revision.pages);
  for (const content of revision.reusableContents ?? []) {
    if (content.computed) problems.push(`computed reusable content: ${content.title}`);
    else if (content.document) documents.push(content.document);
  }
  return { documents, problems };
}

/**
 * sources: [{ label, text }]
 * 파일 ID 또는 업로드 키가 어느 원문에든 나타나면 참조된 것으로 본다.
 */
export function classify(files, sources) {
  const decoded = sources.map((s) => ({ label: s.label, text: decodeDeep(s.text) }));
  return files.map((file) => {
    const key = uploadKey(file.downloadURL);
    const needles = [file.id, key].filter(Boolean);
    const referencedBy = decoded
      .filter((s) => needles.some((n) => s.text.includes(n)))
      .map((s) => s.label);
    let status;
    if (referencedBy.length) status = 'referenced';
    else if (!String(file.contentType).startsWith('image/')) status = 'not-image';
    else if (!key) status = 'uncertain';
    else status = 'unused';
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      uploadKey: key,
      status,
      referencedBy,
    };
  });
}

/** 승인 대상을 식별하는 값. 대상 스페이스·CR·파일 ID가 같아야 같다. */
export function planId(spaceId, changeRequestId, ids) {
  return createHash('sha256')
    .update(JSON.stringify([spaceId, changeRequestId ?? null, [...ids].sort()]))
    .digest('hex')
    .slice(0, 12);
}

/**
 * delete: 삭제 함수를 페이지에 올리고 첫 묶음을 실행한다.
 * next: 같은 버전의 함수가 올라간 페이지에서 작업 목록만 실행한다.
 */
export function browserScripts(template, job) {
  const version = createHash('sha256').update(template).digest('hex').slice(0, 8);
  const data = JSON.stringify(job);
  return {
    delete: template.replace('__VERSION__', version).replace('__JOB__', () => data),
    next: `window.__gblcRun?.version === '${version}' ? window.__gblcRun(${data}) : 'not installed: run delete.js'\n`,
  };
}

/** 명령행의 정수 옵션. 잘못된 값은 조용히 넘기지 않는다. */
export function integerOption(value, name, { fallback, min }) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min) {
    throw new Error(`--${name}에는 ${min} 이상의 정수를 지정하세요: ${value}`);
  }
  return Number(value);
}

/** 동시에 최대 max개만 실행한다. 하나가 실패하면 대기 중인 작업은 시작하지 않는다. */
export function limiter(max) {
  let active = 0;
  let failure = null;
  const queue = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async (task) => {
    while (active >= max) await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      if (failure) throw failure;
      return await task();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      release();
    }
  };
}

/**
 * 승인 목록에서 이번 묶음을 고른다. fresh는 방금 한 검사의 파일 판정이다.
 * 이미 삭제된 파일은 빼고, 승인 후 상태가 바뀐 파일이 있으면 중단한다.
 */
export function selectBatch(approved, fresh, size) {
  const status = new Map(fresh.map((f) => [f.id, f.status]));
  const remaining = approved.filter((f) => status.has(f.id));
  const changed = remaining.filter((f) => status.get(f.id) !== 'unused');
  if (changed.length) {
    throw new Error(`승인 후 참조가 생긴 파일이 있어 중단합니다: ${changed.map((f) => f.name).join(', ')}`);
  }
  return { batch: remaining.slice(0, size), remaining: remaining.length };
}

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function parseSpace(input) {
  const match = /\/s\/([A-Za-z0-9_-]+)/.exec(input) ?? /^([A-Za-z0-9_-]{10,})$/.exec(input);
  if (!match) throw new Error(`스페이스 URL 또는 ID가 아닙니다: ${input}`);
  return match[1];
}
