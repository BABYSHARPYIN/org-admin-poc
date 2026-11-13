const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const htmlPath = path.join(__dirname, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const userTable = html.match(/<table class="data user-table">[\s\S]*?<tbody id="user-tbody">/);
check(userTable, "user list table markup should be present");
if (userTable) {
  check(
    userTable[0].includes("<th>组织信息</th>"),
    "user table should have an 组织信息 column"
  );
  check(
    /<th>姓名<\/th>[\s\S]*<th>账号<\/th>[\s\S]*<th>邮箱<\/th>[\s\S]*<th>手机号<\/th>[\s\S]*<th>组织信息<\/th>[\s\S]*<th>账号类型<\/th>[\s\S]*<th class="action-col">操作<\/th>/.test(userTable[0]),
    "组织信息 should sit with the existing user columns: 姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 账号类型 / 操作"
  );
}

check(!html.includes("功能角色"), "the POC should not show the invented term 功能角色");
check(!html.includes("用户详情"), "an existing user drawer should be titled 用户信息, not 用户详情");
check(html.includes('placeholder="请输入邮箱地址"'), "邮箱 placeholder should match production: 请输入邮箱地址");
check(html.includes('placeholder="请输入手机号"'), "手机号 placeholder should match production: 请输入手机号");
check(html.includes(">账号类型<") || html.includes(">账号类型<span"), "user drawer should label the account type 账号类型");
check(/<select[^>]*id="uf-account-type"/.test(html), "账号类型 should be a single-select control");
check(
  /textContent = isEdit \? "用户信息" : "新增用户"/.test(html),
  "edit drawer title should be 用户信息 and create should stay 新增用户"
);
check(!html.includes("（预置）"), "账号类型 options should use the role names without a （预置） suffix");
const kbTable = html.match(/<table class="data">[\s\S]*?<tbody id="kb-member-tbody">/);
check(kbTable && kbTable[0].includes("<th>角色</th>"), "knowledge-base auth table should keep the resource column 角色");

check(!html.includes("当前组织"), "user list should not show the 当前组织 breadcrumb");
check(!html.includes("清除选择"), "user list should not show 清除选择");
check(!html.includes("全部用户"), "org tree should not include a synthetic 全部用户 node");
check(!html.includes("tree-badge"), "org tree should not render member counts");
check(html.includes("<h2>组织信息</h2>"), "organization tree heading should be 组织信息");
check(!html.includes('id="filter-hint"'), "org filter chip markup should be removed");
check(!html.includes('id="clear-filter"'), "clear-selection control should be removed");
const searchFn = html.match(/function currentUserResults\(\) \{[\s\S]*?return list;\s*\}/);
check(
  !!(searchFn && searchFn[0].includes("customerInfo")),
  "user search should match serialized customer user-info (customerInfo)"
);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withPage(run) {
  const port = 9333;
  const userData = fs.mkdtempSync("/tmp/chrome-user-list-");
  const chrome = spawn(
    "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    let version;
    for (let i = 0; i < 50; i += 1) {
      try {
        version = JSON.parse(await get(`http://127.0.0.1:${port}/json/version`));
        break;
      } catch (error) {
        await sleep(100);
      }
    }
    if (!version) throw new Error("Chrome did not expose a debugging port");

    const pages = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
    const page = pages.find((item) => item.type === "page");
    if (!page) throw new Error("Chrome did not open a page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });

    function send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.text || "evaluation failed";
        const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
        throw new Error(desc || text);
      }
      return result.result.value;
    }

    await send("Page.enable");
    await send("Page.navigate", { url: "file://" + htmlPath });
    for (let i = 0; i < 50; i += 1) {
      const ready = await evaluate("document.querySelectorAll('#user-tbody tr').length > 0");
      if (ready) break;
      await sleep(100);
      if (i === 49) throw new Error("user table did not render");
    }

    await run(evaluate);
    ws.close();
  } finally {
    chrome.kill("SIGKILL");
  }
}

