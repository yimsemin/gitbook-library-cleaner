// 참조 관계 전체 검사. 읽기 전용.
import { api as gitbook } from './gitbook.mjs';
import { allPages, classify, collectDocuments, revisionText } from './lib.mjs';

const PROTECTED_STATUSES = ['draft', 'open', 'archived']; // 병합되지 않은 Change Request

async function snapshot(api, spaceId) {
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
async function readSpace(api, spaceId, label) {
  const before = await snapshot(api, spaceId);
  const sources = [];
  const problems = [];
  const documents = new Map(); // documentId -> label

  const addRevision = (revision, where) => {
    sources.push({ label: `${where}: 페이지 설정`, text: revisionText(revision) });
    const found = collectDocuments(revision);
    problems.push(...found.problems.map((p) => `${where}: ${p}`));
    const titles = new Map([...allPages(revision.pages)].map((p) => [p.documentId, p.title]));
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
    const where = `${label}Change Request #${cr.number}`;
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

  const after = await snapshot(api, spaceId);
  if (fingerprint(before) !== fingerprint(after)) {
    problems.push(`${label || '대상 스페이스'}: 검사 중에 내용이 바뀌었습니다`);
  }
  return { ...after, sources, problems, documentCount: documents.size };
}

/** 사이트 전체 설정과 스페이스별 설정(로고, 파비콘 등)의 참조. */
async function readSite(api, organization, site) {
  const [customization, siteSpaces] = await Promise.all([
    api.siteCustomization(organization, site.id),
    api.siteSpaces(organization, site.id),
  ]);
  const overrides = await Promise.all(
    siteSpaces.map(async (siteSpace) => ({
      label: `사이트 설정: ${site.title} / ${siteSpace.title}`,
      text: JSON.stringify(await api.siteSpaceCustomization(organization, site.id, siteSpace.id)),
    })),
  );
  return [{ label: `사이트 설정: ${site.title}`, text: JSON.stringify(customization) }, ...overrides];
}

export async function scan(spaceId, { changeRequest, api = gitbook } = {}) {
  const { requests: requestsBefore } = api.usage();
  // 조직을 알아야 나머지 검사 범위를 정할 수 있다.
  const { organization } = await api.space(spaceId);

  // 같은 조직의 다른 스페이스가 이 스페이스의 파일을 참조할 수 있다.
  const listed = await api.spaces(organization);
  const others = listed
    .map((s) => (typeof s === 'string' ? { id: s, title: s } : s))
    .filter((s) => s.id !== spaceId);

  const [target, otherResults, sites] = await Promise.all([
    readSpace(api, spaceId, ''),
    Promise.all(others.map((other) => readSpace(api, other.id, `[${other.title}] `))),
    api.sites(organization).then((list) => Promise.all(list.map((site) => readSite(api, organization, site)))),
  ]);

  const { space } = target;
  const results = [target, ...otherResults];
  const sources = [...results.flatMap((r) => r.sources), ...sites.flat()];
  const problems = results.flatMap((r) => r.problems);
  if (listed.length === others.length) problems.push('조직의 스페이스 목록에 대상 스페이스가 없습니다');

  let targetCR = null;
  if (changeRequest !== undefined) {
    targetCR = target.changeRequests.find((c) => String(c.number) === String(changeRequest));
    if (!targetCR || !['draft', 'open'].includes(targetCR.status)) {
      throw new Error(`초안 또는 열린 상태의 Change Request가 아닙니다: #${changeRequest}`);
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
    // 아래 둘(참조 오류 검증에 쓰는 원문, 이번 검사의 API 사용량)은 보고서에 저장하지 않는다.
    sources,
    usage: { requests: api.usage().requests - requestsBefore, rateLimit: api.usage().rateLimit },
  };
}
