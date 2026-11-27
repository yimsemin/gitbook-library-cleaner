// 참조 관계 전체 검사. 읽기 전용.
import { api } from './gitbook.mjs';
import { classify, collectDocuments, revisionText } from './lib.mjs';

const PROTECTED_STATUSES = ['draft', 'open', 'archived']; // 병합되지 않은 Change Request

async function snapshot(spaceId) {
  const [space, ...lists] = await Promise.all([
    api.space(spaceId),
    ...PROTECTED_STATUSES.map((status) => api.changeRequests(spaceId, status)),
  ]);
  return { space, changeRequests: lists.flat() };
}

function fingerprint({ space, changeRequests }) {
  return JSON.stringify([
    space.revision,
    changeRequests.map((c) => [c.id, c.status, c.revision]).sort(),
  ]);
}

/** 한 스페이스의 본문과 미병합 Change Request를 모두 읽는다. */
async function readSpace(spaceId, label) {
  const before = await snapshot(spaceId);
  const sources = [];
  const problems = [];
  const documents = new Map(); // documentId -> label

  const addRevision = (revision, where) => {
    sources.push({ label: `${where}: 페이지 설정`, text: revisionText(revision) });
    const found = collectDocuments(revision);
    problems.push(...found.problems.map((p) => `${where}: ${p}`));
    const titles = new Map();
    const walk = (pages) =>
      (pages ?? []).forEach((p) => {
        if (p.documentId) titles.set(p.documentId, p.title);
        walk(p.pages);
      });
    walk(revision.pages);
    for (const id of found.documents) {
      if (!documents.has(id)) documents.set(id, `${where}: ${titles.get(id) ?? '재사용 콘텐츠'}`);
    }
  };

  const [main, ...requests] = await Promise.all([
    api.mainRevision(spaceId),
    ...before.changeRequests.map((cr) => api.changeRequestRevision(spaceId, cr.id)),
  ]);
  // 같은 문서의 출처 표시가 실행마다 같도록 정해진 순서로 추가한다.
  addRevision(main, `${label}본문`);
  before.changeRequests.forEach((cr, i) => {
    const where = `${label}CR #${cr.number}`;
    sources.push({ label: `${where}: 설명`, text: JSON.stringify(cr.description ?? null) });
    addRevision(requests[i], where);
  });

  await Promise.all(
    [...documents].map(async ([id, where]) => {
      const document = await api.document(spaceId, id);
      if (!Array.isArray(document.nodes)) throw new Error(`문서 형식이 예상과 다릅니다: ${where}`);
      sources.push({ label: where, text: JSON.stringify(document) });
    }),
  );

  const after = await snapshot(spaceId);
  if (fingerprint(before) !== fingerprint(after)) {
    problems.push(`${label || '대상 스페이스'}: 검사 중에 내용이 바뀌었습니다`);
  }
  return { ...after, sources, problems, documentCount: documents.size };
}

export async function scan(spaceId, { changeRequest } = {}) {
  // 첫 요청은 단독으로 보내 로그인 갱신이 겹치지 않게 한다.
  const { organization } = await api.space(spaceId);

  // 같은 조직의 다른 스페이스가 이 스페이스의 파일을 참조할 수 있다.
  const listed = await api.spaces(organization);
  const others = listed
    .map((s) => (typeof s === 'string' ? { id: s, title: s } : s))
    .filter((s) => s.id !== spaceId);

  const [target, otherResults, sites] = await Promise.all([
    readSpace(spaceId, ''),
    Promise.all(others.map((other) => readSpace(other.id, `[${other.title}] `))),
    // 사이트 설정(로고, 파비콘 등)의 참조
    api.sites(organization).then((list) =>
      Promise.all(
        list.map(async (site) => ({
          label: `사이트 설정: ${site.title}`,
          text: JSON.stringify(await api.siteCustomization(organization, site.id)),
        })),
      ),
    ),
  ]);

  const { space } = target;
  const results = [target, ...otherResults];
  const sources = [...results.flatMap((r) => r.sources), ...sites];
  const problems = results.flatMap((r) => r.problems);
  if (listed.length === others.length) problems.push('조직의 스페이스 목록에 대상 스페이스가 없습니다');

  let targetCR = null;
  if (changeRequest !== undefined) {
    targetCR = target.changeRequests.find((c) => String(c.number) === String(changeRequest));
    if (!targetCR || !['draft', 'open'].includes(targetCR.status)) {
      throw new Error(`Change Request #${changeRequest}은 초안 또는 열린 상태가 아닙니다`);
    }
  }

  const mainFiles = await api.mainFiles(spaceId);
  const targetFiles = targetCR ? await api.changeRequestFiles(spaceId, targetCR.id) : mainFiles;
  const files = classify(targetFiles, sources);

  return {
    scannedAt: new Date().toISOString(),
    space: { id: spaceId, title: space.title, organization: space.organization, revision: space.revision },
    changeRequest: targetCR && {
      id: targetCR.id,
      number: targetCR.number,
      subject: targetCR.subject,
      revision: targetCR.revision,
      url: targetCR.urls?.app,
    },
    coverage: {
      unmergedChangeRequests: target.changeRequests.map((c) => c.number).sort((a, b) => a - b),
      documents: target.documentCount,
      otherSpaces: others.length,
      sites: sites.length,
    },
    complete: problems.length === 0,
    problems,
    mainFileIds: mainFiles.map((f) => f.id),
    files,
    // 참조 오류 검증에 쓰는 원문. 보고서에는 저장하지 않는다.
    sources,
  };
}
