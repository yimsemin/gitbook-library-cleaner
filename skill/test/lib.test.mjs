import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import {
  browserScripts,
  classify,
  collectDocuments,
  integerOption,
  limiter,
  parseSpace,
  planId,
  revisionText,
  selectBatch,
  uploadKey,
} from '../scripts/lib.mjs';

const file = (id, key, extra = {}) => ({
  id,
  name: `${id}.webp`,
  size: 10,
  contentType: 'image/webp',
  downloadURL: `https://x.gitbook.io/o/spaces%2FSPACE%2Fuploads%2F${key}%2F${id}.webp?alt=media`,
  ...extra,
});
const statuses = (files, texts) =>
  classify(files, texts.map((text, i) => ({ label: `s${i}`, text }))).map((f) => f.status);

test('upload key is read from an encoded download URL', () => {
  assert.equal(uploadKey(file('f1', 'KEY1').downloadURL), 'KEY1');
});

test('reference by file ID or by (doubly encoded) URL protects the file', () => {
  const files = [file('fileA', 'KEYA'), file('fileB', 'KEYB'), file('fileC', 'KEYC')];
  const texts = [
    JSON.stringify({ ref: { kind: 'file', file: 'fileA' } }),
    // 파일 ID 없이 업로드 키만 남은 주소
    JSON.stringify({ url: encodeURIComponent(encodeURIComponent('spaces/SPACE/uploads/KEYB/renamed.webp')) }),
  ];
  assert.deepEqual(statuses(files, texts), ['referenced', 'referenced', 'unused']);
});

test('same file name does not count as a reference', () => {
  assert.deepEqual(statuses([{ ...file('fileA', 'KEYA'), name: 'shared.webp' }], ['"shared.webp"']), ['unused']);
});

test('non-images and files without an upload key are never candidates', () => {
  const files = [
    file('doc', 'K1', { contentType: 'application/pdf' }),
    file('odd', 'K2', { downloadURL: 'https://example.com/odd.webp' }),
  ];
  assert.deepEqual(statuses(files, []), ['not-image', 'uncertain']);
});

test('the revision file list is not treated as a reference, page covers are', () => {
  const revision = {
    files: [{ id: 'fileA' }],
    pages: [{ type: 'document', documentId: 'd1', cover: { ref: { kind: 'file', file: 'fileB' } } }],
  };
  const text = revisionText(revision);
  assert.ok(!text.includes('fileA'));
  assert.ok(text.includes('fileB'));
});

test('hidden, nested and reusable documents are collected', () => {
  const result = collectDocuments({
    pages: [
      { type: 'group', pages: [{ type: 'document', documentId: 'hidden', hidden: true, pages: [] }] },
      { type: 'link' },
    ],
    reusableContents: [{ title: 'r', document: 'reusable' }],
  });
  assert.deepEqual(result, { documents: ['hidden', 'reusable'], problems: [] });
});

test('content that cannot be read is reported', () => {
  const result = collectDocuments({
    pages: [{ type: 'computed', title: 'api' }],
    reusableContents: [{ title: 'r', computed: {} }],
  });
  assert.equal(result.problems.length, 2);
  assert.equal(collectDocuments({}).problems.length, 1);
});

test('plan ID ignores order and changes with the list or target', () => {
  assert.equal(planId('s', 'c', ['a', 'b']), planId('s', 'c', ['b', 'a']));
  assert.notEqual(planId('s', 'c', ['a', 'b']), planId('s', 'c', ['a']));
  assert.notEqual(planId('s', 'c', ['a']), planId('s', 'other', ['a']));
});

test('space is parsed from an app URL', () => {
  assert.equal(parseSpace('https://app.gitbook.com/o/O/s/ExampleSpaceId000000/~/changes/12/'), 'ExampleSpaceId000000');
  assert.throws(() => parseSpace('https://example.com'));
});

const template = readFileSync(new URL('../scripts/browser-delete.js', import.meta.url), 'utf8');
const job = { spaceId: 'SPACE', changeRequestNumber: 12, files: [{ id: 'f1', name: "a $& 'b'.webp" }] };
const page = (pathname) =>
  createContext({
    window: {},
    location: { hostname: 'app.gitbook.com', pathname },
    document: { querySelector: () => null },
  });

test('the next batch runs only after the same version is installed', () => {
  const scripts = browserScripts(template, job);
  const context = page('/o/O/s/OTHER/~/changes/12/');
  assert.match(runInContext(scripts.next, context), /^not installed/);
  assert.match(runInContext(scripts.delete, context), /^refused: not the target/);
  assert.match(runInContext(scripts.next, context), /^refused: not the target/);
  assert.match(runInContext(browserScripts(`${template}// changed`, job).next, context), /^not installed/);
});

test('the browser script refuses other change requests, the diff view and a closed library', () => {
  const run = (path) => runInContext(browserScripts(template, job).delete, page(path));
  assert.match(run('/o/O/s/SPACE/~/edit/~/changes/121/'), /not the target/);
  assert.match(run('/o/O/s/SPACE/~/diff/~/changes/12/'), /not the target/);
  assert.match(run('/o/O/s/SPACE/~/edit/~/changes/12/'), /open Library/);
});

