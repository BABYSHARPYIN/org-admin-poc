const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const storageKey = 'org-admin-sync-poc-v1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

function loadPage({ stored, syncDelay = 25, tree } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://babysharpyin.github.io/org-admin-poc/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.__orgSyncDelayMs = syncDelay;
      if (stored) window.localStorage.setItem(storageKey, stored);
      if (tree) window.__publishedOrgTree = tree;
    },
  });
  const { window } = dom;
  const { document } = window;
  const get = (id) => {
    const element = document.getElementById(id);
    assert(element, `Missing control: ${id}`);
    return element;
  };
  const start = (source, scenario) => {
    assert.equal(typeof window.__orgSyncDemo?.start, 'function', 'async organization task entry must exist');
    return window.__orgSyncDemo.start(source, scenario);
  };
  const text = (id) => get(id).textContent.trim();
  const treeText = () => text('org-tree');
  const openDetails = () => {
    const active = ['running', 'publishing', 'pending'].includes(get('btn-refresh-org').dataset.status);
    const entry = get(active ? 'btn-refresh-org' : 'btn-org-sync-details');
    assert.equal(entry.hidden, false, 'latest task progress entry must be visible');
    assert.equal(entry.disabled, false, 'progress entry must remain clickable');
    assert.equal(entry.textContent.trim(), '同步进度');
    entry.click();
    assert(get('modal-org-sync').classList.contains('show'), 'details dialog should open');
  };
  const closeDetails = () => {
    const close = get('modal-org-sync').querySelector('[data-close="modal-org-sync"]');
    assert(close, 'details dialog must have a close control');
    close.click();
  };
  const storedTask = () => window.localStorage.getItem(storageKey);
  const assertHealthy = () => assert.deepEqual(errors, [], 'page should not raise uncaught script errors');
  return { dom, window, document, get, start, text, treeText, openDetails, closeDetails, storedTask, assertHealthy };
}

async function waitUntil(predicate, message, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(10);
  }
}

async function completed(page) {
  await waitUntil(() => !['running', 'publishing'].includes(page.get('btn-refresh-org').dataset.status), 'task should leave its running phase');
  page.assertHealthy();
}

async function test(name, run) {
  try {
    await run();
    console.log('ok - ' + name);
  } catch (error) {
    failures.push(name);
    console.error('not ok - ' + name + ': ' + error.message);
  }
}

