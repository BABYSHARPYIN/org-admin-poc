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
    get('btn-org-sync-details').click();
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
  await waitUntil(() => !['running', 'publishing'].includes(page.get('org-sync-status').dataset.status), 'task should leave its running phase');
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
    baseline.assertHealthy();
  } finally {
    baseline.dom.window.close();
  }

  await test('manual refresh runs in the background and publishes only after completion', async () => {
    const page = loadPage({ syncDelay: 80 });
    try {
      const before = page.treeText();
      page.get('btn-refresh-org').click();
      assert(page.get('btn-refresh-org').disabled, 'refresh must disable while running');
      assert(/同步|处理/.test(page.text('org-sync-message')), 'page should expose background progress');
      assert.equal(page.treeText(), before, 'running task must keep the published tree');
      page.document.querySelector('[data-page="kb-perm"]').click();
      await completed(page);
      assert(['success', 'unchanged'].includes(page.get('org-sync-status').dataset.status), 'completion should be recorded after leaving the page');
      assert.equal(page.get('org-sync-dot').hidden, false, 'unseen completion should leave a sidebar dot');
      page.document.querySelector('[data-page="org-users"]').click();
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, true, 'normal success is view-only');
      assert.equal(page.get('org-sync-dot').hidden, true, 'reading a normal result should clear its unread dot');
    } finally { page.dom.window.close(); }
  });

  await test('a pending candidate preserves published data until explicit second confirmation', async () => {
    const page = loadPage();
    try {
      const before = page.treeText();
      const usersBefore = page.text('user-tbody');
      page.start('manual', 'pending');
      await completed(page);
      assert.equal(page.get('org-sync-status').dataset.status, 'pending');
      assert.equal(page.treeText(), before, 'pending candidate cannot replace the published tree');
      assert.equal(page.text('user-tbody'), usersBefore, 'pending candidate must preserve published member relationships');
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, false);
      page.closeDetails();
      assert.equal(page.treeText(), before, 'closing details is not consent');
      assert.equal(page.get('org-sync-dot').hidden, false, 'pending dot must survive reading/closing details');
      page.openDetails();
      page.get('btn-org-sync-confirm').click();
      assert(page.get('modal-confirm').classList.contains('show'), 'publish requires second risk confirmation');
      assert.equal(page.treeText(), before, 'first confirm action cannot publish yet');
      page.get('modal-confirm').querySelector('[data-close="modal-confirm"]').click();
      assert.equal(page.treeText(), before, 'cancelled risk confirmation must keep old data');
      page.get('btn-org-sync-confirm').click();
      page.get('btn-confirm-ok').click();
      await waitUntil(() => page.get('org-sync-status').dataset.status === 'success', 'confirmed candidate should publish');
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
        if (scenario === 'failure' || scenario === 'unchanged') {
          assert.equal(page.treeText(), before, `${scenario} must not change the published tree`);
          assert.equal(page.text('user-tbody'), usersBefore, `${scenario} must preserve published member relationships`);
        }
        assert.match(page.get('modal-org-sync').textContent, /定时/, 'details must identify scheduled trigger');
        page.assertHealthy();
      } finally { page.dom.window.close(); }
    });
  }

  await test('running and pending tasks survive reopening the page', async () => {
    let page = loadPage({ syncDelay: 160 });
    try {
      page.start('scheduled', 'pending');
      const stored = page.storedTask();
      assert(stored, 'task must persist outside the current DOM');
      page.dom.window.close();
      page = loadPage({ stored, syncDelay: 160 });
      assert(page.get('btn-refresh-org').disabled, 'restored running task keeps refresh disabled');
      await completed(page);
      assert.equal(page.get('org-sync-status').dataset.status, 'pending');
      const pending = page.storedTask();
      page.dom.window.close();
      page = loadPage({ stored: pending });
      assert.equal(page.get('org-sync-status').dataset.status, 'pending', 'pending result should survive a reload');
      page.openDetails();
      assert.equal(page.get('btn-org-sync-confirm').hidden, false);
      page.assertHealthy();
    } finally { page.dom.window.close(); }
  });

  await test('duplicate triggers do not replace running or pending tasks', async () => {
    const page = loadPage({ syncDelay: 80 });
    try {
      page.start('manual', 'pending');
      const running = page.storedTask();
      page.start('scheduled', 'success');
      assert.equal(page.storedTask(), running, 'duplicate execution must reuse the running task');
      await completed(page);
      const pending = page.storedTask();
      page.start('scheduled', 'success');
      assert.equal(page.storedTask(), pending, 'new execution must not overwrite unconfirmed result');
      assert.equal(page.get('org-sync-status').dataset.status, 'pending');
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
      if (page.get('org-sync-status').dataset.status === 'pending') {
        page.openDetails();
        page.get('btn-org-sync-confirm').click();
        page.get('btn-confirm-ok').click();
        await waitUntil(() => page.get('org-sync-status').dataset.status === 'success', 'candidate should finish publishing');
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
        assert.equal(page.get('org-sync-status').dataset.status, 'failure');
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
