const fs = require("fs");
const path = require("path");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

function must(cond, message) {
  if (!cond) throw new Error(message);
}

must(!html.includes('data-page="roles"'), "role management navigation should be removed");
must(!html.includes('id="page-roles"'), "role management page should be removed");
must(!html.includes("id=\"btn-create-org\""), "organization create control should be removed");
must(!html.includes("id=\"modal-org\""), "organization edit modal should be removed");
must(!html.includes("id=\"ctx-menu\""), "organization context menu should be removed");
must(!html.includes("id=\"modal-position-migration\""), "batch transfer modal should be removed");
must(!html.includes("data-batch-action=\"transfer\""), "batch transfer action should be removed");
must(!html.includes("批量转岗"), "batch transfer copy should be removed");
must(!html.includes("待同步"), "pending-sync state should be removed");
must(!html.includes("待设置岗位"), "manual position state should be removed");
must(!html.includes("所属组织"), "organization column and hand-filled org field should be removed");
must(!html.includes("positionId"), "users should no longer store a hand-picked position");
must(html.includes("id=\"btn-refresh-org\""), "refresh organization action is missing");
must(html.includes("刷新组织"), "refresh organization copy is missing");
must(html.includes(">新增用户<"), "create user action is missing");
must(html.includes(">用户列表<"), "user list title is missing");
must(html.includes("组织与用户"), "organization and users navigation is missing");
must(html.includes("请输入搜索内容"), "production search placeholder is missing");
must(html.includes(">查看<"), "view action is missing");
must(html.includes(">姓名<") && html.includes(">账号<") && html.includes(">邮箱<") && html.includes(">手机号<") && html.includes(">角色<"), "production user columns are missing");
must(html.includes("员工工号"), "employee number field is missing");
must(html.includes(">用户信息<"), "read-only customer payload field is missing");
must(html.includes("id=\"uf-customer-info\""), "customer payload control is missing");
must(html.includes("readonly"), "customer payload should be read-only");
must(html.includes("确认变更员工工号"), "employee number change confirmation is missing");
must(html.includes("function syncCustomerUserInfo"), "customer sync function is missing");
must(!html.slice(html.indexOf("function syncCustomerUserInfo"), html.indexOf("function typeIcon")).includes("roleIds"), "sync must not rewrite feature roles");
must(!html.slice(html.indexOf("function syncCustomerUserInfo"), html.indexOf("function typeIcon")).includes("kbMembers"), "sync must not rewrite direct grants");
must(!html.includes("登录匹配"), "SSO match copy should be removed");
must(!html.includes("模拟登录"), "SSO simulation control should be removed");
must(!html.includes("providerUserId") && !html.includes("provider_user_id"), "SSO match fields should be removed");
must(!html.includes("本 POC"), "demo-only copy should be removed");
must(!html.includes("请输入搜索关键词"), "search empty state should not instruct the user");
must(!html.includes("id=\"btn-batch-actions\""), "batch actions menu should be removed");
must(!html.includes("data-batch-action="), "batch action items should be removed");
must(!html.includes("id=\"user-select-all\""), "user table batch checkbox should be removed");
must(!html.includes("id=\"user-selection-bar\""), "user table batch bar should be removed");
must(!html.includes("批量操作") && !html.includes("批量赋予") && !html.includes("批量回收"), "batch operation copy should be removed");
must(html.includes(">授权列表<"), "authorization list title is missing");
must(html.includes(">成员<") && html.includes(">组织信息<"), "authorization list columns are missing");
must(html.includes("id=\"btn-add-kb-auth\""), "add authorization action is missing");
must(html.includes(">资源名称<") && html.includes(">资源标识<"), "resource identity fields are missing");
must(html.includes(">公开性设置<"), "visibility section is missing");
must(!html.includes("id=\"kb-effective-tbody\"") && !html.includes("id=\"kb-org-grant-tbody\""), "separate grant tables should be removed");
must(html.includes("const tr = document.createElement(\"tr\")"), "user table row must be created before rendering");
must((html.match(/<\/section>/g) || []).length === 2, "page sections should have balanced closing tags");
must(html.includes("id=\"modal-kb-auth\""), "authorization picker is missing");
must(html.includes("if (!query)"), "authorization picker should stay empty before search");
must(html.includes("kbOrgGrants") && html.includes("kbMembers"), "org grants and direct grants should both remain");
must(readme.includes("刷新组织"), "README should describe organization refresh");
must(readme.includes("gh-pages"), "README should explain GitHub Pages publishing");
must(!readme.includes("批量转岗"), "README should not describe batch position transfer");
must(!readme.includes("待同步"), "README should not describe a pending sync state");

console.log("organization authorization and resource entry smoke test passed");
