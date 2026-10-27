import { accountsRead, accountAction } from '../backend.js';
import { currentTarget, requestContext, isCurrent } from '../state.js';
import { esc, head, stat, toast } from '../ui/dom.js';
import { withSudo } from '../ui/sudo.js';

export const load = target => accountsRead(target);
let data, filter = '', showSystem = false, events, dialog;
const protectedUser = user => user.name === 'root' || user.name === data.currentUser || user.system || user.uid < 1000;
const tags = groups => groups.map(g => '<span class="tag" data-group-tag="' + esc(g) + '">' + esc(g) + '</span>').join('');

export function render(value) {
  data = value;
  const sudo = user => user.groups.some(g => data.sudoGroups.includes(g));
  const rows = data.users.map(user => {
    const protectedAccount = protectedUser(user);
    return '<tr data-name="' + esc(user.name) + '" data-system="' + user.system + '" data-q="' + esc([user.name, user.uid, ...user.groups].join(' ').toLowerCase()) + '">'
      + '<td><div class="who"><div><p>' + esc(user.name) + '</p><small>' + esc(user.home) + ' · ' + esc(user.shell) + '</small></div></div></td>'
      + '<td class="num">' + esc(user.uid) + '</td><td><div class="accounts-tags">' + tags(user.groups) + '</div></td>'
      + '<td><div class="accounts-tags">' + (sudo(user) ? '<span class="tag ok">sudo</span>' : '')
      + (user.system ? '<span class="tag">System</span>' : '') + '<span class="tag">' + (user.login ? 'Login' : 'No login') + '</span></div></td>'
      + '<td><div class="acts"><button data-account-action="add_to_group">Add group</button>'
      + '<button data-account-action="remove_from_group"' + (protectedAccount ? ' disabled' : '') + '>Remove group</button>'
      + '<button data-account-action="delete_user"' + (protectedAccount ? ' disabled' : '') + '>Delete</button></div>'
      + (protectedAccount ? '<small class="accounts-protected">Protected: ' + (user.name === data.currentUser ? 'current SSH user' : 'system account') + '</small>' : '') + '</td></tr>';
  }).join('');
  return '<div class="accounts-page">' + head('Users', esc(currentTarget().host), '<input class="field" id="accounts-filter" aria-label="Filter users" placeholder="Filter users or groups…" value="' + esc(filter) + '"><button class="pill primary" id="add-account">Add user</button>')
    + '<section class="grid"><article class="card full"><div class="stats">' + stat('Users', data.users.length, true) + stat('Login users', data.users.filter(u => u.login).length) + stat('Groups', data.groups.length) + stat('Sudo users', data.users.filter(sudo).length) + '</div>'
    + '<p class="accounts-note">Only group-based sudo is shown. Rules in sudoers are not read.</p><p id="accounts-current">SSH user: ' + esc(data.currentUser) + '</p></article>'
    + '<article class="card full"><div class="card-top"><h2>Users</h2><label class="accounts-check"><input id="accounts-system" type="checkbox"' + (showSystem ? ' checked' : '') + '> Show system accounts</label></div>'
    + '<table id="accounts-users" aria-label="Users"><thead><tr><th scope="col">Name / home / shell</th><th scope="col">UID</th><th scope="col">Groups</th><th scope="col">Access</th><th scope="col">Actions</th></tr></thead><tbody>' + rows + '</tbody></table><p id="accounts-empty" hidden>No users match this filter.</p></article>'
    + '<article class="card full"><div class="card-top"><h2>Groups</h2></div><table id="accounts-groups" aria-label="Groups"><thead><tr><th scope="col">Name</th><th scope="col">GID</th><th scope="col">Members (primary and supplementary)</th></tr></thead><tbody>'
    + data.groups.map(g => '<tr><td>' + esc(g.name) + '</td><td class="num">' + esc(g.gid) + '</td><td><div class="accounts-tags">' + tags([...new Set([...g.members, ...data.users.filter(u => u.gid === g.gid).map(u => u.name)])]) + '</div></td></tr>').join('')
    + '</tbody></table></article></section></div>';
}

function applyFilter(el) {
  let visible = 0;
  el.querySelectorAll('#accounts-users tbody tr').forEach(row => {
    row.hidden = (!showSystem && row.dataset.system === 'true') || !row.dataset.q.includes(filter.toLowerCase());
    if (!row.hidden) visible++;
  });
  el.querySelector('#accounts-empty').hidden = visible > 0;
}