async function main() {
  // A missing entry point is a production failure, rather than a test harness error.
  const baseline = loadPage();
  try {
    assert.equal(typeof baseline.window.__orgSyncDemo?.start, 'function', 'async organization task entry must exist');
    assert.equal(baseline.text('org-sync-modal-title'), '同步进度', 'progress modal must use a single consistent title');
    for (const id of ['org-sync-row', 'org-sync-status', 'org-sync-detail-summary', 'org-sync-detail-count', 'org-sync-detail-users', 'org-sync-detail-permission', 'org-sync-detail-note']) {
      assert.equal(baseline.document.getElementById(id), null, `${id} must be removed from the compact interface`);
    }
    baseline.assertHealthy();
  } finally {
    baseline.dom.window.close();
  }

  await test('users without organization belong to the root in display and organization filters', async () => {
    const page = loadPage();
    try {
      const search = page.get('user-search');
      search.value = 'liuyang';
      search.dispatchEvent(new page.window.Event('input'));
      const cell = page.document.querySelector('#user-tbody .org-cell');
      assert.equal(cell?.textContent.trim(), '星河科技集团', 'user without SSO organization must display the root name');
      const root = [...page.document.querySelectorAll('#org-tree .tree-label')].find((label) => label.textContent === '星河科技集团')?.closest('.tree-row');
      assert(root, 'root filter must exist');
      root.click();
      assert(page.text('user-tbody').includes('liuyang'), 'root filter must actually include the user');
      const department = [...page.document.querySelectorAll('#org-tree .tree-label')].find((label) => label.textContent === '研发部')?.closest('.tree-row');
      assert(department, 'department filter must exist');
      department.click();
      assert(!page.text('user-tbody').includes('liuyang'), 'root membership must not put user in child departments');
      page.get('btn-create-user').click();
      page.get('uf-name').value = '无组织新用户';
      page.get('uf-account').value = 'root-user-test';
      page.get('uf-password').value = 'secret1';
      page.get('btn-save-user').click();
      search.value = 'root-user-test';
      search.dispatchEvent(new page.window.Event('input'));
      const selected = page.document.querySelector('#org-tree .tree-row.active');
      if (selected) selected.click();
      assert.equal(page.document.querySelector('#user-tbody .org-cell')?.textContent.trim(), '星河科技集团', 'new user without organization must also belong to root');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('manual refresh runs in the background and publishes only after completion', async () => {
    const page = loadPage({ syncDelay: 80 });
    try {
      const before = page.treeText();
      page.get('btn-refresh-org').click();
      assert.equal(page.get('btn-refresh-org').disabled, false, 'running task must keep progress entry usable');
      assert.equal(page.text('btn-refresh-org'), '同步进度', 'refresh button becomes progress entry while active');
      assert.equal(page.get('btn-org-sync-details').hidden, true, 'active task must have only one progress entry');
      page.openDetails();
      assert.equal(page.get('btn-refresh-org').dataset.status, 'running', 'opening progress must not replace the running task');
      assert.match(page.text('org-sync-detail-status'), /同步|处理/);
      page.closeDetails();
      assert.equal(page.treeText(), before, 'running task must keep the published tree');
      page.document.querySelector('[data-page="kb-perm"]').click();
      await completed(page);
      assert(['success', 'unchanged'].includes(page.get('btn-refresh-org').dataset.status), 'completion should be recorded after leaving the page');
      assert.equal(page.get('org-sync-dot').hidden, false, 'unseen completion should leave a sidebar dot');
      page.document.querySelector('[data-page="org-users"]').click();
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, true, 'normal success is view-only');
      assert.equal(page.get('org-sync-dot').hidden, true, 'reading a normal result should clear its unread dot');
    } finally { page.dom.window.close(); }
  });

  await test('a pending candidate preserves published data until explicit confirmation', async () => {
    const page = loadPage();
    try {
      const before = page.treeText();
      const usersBefore = page.text('user-tbody');
      page.start('manual', 'pending');
      await completed(page);
      assert.equal(page.get('btn-refresh-org').dataset.status, 'pending');
      assert.equal(page.treeText(), before, 'pending candidate cannot replace the published tree');
      assert.equal(page.text('user-tbody'), usersBefore, 'pending candidate must preserve published member relationships');
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, false);
      assert.equal(page.get('btn-org-sync-cancel').hidden, false, 'pending task must offer actual cancellation');
      page.closeDetails();
      assert.equal(page.treeText(), before, 'closing details is not consent');
      assert.equal(page.get('org-sync-dot').hidden, false, 'pending dot must survive reading/closing details');
      page.openDetails();
      page.get('btn-org-sync-confirm').click();
      assert.equal(page.get('modal-confirm').classList.contains('show'), false, 'confirmation must not add another heavy dialog');
      assert.equal(page.treeText(), before, 'confirmed task must finish async publication before replacing the tree');
      await waitUntil(() => page.get('btn-refresh-org').dataset.status === 'success', 'confirmed candidate should publish');
      assert.notEqual(page.treeText(), before, 'confirmed candidate should update actual tree content');
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, true, 'already published result becomes view-only');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  for (const scenario of ['success', 'failure', 'unchanged']) {
    await test(`${scenario} result has details without a confirmation action`, async () => {
      const page = loadPage();
      try {
        const before = page.treeText();
        const usersBefore = page.text('user-tbody');
        page.start('scheduled', scenario);
        await completed(page);
        page.openDetails();
        assert.equal(page.get('btn-org-sync-confirm').hidden, true);
        assert.equal(page.get('btn-org-sync-cancel').hidden, true, 'finished task is view-only');
        assert.equal(page.text('btn-refresh-org'), '刷新组织', 'finished task releases manual refresh');
        assert.equal(page.document.getElementById('org-sync-row'), null, 'finished task should not keep a separate notification row');
        assert.equal(page.get('btn-org-sync-details').hidden, false, 'finished task should retain a compact details entry');
        if (scenario === 'failure' || scenario === 'unchanged') {
          assert.equal(page.treeText(), before, `${scenario} must not change the published tree`);
          assert.equal(page.text('user-tbody'), usersBefore, `${scenario} must preserve published member relationships`);
        }
        assert.match(page.get('modal-org-sync').textContent, /定时/, 'details must identify scheduled trigger');
        page.assertHealthy();
      } finally { page.dom.window.close(); }
    });
  }

  await test('cancelling a pending update keeps published data and permits another synchronization', async () => {
    const page = loadPage();
    try {
      const before = page.treeText();
      const usersBefore = page.text('user-tbody');
      page.start('manual', 'pending');
      await completed(page);
      page.openDetails();
      page.get('btn-org-sync-cancel').click();
      assert.equal(page.get('btn-refresh-org').dataset.status, 'cancelled', 'cancel must resolve the pending task');
      assert.equal(page.treeText(), before, 'cancel must preserve published organizations');
      assert.equal(page.text('user-tbody'), usersBefore, 'cancel must preserve published member relationships');
      assert.equal(page.get('btn-refresh-org').disabled, false, 'cancel must release the refresh action');
      assert.equal(page.get('org-sync-dot').hidden, true, 'cancel must clear the pending indicator');
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, true, 'cancelled candidate cannot be published later');
      assert.equal(page.get('btn-org-sync-cancel').hidden, true);
      page.closeDetails();
      page.start('manual', 'success');
      await completed(page);
      assert.equal(page.get('btn-refresh-org').dataset.status, 'success', 'a fresh demo should run after cancellation');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('reloading always restores initial demo data and discards legacy persisted state', async () => {
    let page = loadPage();
    try {
      const before = page.treeText();
      const usersBefore = page.text('user-tbody');
      page.start('manual', 'success');
      await completed(page);
      assert.notEqual(page.treeText(), before, 'demo must first change actual organization data');
      page.document.querySelector('#user-tbody [data-view]').click();
      page.get('uf-name').value = '刷新前的修改';
      page.get('btn-save-user').click();
      assert(page.text('user-tbody').includes('刷新前的修改'), 'demo user edit should be visible before reload');
      assert(page.storedTask() === null, 'demo changes must not be persisted');
      page.dom.window.close();
      const legacy = JSON.stringify({ task: { status: 'pending', source: 'scheduled', startedAt: Date.now(), stats: { before: 21, after: 1 } }, tree: [{ id: 'c1', name: '旧演示数据', type: 'company' }], users: [], kbMembers: [], lastSuccessAt: Date.now() });
      page = loadPage({ stored: legacy });
      assert.equal(page.treeText(), before, 'reload must restore initial organization data');
      assert.equal(page.text('user-tbody'), usersBefore, 'reload must restore initial users');
      assert.equal(page.get('btn-refresh-org').dataset.status, '', 'reload must discard old task results');
      assert.equal(page.text('btn-refresh-org'), '刷新组织', 'reload restores refresh action');
      assert.equal(page.get('btn-org-sync-details').hidden, true, 'initial page has no stale task details');
      assert.equal(page.get('org-sync-dot').hidden, true);
      assert.equal(page.get('btn-refresh-org').disabled, false);
      assert.equal(page.storedTask(), null, 'obsolete local state must be removed');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('duplicate triggers do not replace running or pending tasks', async () => {
    const page = loadPage({ syncDelay: 80 });
    try {
      page.start('manual', 'pending');
      page.start('scheduled', 'success');
      page.openDetails();
      assert.match(page.text('org-sync-detail-source'), /手动/, 'duplicate execution cannot replace the original trigger');
      page.closeDetails();
      await completed(page);
      assert.equal(page.get('btn-refresh-org').dataset.status, 'pending', 'running candidate must not be replaced');
      page.start('scheduled', 'success');
      assert.equal(page.get('btn-refresh-org').dataset.status, 'pending', 'new execution must not overwrite an unconfirmed result');
      page.openDetails();
      assert.match(page.text('org-sync-detail-source'), /手动/);
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('scheduled tasks use the same active button and latest terminal progress entry', async () => {
    const page = loadPage({ syncDelay: 80 });
    try {
      page.start('scheduled', 'pending');
      assert.equal(page.text('btn-refresh-org'), '同步进度');
      assert.equal(page.get('btn-org-sync-details').hidden, true);
      page.openDetails();
      const started = page.text('org-sync-detail-start');
      assert.match(page.text('org-sync-detail-source'), /定时/);
      page.closeDetails();
      await completed(page);
      page.openDetails();
      assert.equal(page.get('btn-refresh-org').dataset.status, 'pending', 'progress click must preserve pending task');
      assert.equal(page.text('org-sync-detail-start'), started, 'same button must retain the latest scheduled task');
      page.get('btn-org-sync-cancel').click();
      assert.equal(page.text('btn-refresh-org'), '刷新组织');
      assert.equal(page.get('btn-org-sync-details').hidden, false);
      page.openDetails();
      assert.match(page.text('org-sync-detail-status'), /取消/);
      assert.equal(page.text('org-sync-detail-start'), started);
      page.closeDetails();
      page.get('btn-refresh-org').click();
      assert.equal(page.get('btn-refresh-org').dataset.status, 'running', 'released refresh button starts the next task');
      page.openDetails();
      assert.match(page.text('org-sync-detail-source'), /手动/, 'new task replaces the prior scheduled result');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('a supplied customer tree changes actual nodes on successful publication', async () => {
    const tree = [{ id: 'c1', name: '星河科技集团', type: 'company', children: [{ id: 'd-new', name: '异步发布部门', type: 'dept' }] }];
    const page = loadPage({ tree });
    try {
      const before = page.treeText();
      page.start('manual', 'success');
      await completed(page);
      // A large drop must still obey protection, even if the success fixture was selected.
      if (page.get('btn-refresh-org').dataset.status === 'pending') {
        page.openDetails();
        page.get('btn-org-sync-confirm').click();
        await waitUntil(() => page.get('btn-refresh-org').dataset.status === 'success', 'candidate should finish publishing');
      }
      assert.notEqual(page.treeText(), before);
      assert(page.treeText().includes('异步发布部门'), 'actual customer nodes must render');
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  for (const [name, tree] of [
    ['empty tree', []],
    ['orphan parent', [{ id: 'c1', name: '根节点', children: [{ id: 'd-orphan', name: '孤儿节点', parentCustomerOrgId: 'missing-parent' }] }]],
    ['duplicate node', [{ id: 'c1', name: '根节点', children: [{ id: 'c1', name: '重复节点' }] }]],
  ]) {
    await test(`${name} is rejected without a publish override`, async () => {
      const page = loadPage({ tree });
      try {
        const before = page.treeText();
        page.start('manual', 'success');
        await completed(page);
        assert.equal(page.get('btn-refresh-org').dataset.status, 'failure');
        assert.equal(page.treeText(), before, 'invalid data must keep the published tree');
        page.openDetails();
        assert.equal(page.get('btn-org-sync-confirm').hidden, true, 'invalid data cannot be force-published');
        page.assertHealthy();
      } finally { page.dom.window.close(); }
    });
  }

  if (failures.length) throw new Error(`${failures.length} async organization regression(s) failed`);
  console.log('async organization sync tests passed');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
