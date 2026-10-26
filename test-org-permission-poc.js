const fs = require('fs');
const html = fs.readFileSync('/Users/rio/Desktop/零散文件/org-admin-poc/index.html', 'utf8');

if (html.includes('data-page="roles"')) throw new Error('role management navigation should be removed');
if (html.includes('id="page-roles"')) throw new Error('role management page should be removed');
if (html.includes('已含下级筛选（选中即生效）')) throw new Error('descriptive filter menu should be removed');
if (!html.includes('data-action="batch-revoke"')) throw new Error('batch revoke action is missing');
if (!html.includes('id="batch-members"')) throw new Error('batch member selection is missing');
if (!html.includes('id="btn-do-batch-revoke"')) throw new Error('batch revoke confirmation is missing');
if (!html.includes('id="btn-add-kb-member-single"')) throw new Error('single resource member entry is missing');
if (!html.includes('id="btn-add-kb-member-org"')) throw new Error('organization resource member entry is missing');
if (!html.includes('id="modal-kb-members"')) throw new Error('organization resource member modal is missing');
if (html.includes('id="kb-member-query"')) throw new Error('organization resource entry should not have a user search box');
if (html.includes('state.kbMemberQuery')) throw new Error('organization resource entry should not keep user search state');
if (!html.includes('if (!state.kbOrgId) return [];')) throw new Error('organization members should stay hidden before an organization is selected');
if (!html.includes('if (!query) return [];')) throw new Error('single member details should stay hidden before search');
if (!html.includes('不能回收用户的全部角色，请先为')) throw new Error('revoke fallback validation is missing');
if (html.includes('user.roleIds = ["r-user"]')) throw new Error('revoke must not auto-assign a fallback role');

console.log('organization authorization and resource entry smoke test passed');
