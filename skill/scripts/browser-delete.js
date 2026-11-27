// GitBook Change Request 편집 화면(Library > Images, 목록 보기)에서 실행한다.
// 파일 ID가 일치하는 항목만 삭제하고, 예상과 다르면 즉시 멈춘다. 진행 상황: window.__gblc
// 삭제 함수를 페이지에 한 번 올린다. 다음 묶음은 작업 목록만 전달한다(next.js).
(() => {
  const run = (job) => {
    if (window.__gblc?.state === 'running') return 'already running';

    const path = location.pathname;
    const onTarget =
      path.includes(`/s/${job.spaceId}/`) &&
      new RegExp(`/changes/${job.changeRequestNumber}(/|$)`).test(path) &&
      !path.includes('/diff/');
    if (location.hostname !== 'app.gitbook.com' || !onTarget) return 'refused: not the target change request editor';
    const search = () => document.querySelector('input[type="search"][placeholder^="Search images"]');
    if (!search()) return 'refused: open Library > Images first';

    const status = (window.__gblc = { state: 'running', total: job.files.length, done: [], error: null });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (find, what, ms = 8000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
        const found = find();
        if (found) return found;
      }
      throw new Error(`timeout: ${what}`);
    };
    const setSearch = (value) => {
      const input = search();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fileId = (element) => {
      let fiber = element[Object.keys(element).find((k) => k.startsWith('__reactFiber'))];
      for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
        const file = fiber.memoizedProps?.file;
        if (file?.id) return file.id;
      }
      return null;
    };
    const rows = (file) =>
      [...document.querySelectorAll('[data-index] *')]
        .filter((e) => !e.children.length && e.textContent.trim() === file.name && fileId(e) === file.id)
        .map((e) => e.closest('[data-index]'));
    const press = async (element, appeared) => {
      element.click();
      await sleep(600);
      if (appeared()) return;
      const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true };
      element.dispatchEvent(new PointerEvent('pointerdown', init));
      element.dispatchEvent(new PointerEvent('pointerup', init));
    };
    const menuDelete = () =>
      [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === 'Delete');
    const dialog = () => document.querySelector('[role="dialog"], [role="alertdialog"]');

    (async () => {
      for (const file of job.files) {
        status.current = file.name;
        if (dialog()) throw new Error('unexpected dialog is open');
        setSearch(file.name);
        const row = await waitFor(() => rows(file)[0], `row for ${file.name} (${file.id}); use list view`);
        await sleep(400);
        if (rows(file).length !== 1) throw new Error(`ambiguous rows: ${file.name}`);
        const buttons = row.querySelectorAll('button');
        if (buttons.length !== 1) throw new Error(`unexpected row layout: ${file.name}`);
        await press(buttons[0], menuDelete);
        const item = await waitFor(menuDelete, 'Delete menu item');
        if (rows(file).length !== 1 || rows(file)[0] !== row) throw new Error(`row changed: ${file.name}`);
        await press(item, dialog);
        const box = await waitFor(dialog, 'confirm dialog');
        if (!box.textContent.includes(`Delete "${file.name}"?`)) throw new Error(`dialog mismatch: ${file.name}`);
        const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete');
        if (!confirm) throw new Error('confirm button not found');
        confirm.click();
        await waitFor(() => !dialog() && !rows(file).length, `removal of ${file.name}`);
        status.done.push(file.id);
      }
      setSearch('');
      status.state = 'finished';
    })().catch((error) => {
      status.state = 'stopped';
      status.error = error.message;
    });
    return `started: ${job.files.length} files`;
  };
  window.__gblcRun = Object.assign(run, { version: '__VERSION__' });
  return run(__JOB__);
})();
