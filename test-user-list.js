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
      };
    })()`);

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
      drawer.labels.join(" / ") === "姓名 / 账号 / 邮箱 / 手机号 / 账号类型 / 员工工号 / 用户信息",
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
    check(drawer.customerLabel === "用户信息", "readonly customer JSON label should stay 用户信息, got " + drawer.customerLabel);

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