// Library 화면의 최소 모형. 삭제 스크립트가 보는 요소만 흉내 낸다.
function library(rowIds, { dialogName } = {}) {
  const [{ name }] = job.files;
  const state = { menu: false, dialog: null, deleted: [] };
  const rows = rowIds.map((id) => {
    const button = { click: () => (state.menu = id) };
    const row = { querySelectorAll: () => [button] };
    return { id, children: [], textContent: name, __reactFiber$: { memoizedProps: { file: { id } } }, closest: () => row };
  });
  const confirm = {
    textContent: 'Delete',
    click: () => {
      state.deleted.push(state.menu);
      rows.splice(rows.findIndex((r) => r.id === state.menu), 1);
      state.dialog = null;
    },
  };
  const item = {
    textContent: 'Delete',
    click: () => {
      state.dialog = { textContent: `Delete "${dialogName ?? name}"?`, querySelectorAll: () => [confirm] };
    },
  };
  const search = { dispatchEvent() {} };
  const context = createContext({
    window: {},
    location: { hostname: 'app.gitbook.com', pathname: '/o/O/s/SPACE/~/changes/12/' },
    document: {
      querySelector: (selector) => (selector.startsWith('input') ? search : state.dialog),
      querySelectorAll: (selector) => (selector === '[data-index] *' ? [...rows] : state.menu ? [item] : []),
    },
    HTMLInputElement: { prototype: Object.defineProperty({}, 'value', { set() {} }) },
    Event: class {},
    setTimeout: (resolve) => setImmediate(resolve),
  });
  return { context, state };
}

async function runInLibrary(rowIds, options) {
  const { context, state } = library(rowIds, options);
  runInContext(browserScripts(template, job).delete, context);
  while (context.window.__gblc.state === 'running') await new Promise((r) => setImmediate(r));
  return { ...context.window.__gblc, deleted: state.deleted };
}

test('the browser script deletes only the row with the approved file ID', async () => {
  const result = await runInLibrary(['other', 'f1']);
  assert.equal(result.state, 'finished');
  assert.deepEqual(result.deleted, ['f1']);
});

test('the browser script deletes nothing when rows are ambiguous or the dialog names another file', async () => {
  for (const [rowIds, options, error] of [
    [['f1', 'f1'], {}, /ambiguous rows/],
    [['f1'], { dialogName: 'other.webp' }, /dialog mismatch/],
  ]) {
    const result = await runInLibrary(rowIds, options);
    assert.equal(result.state, 'stopped');
    assert.match(result.error, error);
    assert.deepEqual(result.deleted, []);
  }
});

test('job data is embedded unchanged', () => {
  const scripts = browserScripts(template, job);
  assert.ok(scripts.delete.includes(JSON.stringify(job)));
  assert.ok(scripts.next.includes(JSON.stringify(job)));
  assert.ok(!/__JOB__|__VERSION__/.test(scripts.delete));
});

test('invalid numeric options are rejected', () => {
  const options = { fallback: 20, min: 1 };
  assert.equal(integerOption(undefined, 'batch', options), 20);
  assert.equal(integerOption('5', 'batch', options), 5);
  for (const value of ['0', '-1', '2.5', 'ten', '']) assert.throws(() => integerOption(value, 'batch', options));
});

test('the next batch skips deleted files and stops when an approved file became used', () => {
  const approved = ['a', 'b', 'c'].map((id) => ({ id, name: id }));
  const unused = (...ids) => ids.map((id) => ({ id, status: 'unused' }));
  assert.deepEqual(selectBatch(approved, unused('b', 'c', 'new'), 1), { batch: [approved[1]], remaining: 2 });
  assert.deepEqual(selectBatch(approved, [], 20), { batch: [], remaining: 0 });
  // 이번 묶음 밖의 파일이 바뀌어도 중단한다.
  const changed = [...unused('a', 'b'), { id: 'c', status: 'referenced' }];
  assert.throws(() => selectBatch(approved, changed, 1), /c/);
});

test('the limiter caps concurrency and starts nothing new after a failure', async () => {
  const limited = limiter(2);
  let active = 0;
  let peak = 0;
  const task = async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return value;
  };
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map((n) => limited(() => task(n)))), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);

  const failing = limiter(1);
  let started = 0;
  const results = await Promise.allSettled(
    [0, 1, 2].map(() =>
      failing(async () => {
        started++;
        throw new Error('boom');
      }),
    ),
  );
  assert.equal(started, 1);
  assert.ok(results.every((r) => r.status === 'rejected'));
});

test('every module loads', async () => {
  for (const name of ['gitbook', 'scan', 'login']) await import(`../scripts/${name}.mjs`);
  const usage = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/gblc.mjs', import.meta.url))]);
  assert.equal(usage.status, 2);
});