async function main() {
  if (failures.length) {
    console.error(failures.map((message) => "- " + message).join("\n"));
    process.exit(1);
  }

  await withPage(async (evaluate) => {
    const snapshot = await evaluate(`(() => {
      const text = document.body.innerText;
      const headers = Array.from(document.querySelectorAll("#page-org-users thead th")).map((th) => th.textContent.trim());
      const rows = Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) =>
        Array.from(tr.children).map((td) => td.textContent.trim())
      );
      return {
        headers,
        rows,
        showsCurrentOrg: text.includes("当前组织"),
        showsClear: text.includes("清除选择"),
        total: document.getElementById("user-pagination-label").textContent,
        treeLabels: Array.from(document.querySelectorAll("#org-tree .tree-label")).map((el) => el.textContent.trim()),
        activeRows: document.querySelectorAll("#org-tree .tree-row.active").length,
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
      };
    })()`);
    check(snapshot.toast !== "工号错误", "load/refresh 查不到 should not toast 工号错误, got " + snapshot.toast);

    check(
      snapshot.headers.join(" / ") === "姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 账号类型 / 操作",
      "rendered headers should be 姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 账号类型 / 操作, got " + snapshot.headers.join(" / ")
    );
    check(!snapshot.treeLabels.includes("全部用户"), "rendered org tree should not contain 全部用户, got " + snapshot.treeLabels.join(", "));
    check(snapshot.treeLabels[0] === "星河科技集团", "tree should start at the company root, got " + snapshot.treeLabels[0]);
    check(snapshot.activeRows === 0, "no org node should be selected on load");
    check(snapshot.total.includes("共 12 人"), "no selection should list every user, got " + snapshot.total);
    check(!snapshot.showsCurrentOrg, "rendered user list should not include 当前组织");
    check(!snapshot.showsClear, "rendered user list should not include 清除选择");

    const wang = snapshot.rows.find((row) => row[1] === "wangqiang");
    check(!!wang, "王强 should be on the first page");
    if (wang) {
      check(
        wang[4] === "星河科技集团 / 星河智造子公司 / 生产部 / 生产1部 / 操作工",
        "王强 组织信息 should be the full org path, got " + wang[4]
      );
    }
    const liu = snapshot.rows.find((row) => row[1] === "liuyang");
    check(!!liu, "刘洋 should be on the first page");
    if (liu) check(liu[4] === "--", "users without an org membership should show --, got " + liu[4]);

    const byJob = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "生产主管";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const rows = Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) => tr.children[1].textContent.trim());
      return { rows, total: document.getElementById("user-pagination-label").textContent };
    })()`);
    check(
      byJob.rows.length === 1 && byJob.rows[0] === "lina",
      "searching customer JSON value 生产主管 should match 李娜 only, got " + JSON.stringify(byJob)
    );

    const byKey = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "staffstatus";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const accounts = Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) => tr.children[1].textContent.trim());
      return { accounts, total: document.getElementById("user-pagination-label").textContent };
    })()`);
    const withCustomerInfo = ["zhangwei", "lina", "wangqiang", "zhaomin", "chenchen", "wulei", "zhengshuang", "yinyue"];
    check(
      byKey.total.includes("共 8 人") && withCustomerInfo.every((account) => byKey.accounts.includes(account)),
      "LIKE over serialized customer JSON should match staffStatus case-insensitively, got " + JSON.stringify(byKey)
    );

    const byName = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "wangqiang";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) => tr.children[0].textContent.trim());
    })()`);
    check(byName.length === 1 && byName[0] === "王强", "search should still match account, got " + JSON.stringify(byName));

    const filtered = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const label = Array.from(document.querySelectorAll("#org-tree .tree-label")).find((el) => el.textContent === "操作工");
      label.closest(".tree-row").click();
      const text = document.body.innerText;
      const rows = Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) =>
        Array.from(tr.children).map((td) => td.textContent.trim())
      );
      return {
        rows,
        total: document.getElementById("user-pagination-label").textContent,
        showsCurrentOrg: text.includes("当前组织"),
        showsClear: text.includes("清除选择"),
      };
    })()`);
    check(
      filtered.rows.length === 1 && filtered.rows[0][1] === "wangqiang",
      "selecting 操作工 should still filter the user list, got " + JSON.stringify(filtered.rows)
    );
    check(!filtered.showsCurrentOrg && !filtered.showsClear, "selecting a node should not bring back 当前组织 or 清除选择");

    const cleared = await evaluate(`(() => {
      const label = Array.from(document.querySelectorAll("#org-tree .tree-label")).find((el) => el.textContent === "操作工");
      label.closest(".tree-row").click();
      return {
        active: document.querySelectorAll("#org-tree .tree-row.active").length,
        total: document.getElementById("user-pagination-label").textContent,
        names: Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) => tr.children[0].textContent.trim()),
      };
    })()`);
    check(cleared.active === 0, "clicking the selected node again should clear the selection");
    check(
      cleared.total.includes("共 12 人") && cleared.names.includes("张伟") && cleared.names.includes("王强"),
      "clearing the org selection should show all users, got " + JSON.stringify(cleared)
    );

    const narrowed = await evaluate(`(() => {
      const label = Array.from(document.querySelectorAll("#org-tree .tree-label")).find((el) => el.textContent === "研发部");
      label.closest(".tree-row").click();
      const input = document.getElementById("user-search");
      input.value = "产品经理";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return Array.from(document.querySelectorAll("#user-tbody tr")).map((tr) => tr.children[1].textContent.trim()).sort();
    })()`);
    check(
      narrowed.join(",") === "yinyue,zhangwei",
      "org filter and customer-info search should combine, got " + JSON.stringify(narrowed)
    );

    const drawer = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll("#user-tbody tr")).find((tr) => tr.children[1].textContent.trim() === "yinyue");
      row.querySelector("[data-view]").click();
      const form = document.getElementById("user-form");
      const labels = Array.from(form.querySelectorAll(".form-row"))
        .filter((row) => row.style.display !== "none")
        .map((row) => row.querySelector("label").textContent.replace(/\\*/g, "").trim());
      const select = document.getElementById("uf-account-type");
      const options = Array.from(select.options).map((option) => option.textContent.trim());
      return {
        title: document.getElementById("user-modal-title").textContent.trim(),
        labels,
        emailPlaceholder: document.getElementById("uf-email").getAttribute("placeholder"),
        phonePlaceholder: document.getElementById("uf-phone").getAttribute("placeholder"),
        options,
        value: select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim() : "",
        multiple: !!select.multiple,
        forbidden: document.documentElement.innerHTML.includes("功能角色"),
        employeeLabel: document.querySelector('label[for="uf-employee-no"]').textContent.trim(),
        customerLabel: document.querySelector('label[for="uf-customer-info"]').textContent.trim(),
      };
    })()`);
    check(drawer.title === "用户信息", "opening 尹悦 should title the drawer 用户信息, got " + drawer.title);
    check(
      drawer.labels.join(" / ") === "姓名 / 账号 / 邮箱 / 手机号 / 账号类型 / 员工工号 / 员工信息",
      "edit drawer fields should follow production order plus the POC-only fields, got " + drawer.labels.join(" / ")
    );
    check(drawer.emailPlaceholder === "请输入邮箱地址", "邮箱 placeholder should be 请输入邮箱地址, got " + drawer.emailPlaceholder);
    check(drawer.phonePlaceholder === "请输入手机号", "手机号 placeholder should be 请输入手机号, got " + drawer.phonePlaceholder);
    check(!drawer.multiple, "账号类型 should be a single-select");
    check(
      drawer.options.join(" / ") === "管理员 / 子管理员 / 普通用户",
      "账号类型 options should be the existing demo roles, got " + drawer.options.join(" / ")
    );
    check(drawer.value === "普通用户", "尹悦 should open as 普通用户, got " + drawer.value);
    check(!drawer.forbidden, "rendered page should not contain 功能角色");
    check(drawer.employeeLabel === "员工工号", "员工工号 label should stay, got " + drawer.employeeLabel);
    check(drawer.customerLabel === "员工信息", "readonly customer JSON label should be 员工信息, got " + drawer.customerLabel);

    const saved = await evaluate(`(() => {
      const select = document.getElementById("uf-account-type");
      const admin = Array.from(select.options).find((option) => option.textContent.trim() === "管理员");
      select.value = admin.value;
      document.getElementById("btn-save-user").click();
      const row = Array.from(document.querySelectorAll("#user-tbody tr")).find((tr) => tr.children[1].textContent.trim() === "yinyue");
      return {
        accountType: row ? row.children[5].textContent.trim() : "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
      };
    })()`);
    check(saved.accountType === "管理员", "saving 账号类型 should update the list column, got " + saved.accountType);
    check(!saved.drawerOpen, "saving should close the user drawer");

    const created = await evaluate(`(() => {
      document.getElementById("btn-create-user").click();
      const select = document.getElementById("uf-account-type");
      return {
        title: document.getElementById("user-modal-title").textContent.trim(),
        value: select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim() : "",
        passwordVisible: document.getElementById("uf-password-row").style.display !== "none",
      };
    })()`);
    check(created.title === "新增用户", "create drawer title should stay 新增用户, got " + created.title);
    check(created.value === "普通用户", "new users should default to 普通用户, got " + created.value);
    check(created.passwordVisible, "create flow should still ask for a password");

    const kb = await evaluate(`(() => {
      document.querySelector('[data-page="kb-perm"]').click();
      const headers = Array.from(document.querySelectorAll("#page-kb-perm thead th")).map((th) => th.textContent.trim());
      const text = document.getElementById("page-kb-perm").innerText;
      return {
        headers,
        hasEditor: text.includes("编辑者"),
        hasViewer: text.includes("使用者"),
        hasOwner: text.includes("所有者"),
        forbidden: document.documentElement.innerHTML.includes("功能角色"),
      };
    })()`);
    check(
      kb.headers.join(" / ") === "成员 / 组织信息 / 角色 / 操作",
      "knowledge-base columns should stay unchanged, got " + kb.headers.join(" / ")
    );
    check(kb.hasEditor && kb.hasViewer && kb.hasOwner, "knowledge-base resource roles should stay 编辑者 / 使用者 / 所有者");
    check(!kb.forbidden, "knowledge-base page should not introduce 功能角色");

    const resetUsers = `(() => {
      document.querySelector('[data-page="org-users"]').click();
      const active = document.querySelector("#org-tree .tree-row.active");
      if (active) active.click();
      const input = document.getElementById("user-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`;
    await evaluate(resetUsers);

    function userSnapshot(account) {
      return `(() => {
        const input = document.getElementById("user-search");
        input.value = ${JSON.stringify(account)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const row = document.querySelector("#user-tbody tr");
        const cells = row ? Array.from(row.children).map((td) => td.textContent.trim()) : [];
        if (row) row.querySelector("[data-view]").click();
        return {
          cells,
          title: document.getElementById("user-modal-title").textContent.trim(),
          employeeNo: document.getElementById("uf-employee-no").value,
          customerInfo: document.getElementById("uf-customer-info").value,
          accountType: document.getElementById("uf-account-type").selectedOptions[0]
            ? document.getElementById("uf-account-type").selectedOptions[0].textContent.trim()
            : "",
          toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
        };
      })()`;
    }

    const liuLookup = await evaluate(userSnapshot("liuyang"));
    check(liuLookup.cells[4] === "--", "unknown seeded 工号 should leave 刘洋 with no org, got " + JSON.stringify(liuLookup.cells));
    check(liuLookup.employeeNo === "", "查不到 on load should clear 刘洋's 工号, got " + liuLookup.employeeNo);
    check(liuLookup.customerInfo === "", "查不到 on load should clear 刘洋's customer JSON, got " + liuLookup.customerInfo);
    check(liuLookup.accountType === "普通用户", "查不到 should keep 刘洋's functional role, got " + liuLookup.accountType);
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const cancelled = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "chenchen";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "NO-SUCH-CANCEL";
      field.dispatchEvent(new FocusEvent("blur"));
      const opened = document.getElementById("modal-confirm").classList.contains("show");
      document.querySelector('#modal-confirm [data-close="modal-confirm"]').click();
      const afterCancel = {
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
      };
      document.querySelector('#modal-user [data-close="modal-user"]').click();
      input.value = "chenchen";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      return {
        opened,
        afterCancel,
        employeeNo: afterCancel.employeeNo,
        org: row.children[4].textContent.trim(),
      };
    })()`);
    check(cancelled.opened, "changing 工号 should still ask for confirmation before lookup");
    check(
      cancelled.employeeNo === "XH10025" && cancelled.afterCancel.customerInfo.includes("XH10025") && cancelled.org.includes("前端工程师") && cancelled.afterCancel.drawerOpen,
      "cancelling a 工号 change should keep the previous number, JSON, and org without closing the drawer, got " + JSON.stringify(cancelled)
    );
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const unknownEdit = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "zhaomin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      const roleBefore = document.getElementById("uf-account-type").selectedOptions[0].textContent.trim();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "NO-SUCH-01";
      field.dispatchEvent(new FocusEvent("blur"));
      const confirmTitle = document.getElementById("confirm-title").textContent.trim();
      const confirmed = document.getElementById("modal-confirm").classList.contains("show");
      if (confirmed) document.getElementById("btn-confirm-ok").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const row = document.querySelector("#user-tbody tr");
      const cells = Array.from(row.children).map((td) => td.textContent.trim());
      return {
        confirmTitle,
        confirmed,
        roleBefore,
        toast: toast ? toast.textContent : "",
        toastError: toast ? toast.classList.contains("error") : false,
        cells,
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
        saved: false,
      };
    })()`);
    check(unknownEdit.confirmed && unknownEdit.confirmTitle === "确认变更员工工号", "blurring a changed 工号 should ask for confirmation before lookup, got " + unknownEdit.confirmTitle);
    check(unknownEdit.toast === "工号错误" && unknownEdit.toastError, "unknown 工号 should report 工号错误 on blur, got " + unknownEdit.toast);
    check(unknownEdit.drawerOpen, "工号 lookup should apply in the open drawer without waiting for 保存");
    check(unknownEdit.employeeNo === "", "unknown 工号 should be cleared in the drawer, got " + unknownEdit.employeeNo);
    check(unknownEdit.customerInfo === "", "unknown 工号 should clear customer JSON, got " + unknownEdit.customerInfo);
    check(unknownEdit.cells[4] === "--", "unknown 工号 should clear 组织信息 before save, got " + unknownEdit.cells[4]);
    check(
      unknownEdit.accountType === "普通用户" && unknownEdit.cells[5] === "普通用户",
      "unknown 工号 should keep the functional role, got " + unknownEdit.accountType + " / " + unknownEdit.cells[5]
    );
    const unknownSaved = await evaluate(`(() => {
      document.getElementById("btn-save-user").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "zhaomin";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      row.querySelector("[data-view]").click();
      return {
        toast: toast ? toast.textContent : "",
        confirmed: document.getElementById("modal-confirm").classList.contains("show"),
        employeeNo: document.getElementById("uf-employee-no").value,
        org: row.children[4].textContent.trim(),
      };
    })()`);
    check(unknownSaved.toast === "已保存" && !unknownSaved.confirmed, "saving after a blur lookup should not look the 工号 up again, got " + JSON.stringify(unknownSaved));
    check(unknownSaved.employeeNo === "" && unknownSaved.org === "--", "save should keep the cleared 工号 and org, got " + JSON.stringify(unknownSaved));
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const zhaoGrant = await evaluate(`(() => {
      document.querySelector('[data-page="kb-perm"]').click();
      const direct = document.querySelector('#kb-member-tbody select[data-kind="user"][data-id="zhaomin"]');
      const orgGrant = document.querySelector('#kb-member-tbody select[data-kind="org"][data-id="d2"]');
      return {
        direct: direct ? direct.value : "",
        orgGrant: orgGrant ? orgGrant.value : "",
      };
    })()`);
    check(zhaoGrant.direct === "editor", "unknown 工号 should keep 赵敏's direct resource grant, got " + zhaoGrant.direct);
    check(zhaoGrant.orgGrant === "viewer", "clearing one user's org should keep the department grant, got " + zhaoGrant.orgGrant);
    await evaluate(`document.querySelector('[data-page="org-users"]').click()`);

    const createdBlur = await evaluate(`(() => {
      document.getElementById("btn-create-user").click();
      document.getElementById("uf-name").value = "未建档";
      document.getElementById("uf-account").value = "no-such-user";
      document.getElementById("uf-password").value = "secret1";
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "NO-SUCH-02";
      field.dispatchEvent(new FocusEvent("blur"));
      const toast = document.querySelector("#toast-wrap .toast");
      return {
        confirmed: document.getElementById("modal-confirm").classList.contains("show"),
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
        toast: toast ? toast.textContent : "",
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
      };
    })()`);
    check(!createdBlur.confirmed, "creating a user should not ask to confirm a new 工号");
    check(createdBlur.drawerOpen, "create lookup should stay in the new-user drawer");
    check(createdBlur.toast === "工号错误", "creating an unknown 工号 should report 工号错误 on blur, got " + createdBlur.toast);
    check(createdBlur.employeeNo === "" && createdBlur.customerInfo === "", "creating an unknown 工号 should clear the field and JSON before save, got " + JSON.stringify(createdBlur));
    const createdUnknown = await evaluate(`(() => {
      document.getElementById("btn-save-user").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "no-such-user";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      const cells = row ? Array.from(row.children).map((td) => td.textContent.trim()) : [];
      if (row) row.querySelector("[data-view]").click();
      return {
        toast: toast ? toast.textContent : "",
        cells,
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0]
          ? document.getElementById("uf-account-type").selectedOptions[0].textContent.trim()
          : "",
      };
    })()`);
    check(createdUnknown.toast === "已创建用户 未建档", "saving after the blur lookup should not report 工号错误 again, got " + createdUnknown.toast);
    check(createdUnknown.cells[0] === "未建档" && createdUnknown.cells[4] === "--", "created unknown 工号 should be saved with no org, got " + JSON.stringify(createdUnknown.cells));
    check(createdUnknown.employeeNo === "" && createdUnknown.customerInfo === "", "created unknown 工号 should be stored as no employee number, got " + createdUnknown.employeeNo);
    check(createdUnknown.accountType === "普通用户", "created unknown 工号 should keep the selected functional role, got " + createdUnknown.accountType);
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const blankCreate = await evaluate(`(() => {
      document.getElementById("btn-create-user").click();
      document.getElementById("uf-name").value = "无工号";
      document.getElementById("uf-account").value = "no-number-user";
      document.getElementById("uf-password").value = "secret1";
      document.getElementById("uf-employee-no").value = "";
      document.getElementById("btn-save-user").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "no-number-user";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      const cells = row ? Array.from(row.children).map((td) => td.textContent.trim()) : [];
      if (row) row.querySelector("[data-view]").click();
      return {
        toast: toast ? toast.textContent : "",
        cells,
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
      };
    })()`);
    check(blankCreate.toast === "已创建用户 无工号", "blank 工号 on create should not sync or report 工号错误, got " + blankCreate.toast);
    check(
      blankCreate.cells[4] === "--" && blankCreate.employeeNo === "" && blankCreate.customerInfo === "",
      "blank 工号 on create should have no org affiliation, got " + JSON.stringify(blankCreate)
    );
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const matched = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "sunhao";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      document.getElementById("toast-wrap").replaceChildren();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "XH10029";
      field.dispatchEvent(new FocusEvent("blur"));
      if (document.getElementById("modal-confirm").classList.contains("show")) {
        document.getElementById("btn-confirm-ok").click();
      }
      const toast = document.querySelector("#toast-wrap .toast");
      const row = document.querySelector("#user-tbody tr");
      const cells = Array.from(row.children).map((td) => td.textContent.trim());
      return {
        toast: toast ? toast.textContent : "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
        cells,
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
      };
    })()`);
    check(matched.toast !== "工号错误", "a directory hit should not report 工号错误, got " + matched.toast);
    check(matched.drawerOpen, "a directory hit should write the drawer before 保存");
    check(matched.employeeNo === "XH10029", "a directory hit should keep the 工号, got " + matched.employeeNo);
    check(
      matched.customerInfo.includes("XH10029") && matched.customerInfo.includes("销售支持"),
      "a directory hit should write the customer user JSON on blur, got " + matched.customerInfo
    );
    check(
      matched.cells[4] === "星河科技集团 / 星河数据子公司 / 销售部" && matched.accountType === "普通用户",
      "a directory hit with a department should update membership and keep the functional role, got " + JSON.stringify(matched.cells)
    );
    const matchedSave = await evaluate(`(() => {
      const removed = window.__customerDirectory ? window.__customerDirectory.XH10029 : null;
      if (window.__customerDirectory) delete window.__customerDirectory.XH10029;
      document.getElementById("btn-save-user").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "sunhao";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      row.querySelector("[data-view]").click();
      const result = {
        toast: toast ? toast.textContent : "",
        confirmed: document.getElementById("modal-confirm").classList.contains("show"),
        org: row.children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
      };
      if (window.__customerDirectory && removed) window.__customerDirectory.XH10029 = removed;
      return result;
    })()`);
    check(
      matchedSave.toast === "已保存" && !matchedSave.confirmed && matchedSave.employeeNo === "XH10029" && matchedSave.customerInfo.includes("销售支持") && matchedSave.org.includes("销售部"),
      "save should not look the 工号 up again after blur, got " + JSON.stringify(matchedSave)
    );
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const noDept = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "dinglan";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      document.getElementById("toast-wrap").replaceChildren();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "XH10030";
      field.dispatchEvent(new FocusEvent("blur"));
      if (document.getElementById("modal-confirm").classList.contains("show")) {
        document.getElementById("btn-confirm-ok").click();
      }
      const toast = document.querySelector("#toast-wrap .toast");
      const row = document.querySelector("#user-tbody tr");
      const cells = Array.from(row.children).map((td) => td.textContent.trim());
      return {
        toast: toast ? toast.textContent : "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
        cells,
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
      };
    })()`);
    check(noDept.drawerOpen, "a hit without a department should update the open drawer");
    check(noDept.toast !== "工号错误", "a hit without a department should not report 工号错误, got " + noDept.toast);
    check(noDept.employeeNo === "XH10030", "a hit without a department should keep the 工号, got " + noDept.employeeNo);
    check(
      noDept.customerInfo.includes("XH10030") && noDept.customerInfo.includes("顾问"),
      "a hit without a department should still write the customer JSON, got " + noDept.customerInfo
    );
    check(noDept.cells[4] === "--", "a hit without a department should clear org affiliation, got " + noDept.cells[4]);
    check(noDept.accountType === "子管理员" && noDept.cells[5] === "子管理员", "a hit without a department should keep the functional role, got " + noDept.accountType);
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const unchangedView = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "zhangwei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const before = document.querySelector("#user-tbody tr").children[4].textContent.trim();
      document.querySelector("#user-tbody [data-view]").click();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.dispatchEvent(new FocusEvent("blur"));
      const blurredConfirm = document.getElementById("modal-confirm").classList.contains("show");
      document.getElementById("btn-save-user").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const confirmed = document.getElementById("modal-confirm").classList.contains("show");
      input.value = "zhangwei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      row.querySelector("[data-view]").click();
      return {
        before,
        confirmed: confirmed || blurredConfirm,
        toast: toast ? toast.textContent : "",
        org: row.children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
      };
    })()`);
    check(!unchangedView.confirmed, "saving without a 工号 change should not ask to sync");
    check(
      unchangedView.toast === "已保存" && unchangedView.employeeNo === "XH10021" && unchangedView.org === unchangedView.before && unchangedView.org.includes("研发部"),
      "opening and saving a linked user should keep 工号 and org, got " + JSON.stringify(unchangedView)
    );
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const clearedNo = await evaluate(`(() => {
      const input = document.getElementById("user-search");
      input.value = "wulei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      document.getElementById("toast-wrap").replaceChildren();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "";
      field.dispatchEvent(new FocusEvent("blur"));
      const confirmed = document.getElementById("modal-confirm").classList.contains("show");
      if (confirmed) document.getElementById("btn-confirm-ok").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const row = document.querySelector("#user-tbody tr");
      return {
        confirmed,
        toast: toast ? toast.textContent : "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
        org: row.children[4].textContent.trim(),
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
      };
    })()`);
    check(clearedNo.confirmed, "clearing an existing 工号 should still ask for confirmation");
    check(clearedNo.drawerOpen, "clearing a 工号 should apply in the open drawer");
    check(clearedNo.toast === "", "clearing a 工号 on purpose should not report 工号错误, got " + clearedNo.toast);
    check(
      clearedNo.employeeNo === "" && clearedNo.customerInfo === "" && clearedNo.org === "--" && clearedNo.accountType === "普通用户",
      "an explicit empty 工号 should drop org affiliation and keep the functional role, got " + JSON.stringify(clearedNo)
    );
    await evaluate(`document.querySelector('#modal-user [data-close="modal-user"]').click()`);

    const lookupDown = await evaluate(`(() => {
      if (!("__customerLookupDown" in window) || !window.__customerDirectory) {
        return { error: "missing-directory-controls" };
      }
      window.__customerLookupDown = true;
      document.getElementById("btn-refresh-org").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "zhangwei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      row.querySelector("[data-view]").click();
      const result = {
        toast: toast ? toast.textContent : "",
        org: row.children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
      };
      window.__customerLookupDown = false;
      document.querySelector('#modal-user [data-close="modal-user"]').click();
      return result;
    })()`);
    check(!lookupDown.error, "mock directory failure should be distinguishable from 查不到, got " + JSON.stringify(lookupDown));
    check(
      lookupDown.toast === "工号查询失败，未更新员工工号",
      "lookup failure should not be reported as 工号错误, got " + lookupDown.toast
    );
    check(
      lookupDown.employeeNo === "XH10021" && (lookupDown.org || "").includes("研发部") && (lookupDown.customerInfo || "").includes("XH10021"),
      "lookup failure should not clear 工号 or org, got " + JSON.stringify(lookupDown)
    );

    const refreshMiss = await evaluate(`(() => {
      if (!window.__customerDirectory) return { error: "missing-directory-controls" };
      const removed = window.__customerDirectory.XH10022;
      delete window.__customerDirectory.XH10022;
      document.getElementById("btn-refresh-org").click();
      const toast = document.querySelector("#toast-wrap .toast");
      const input = document.getElementById("user-search");
      input.value = "lina";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const row = document.querySelector("#user-tbody tr");
      const cells = Array.from(row.children).map((td) => td.textContent.trim());
      row.querySelector("[data-view]").click();
      const lina = {
        cells,
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
      };
      document.querySelector('#modal-user [data-close="modal-user"]').click();
      input.value = "zhangwei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const zhang = document.querySelector("#user-tbody tr");
      zhang.querySelector("[data-view]").click();
      const kept = {
        org: zhang.children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
      };
      document.querySelector('#modal-user [data-close="modal-user"]').click();
      input.value = "zhoufang";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const zhouRow = document.querySelector("#user-tbody tr");
      zhouRow.querySelector("[data-view]").click();
      const zhou = {
        org: zhouRow.children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
      };
      window.__customerDirectory.XH10022 = removed;
      return {
        toast: toast ? toast.textContent : "",
        lina,
        kept,
        zhou,
      };
    })()`);
    check(!refreshMiss.error, "refresh should look up linked users in the mock directory, got " + JSON.stringify(refreshMiss));
    check(refreshMiss.toast !== "工号错误", "refresh 查不到 should clear without the admin 工号错误 toast, got " + refreshMiss.toast);
    check(refreshMiss.toast === "已从客户系统刷新组织", "refresh should still confirm the org publish, got " + refreshMiss.toast);
    check(
      !!refreshMiss.lina && refreshMiss.lina.employeeNo === "" && refreshMiss.lina.customerInfo === "" && refreshMiss.lina.cells[4] === "--",
      "refresh 查不到 should clear 工号 and org, got " + JSON.stringify(refreshMiss.lina)
    );
    check(
      !!refreshMiss.lina && refreshMiss.lina.accountType === "子管理员" && refreshMiss.lina.cells[5] === "子管理员",
      "refresh 查不到 should keep the functional role, got " + JSON.stringify(refreshMiss.lina)
    );
    check(
      !!refreshMiss.kept && refreshMiss.kept.employeeNo === "XH10021" && refreshMiss.kept.org.includes("研发部"),
      "refresh should keep users whose 工号 still hits, got " + JSON.stringify(refreshMiss.kept)
    );
    check(
      !!refreshMiss.zhou && refreshMiss.zhou.employeeNo === "" && refreshMiss.zhou.org === "--",
      "refresh should not invent org info for a user with no 工号, got " + JSON.stringify(refreshMiss.zhou)
    );

    const noEmployeeRefresh = await evaluate(`(() => {
      document.querySelector('[data-page="org-users"]').click();
      const input = document.getElementById("user-search");
      input.value = "zhoufang";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      const sso = document.getElementById("btn-sso-login");
      if (!sso || sso.hidden) return { error: "missing-sso" };
      document.getElementById("toast-wrap").replaceChildren();
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "XH10032";
      field.dispatchEvent(new FocusEvent("blur"));
      if (document.getElementById("modal-confirm").classList.contains("show")) {
        document.getElementById("btn-confirm-ok").click();
      }
      const linked = {
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
        org: document.querySelector("#user-tbody tr").children[4].textContent.trim(),
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
      };
      document.getElementById("toast-wrap").replaceChildren();
      sso.click();
      const afterLogin = {
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        org: document.querySelector("#user-tbody tr").children[4].textContent.trim(),
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
      };
      return { linked, afterLogin };
    })()`);
    check(!noEmployeeRefresh.error, "SSO login should be available for a bound user, got " + JSON.stringify(noEmployeeRefresh));
    check(
      noEmployeeRefresh.linked && noEmployeeRefresh.linked.employeeNo === "XH10032" && noEmployeeRefresh.linked.org.includes("研发部") && noEmployeeRefresh.linked.toast !== "工号错误",
      "admin entry of a real 工号 should write membership before SSO, got " + JSON.stringify(noEmployeeRefresh.linked)
    );
    check(
      noEmployeeRefresh.afterLogin && noEmployeeRefresh.afterLogin.drawerOpen && noEmployeeRefresh.afterLogin.employeeNo === "" && noEmployeeRefresh.afterLogin.customerInfo === "" && noEmployeeRefresh.afterLogin.org === "--",
      "SSO 无工号 should clear org and customer JSON without blocking login, got " + JSON.stringify(noEmployeeRefresh.afterLogin)
    );
    check(
      noEmployeeRefresh.afterLogin && noEmployeeRefresh.afterLogin.accountType === "普通用户" && noEmployeeRefresh.afterLogin.toast !== "工号错误",
      "SSO 无工号 should keep the function role and not toast 工号错误, got " + JSON.stringify(noEmployeeRefresh.afterLogin)
    );
    let refreshClearsManual = { error: "skipped" };
    if (!noEmployeeRefresh.error) {
      refreshClearsManual = await evaluate(`(() => {
        const field = document.getElementById("uf-employee-no");
        field.focus();
        field.value = "XH10032";
        field.dispatchEvent(new FocusEvent("blur"));
        if (document.getElementById("modal-confirm").classList.contains("show")) {
          document.getElementById("btn-confirm-ok").click();
        }
        const linkedOrg = document.querySelector("#user-tbody tr").children[4].textContent.trim();
        document.getElementById("toast-wrap").replaceChildren();
        document.getElementById("btn-refresh-org").click();
        const row = document.querySelector("#user-tbody tr");
        return {
          linkedOrg,
          employeeNo: document.getElementById("uf-employee-no").value,
          customerInfo: document.getElementById("uf-customer-info").value,
          org: row.children[4].textContent.trim(),
          accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
          toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
        };
      })()`);
    }
    check(
      refreshClearsManual.linkedOrg && refreshClearsManual.linkedOrg.includes("研发部"),
      "a manual 工号 with a department should update membership, got " + JSON.stringify(refreshClearsManual)
    );
    check(
      refreshClearsManual.org === "--" && refreshClearsManual.employeeNo === "" && refreshClearsManual.customerInfo === "" && refreshClearsManual.accountType === "普通用户" && refreshClearsManual.toast === "已从客户系统刷新组织",
      "refresh should apply 无工号 from the latest identity and clear the manual org, got " + JSON.stringify(refreshClearsManual)
    );
    const zhouGrant = await evaluate(`(() => {
      document.querySelector('[data-page="kb-perm"]').click();
      const direct = document.querySelector('#kb-member-tbody select[data-kind="user"][data-id="zhoufang"]');
      return { direct: direct ? direct.value : "" };
    })()`);
    check(zhouGrant.direct === "viewer", "SSO sync should keep 周芳's direct resource grant, got " + zhouGrant.direct);

    const pendingOrg = await evaluate(`(() => {
      document.querySelector('[data-page="org-users"]').click();
      const input = document.getElementById("user-search");
      input.value = "sunhao";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      document.getElementById("toast-wrap").replaceChildren();
      const before = (window.__orgAnomalies || []).length;
      const field = document.getElementById("uf-employee-no");
      field.focus();
      field.value = "XH10031";
      field.dispatchEvent(new FocusEvent("blur"));
      if (document.getElementById("modal-confirm").classList.contains("show")) {
        document.getElementById("btn-confirm-ok").click();
      }
      const row = document.querySelector("#user-tbody tr");
      const missing = {
        employeeNo: field.value,
        customerInfo: document.getElementById("uf-customer-info").value,
        org: row.children[4].textContent.trim(),
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
        anomaly: (window.__orgAnomalies || []).slice(before),
      };
      document.getElementById("toast-wrap").replaceChildren();
      document.getElementById("btn-refresh-org").click();
      const stillMissing = {
        org: document.querySelector("#user-tbody tr").children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
      };
      window.__includePendingOrg = true;
      document.getElementById("toast-wrap").replaceChildren();
      document.getElementById("btn-refresh-org").click();
      const rebuilt = {
        org: document.querySelector("#user-tbody tr").children[4].textContent.trim(),
        employeeNo: document.getElementById("uf-employee-no").value,
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
      };
      window.__includePendingOrg = false;
      return { missing, stillMissing, rebuilt };
    })()`);
    check(
      pendingOrg.missing && pendingOrg.missing.employeeNo === "XH10031" && pendingOrg.missing.customerInfo.includes("新业务") && pendingOrg.missing.org === "--",
      "an org missing from the snapshot should keep JSON and clear current membership, got " + JSON.stringify(pendingOrg.missing)
    );
    check(
      pendingOrg.missing && pendingOrg.missing.accountType === "普通用户" && pendingOrg.missing.toast !== "工号错误" && pendingOrg.missing.anomaly.some((item) => item.orgId === "d-new"),
      "a missing org should log an anomaly and keep the function role, got " + JSON.stringify(pendingOrg.missing)
    );
    check(
      pendingOrg.stillMissing && pendingOrg.stillMissing.org === "--" && pendingOrg.stillMissing.employeeNo === "XH10031" && pendingOrg.stillMissing.toast !== "工号错误",
      "refresh should not invent membership before the org is published, got " + JSON.stringify(pendingOrg.stillMissing)
    );
    check(
      pendingOrg.rebuilt && pendingOrg.rebuilt.org.includes("新业务部") && pendingOrg.rebuilt.employeeNo === "XH10031" && pendingOrg.rebuilt.accountType === "普通用户" && pendingOrg.rebuilt.toast !== "工号错误",
      "the next org publish should rebuild membership, got " + JSON.stringify(pendingOrg.rebuilt)
    );

    const ssoFailure = await evaluate(`(() => {
      if (!("__customerLookupDown" in window)) return { error: "missing-directory-controls" };
      const input = document.getElementById("user-search");
      input.value = "zhangwei";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#user-tbody [data-view]").click();
      const sso = document.getElementById("btn-sso-login");
      if (!sso || sso.hidden) return { error: "missing-sso" };
      window.__customerLookupDown = true;
      document.getElementById("toast-wrap").replaceChildren();
      sso.click();
      const row = document.querySelector("#user-tbody tr");
      const result = {
        employeeNo: document.getElementById("uf-employee-no").value,
        customerInfo: document.getElementById("uf-customer-info").value,
        org: row.children[4].textContent.trim(),
        accountType: document.getElementById("uf-account-type").selectedOptions[0].textContent.trim(),
        toast: (document.querySelector("#toast-wrap .toast") || {}).textContent || "",
        drawerOpen: document.getElementById("modal-user").classList.contains("show"),
      };
      window.__customerLookupDown = false;
      return result;
    })()`);
    check(!ssoFailure.error, "SSO login should call the shared lookup, got " + JSON.stringify(ssoFailure));
    check(ssoFailure.toast !== "工号错误", "SSO lookup failure should not toast 工号错误, got " + ssoFailure.toast);
    check(
      ssoFailure.drawerOpen && ssoFailure.employeeNo === "XH10021" && (ssoFailure.org || "").includes("研发部") && (ssoFailure.customerInfo || "").includes("XH10021") && ssoFailure.accountType === "管理员",
      "SSO lookup failure should keep the last projection and function role, got " + JSON.stringify(ssoFailure)
    );
  });

  if (failures.length) {
    console.error(failures.map((message) => "- " + message).join("\n"));
    process.exit(1);
  }
  console.log("user list org column and customer-info search tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