function closeDialog() { dialog?.close(); dialog?.remove(); dialog = null; }
function showDialog(title, fields, submit, onSubmit) {
  closeDialog();
  dialog = document.createElement('dialog');
  dialog.className = 'accounts-dialog';
  dialog.setAttribute('aria-labelledby', 'accounts-dialog-title');
  dialog.innerHTML = '<form><h2 id="accounts-dialog-title">' + esc(title) + '</h2>' + fields + '<p class="error" role="alert"></p><div class="dlg-actions"><button type="button" class="pill" data-cancel>Cancel</button><button type="submit" class="pill primary">' + esc(submit) + '</button></div></form>';
  dialog.querySelector('[data-cancel]').onclick = closeDialog;
  dialog.oncancel = event => { event.preventDefault(); closeDialog(); };
  dialog.querySelector('form').onsubmit = event => { event.preventDefault(); onSubmit(dialog); };
  document.body.append(dialog);
  dialog.showModal();
}
const validName = name => /^[a-z_][a-z0-9_-]{0,31}$/.test(name);

export function mount(el, { refresh }) {
  events = new AbortController();
  let busy = false;
  const pageRequest = requestContext();
  applyFilter(el);
  el.addEventListener('input', event => {
    if (event.target.id === 'accounts-filter') { filter = event.target.value; applyFilter(el); }
  }, { signal: events.signal });
  el.addEventListener('change', event => {
    if (event.target.id === 'accounts-system') { showSystem = event.target.checked; applyFilter(el); }
  }, { signal: events.signal });
  async function perform(action, args) {
    if (busy || !isCurrent(pageRequest)) return;
    busy = true;
    const target = currentTarget(), request = requestContext();
    closeDialog();
    const buttons = [...el.querySelectorAll('#add-account, [data-account-action]')].filter(b => !b.disabled);
    buttons.forEach(b => { b.disabled = true; });
    try {
      await withSudo(password => {
        if (!isCurrent(request)) throw { kind: 'cancelled', message: 'Action cancelled' };
        return accountAction(target, action, args, password);
      });
      if (isCurrent(request)) { toast('Account action completed'); await refresh(); }
    } catch (error) {
      if (!isCurrent(request) || error.kind === 'cancelled') return;
      if (error.kind === 'outcome_unknown') {
        toast('Outcome unknown. Refreshing accounts. ' + error.message);
        await refresh();
      } else toast(error.message);
    } finally {
      busy = false;
      if (isCurrent(request)) buttons.forEach(b => { b.disabled = false; });
    }
  }
  el.addEventListener('click', event => {
    if (busy) return;
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'add-account') {
      showDialog('Add user', '<label for="account-name">User name</label><input id="account-name" class="field" required autocomplete="off" autofocus><label for="account-groups">Groups (optional)</label><input id="account-groups" class="field" placeholder="team, sudo" autocomplete="off"><p>Creates a home directory and uses /bin/bash.</p>', 'Create user', dlg => {
        const name = dlg.querySelector('#account-name').value.trim();
        const text = dlg.querySelector('#account-groups').value.trim();
        const groups = text ? text.split(',').map(g => g.trim()) : [];
        if (!validName(name) || groups.some(g => !validName(g))) {
          dlg.querySelector('[role="alert"]').textContent = 'Invalid account name or group name. Use up to 32 lowercase letters, digits, underscores or hyphens; start with a letter or underscore.';
          return;
        }
        perform('create_user', { name, groups });
      });
      return;
    }
    const action = button.dataset.accountAction;
    if (!action) return;
    const name = button.closest('tr').dataset.name;
    const user = data.users.find(u => u.name === name);
    if (action === 'delete_user') {
      showDialog('Delete ' + name + '?', '<p>Keep the home directory unless you explicitly choose to delete it too.</p><label class="accounts-check"><input id="account-confirm" type="checkbox"> I confirm deleting this user</label><label class="accounts-check"><input id="account-remove-home" type="checkbox"> Also delete the home directory</label>', 'Delete user', dlg => {
        if (dlg.querySelector('#account-confirm').checked) perform(action, { name, removeHome: dlg.querySelector('#account-remove-home').checked });
      });
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      dialog.querySelector('#account-confirm').onchange = event => { submit.disabled = !event.target.checked; };
      return;
    }
    const adding = action === 'add_to_group';
    const choices = data.groups.filter(g => adding ? !user.groups.includes(g.name) : user.groups.includes(g.name) && g.gid !== user.gid);
    if (!choices.length) { toast(adding ? 'No additional groups available' : 'No supplementary groups to remove'); return; }
    showDialog((adding ? 'Add group for ' : 'Remove group from ') + name, '<label for="account-group">Group</label><select id="account-group" class="field">' + choices.map(g => '<option value="' + esc(g.name) + '">' + esc(g.name) + '</option>').join('') + '</select>', adding ? 'Add group' : 'Remove group', dlg => perform(action, { name, group: dlg.querySelector('select').value }));
  }, { signal: events.signal });
}
export function dispose() { events?.abort(); closeDialog(); }
