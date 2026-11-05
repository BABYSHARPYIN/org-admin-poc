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
    /<th>姓名<\/th>[\s\S]*<th>账号<\/th>[\s\S]*<th>邮箱<\/th>[\s\S]*<th>手机号<\/th>[\s\S]*<th>组织信息<\/th>[\s\S]*<th>角色<\/th>[\s\S]*<th class="action-col">操作<\/th>/.test(userTable[0]),
    "组织信息 should sit with the existing user columns: 姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 角色 / 操作"
  );
}

check(!html.includes("当前组织"), "user list should not show the 当前组织 breadcrumb");
check(!html.includes("清除选择"), "user list should not show 清除选择");
check(!html.includes("全部用户"), "org tree should not include a synthetic 全部用户 node");
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
      snapshot.headers.join(" / ") === "姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 角色 / 操作",
      "rendered headers should be 姓名 / 账号 / 邮箱 / 手机号 / 组织信息 / 角色 / 操作, got " + snapshot.headers.join(" / ")
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
