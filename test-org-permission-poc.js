const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  html.includes('const KB_ROLE_LABEL = { owner: "所有者", editor: "编辑者", viewer: "使用者" }'),
  "KB role labels should be 所有者 / 编辑者 / 使用者"
);
assert(
  html.includes('const KB_ASSIGNABLE_ROLES = { editor: "编辑者", viewer: "使用者" }'),
  "only 编辑者 and 使用者 should be assignable knowledge-base roles"
);
assert(!html.includes("查看者"), "知识库角色「查看者」应改为「使用者」");
assert(!html.includes('<option value="admin">'), "knowledge-base auth select should not offer 管理员");
assert(!html.includes('<option value="owner">'), "所有者 should not be a freely assignable option");
assert(!html.includes('role: "admin"'), "demo knowledge-base bindings should not use the admin resource role");
assert(!html.includes('organizationRoleId: "kb-001-admin"'), "demo bindings should not keep the admin resource role id");
assert(html.includes('role: "owner"'), "demo data should include a default owner member");
assert(html.includes("张三"), "default owner demo member should remain 张三");
assert(html.includes('class="owner-badge">所有者</span>'), "owner role should render as a fixed badge");
assert(html.includes("所有者由创建者固定担任，不能移除"), "removing the owner should be blocked");
assert(html.includes('name: "管理员"'), "feature role 管理员 should stay");
assert(html.includes('role: "editor"'), "editor demo binding should remain");
assert(html.includes('role: "viewer"'), "viewer value should remain the lowest-privilege read role");
assert(html.includes('return ["kb:read"]'), "使用者 should keep the viewer read scope");
assert(!/role === "admin" \? \["kb:read"/.test(html), "admin resource role should not have a scope mapping");

const script = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
assert(script, "page script should be extractable");
new vm.Script(script[1], { filename: "index.html" });

console.log("knowledge-base resource role smoke test passed");
