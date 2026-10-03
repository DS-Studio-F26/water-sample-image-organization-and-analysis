/**
 * Admin page: list every account, change roles, and see who has labeled what.
 *
 * Everything here is convenience only. admin_list_users() and set_user_role()
 * check for the admin role inside the database, and the database refuses to
 * remove the last admin however it's asked (see supabase/migrations/).
 */

const ROLES = ['admin', 'labeler', 'viewer'];
const USERS_PAGE_SIZE = 1000;  // PostgREST returns at most 1,000 rows per request

const adminState = {
  users: [],
  search: '',
  roleFilter: '',
  pending: null,  // { id, role } while a role change waits for confirmation
  saving: false,
};

const h = UI.h;
const roleName = role => role.charAt(0).toUpperCase() + role.slice(1);

// 1. Which view to show

function showSection(id) {
  ['admin-loading', 'admin-signed-out', 'admin-forbidden', 'admin-panel'].forEach(sectionId => {
    document.getElementById(sectionId).hidden = sectionId !== id;
  });
}

// supabase-js can re-announce the same sign-in (e.g. when the tab regains
// focus); only rebuild the page when the user or their role actually changed.
let lastRenderKey = null;

async function renderForUser(auth) {
  const key = auth.user ? `${auth.user.id}|${(auth.profile && auth.profile.role) || 'viewer'}` : 'signed-out';
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  hideMessage();
  if (!window.sb) {
    showSection('admin-loading');
    document.getElementById('admin-loading').textContent =
      "Can't reach the sign-in service (the Supabase library didn't load). Please reload the page.";
    return;
  }
  if (!auth.user) {
    showSection('admin-signed-out');
    return;
  }
  const role = (auth.profile && auth.profile.role) || 'viewer';
  if (role !== 'admin') {
    document.getElementById('admin-forbidden-email').textContent = auth.user.email;
    document.getElementById('admin-forbidden-role').textContent = roleName(role);
    showSection('admin-forbidden');
    return;
  }
  showSection('admin-panel');
  await Promise.all([loadUsers(), loadLabelingProgress(), loadLabelStats()]);
}

// 2. Loading users

async function loadUsers() {
  setTableMessage('users-body', 5, 'Loading accounts…');
  try {
    const users = [];
    for (let from = 0; ; from += USERS_PAGE_SIZE) {
      const { data, error } = await sb.rpc('admin_list_users')
        .order('created_at')
        .range(from, from + USERS_PAGE_SIZE - 1);
      if (error) throw error;
      users.push(...data);
      if (data.length < USERS_PAGE_SIZE) break;
    }
    adminState.users = users;
    adminState.pending = null;
    renderUsers();
  } catch (err) {
    setTableMessage('users-body', 5, "Couldn't load the accounts.");
    showMessage(`Couldn't load the accounts: ${describeError(err)}`);
  }
}

// 3. Summary tiles and the accounts table

function renderKpis() {
  const count = (role) => adminState.users.filter(u => u.role === role).length;
  const set = (id, n) => UI.countUp(document.getElementById(id), n, { duration: 700 });
  set('kpi-accounts', adminState.users.length);
  set('kpi-admins', count('admin'));
  set('kpi-labelers', count('labeler'));
  set('kpi-viewers', count('viewer'));
}

function renderUsers() {
  renderKpis();
  const tbody = document.getElementById('users-body');
  const q = adminState.search.trim().toLowerCase();
  const me = Auth.current().user;
  const visible = adminState.users.filter(u =>
    (!adminState.roleFilter || u.role === adminState.roleFilter)
    && (!q || [u.email, u.full_name, u.provider, u.role].some(v => v && v.toLowerCase().includes(q))));

  const total = adminState.users.length;
  document.getElementById('user-count').textContent = visible.length === total
    ? `${total} ${total === 1 ? 'account' : 'accounts'}`
    : `Showing ${visible.length} of ${total} accounts`;

  tbody.innerHTML = '';
  if (visible.length === 0) {
    setTableMessage('users-body', 5, total === 0 ? 'No accounts yet.' : 'No accounts match your search.');
    return;
  }

  visible.forEach(user => {
    const isMe = me && me.id === user.id;
    tbody.appendChild(h('tr', {},
      h('td', {}, userCell(user, isMe)),
      h('td', {}, providerChips(user.provider)),
      roleCell(user, isMe),
      h('td', { class: 'dim', text: user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '-' }),
      h('td', { class: 'dim', title: user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : '', text: user.last_sign_in_at ? UI.relativeTime(user.last_sign_in_at) : 'Never' })));
  });
}

function userCell(user, isMe) {
  const label = user.full_name || user.email || '?';
  return h('div', { class: 'user-cell' },
    h('span', { class: 'avatar', 'aria-hidden': 'true', text: label.trim().charAt(0) }),
    h('div', {},
      h('div', { class: 'name' }, user.full_name || user.email || '-', isMe ? h('span', { class: 'badge badge-primary', style: { marginLeft: '0.5rem' }, text: 'You' }) : null),
      h('div', { class: 'sub', text: user.full_name ? (user.email || '') : '' })));
}

function providerChips(provider) {
  const wrap = h('div', { style: { display: 'flex', gap: '0.35rem', flexWrap: 'wrap' } });
  const parts = (provider || '').split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return document.createTextNode('-');
  parts.forEach(p => wrap.appendChild(h('span', { class: `badge ${p === 'google' ? 'badge-sky' : 'badge-violet'}` }, UI.icon(p === 'google' ? 'user' : 'mail'), roleName(p))));
  return wrap;
}

function roleCell(user, isMe) {
  const td = h('td', { class: 'role-cell' });
  const pending = adminState.pending && adminState.pending.id === user.id ? adminState.pending : null;

  const select = h('select', { class: 'role-select', 'aria-label': `Role for ${user.email}` });
  select.disabled = adminState.saving;
  ROLES.forEach(role => select.appendChild(h('option', { value: role, text: roleName(role) })));
  select.value = pending ? pending.role : user.role;
  select.addEventListener('change', () => {
    adminState.pending = select.value === user.role ? null : { id: user.id, role: select.value };
    renderUsers();
  });
  td.appendChild(select);

  if (pending) {
    const yes = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: adminState.saving ? 'Saving…' : 'Confirm', onclick: () => saveRole(user, pending.role, isMe) });
    yes.disabled = adminState.saving;
    const no = h('button', { type: 'button', class: 'btn btn-sm', text: 'Cancel', onclick: () => { adminState.pending = null; renderUsers(); } });
    no.disabled = adminState.saving;
    td.appendChild(h('div', { class: 'role-confirm' },
      h('span', { text: `Change from ${roleName(user.role)} to ${roleName(pending.role)}?` + (isMe && pending.role !== 'admin' ? ' You will lose access to this page.' : '') }),
      yes, no));
  }
  return td;
}

async function saveRole(user, newRole, isMe) {
  adminState.saving = true;
  renderUsers();
  const { error } = await sb.rpc('set_user_role', { target: user.id, new_role: newRole });
  adminState.saving = false;
  adminState.pending = null;

  if (error) {
    UI.toast({ message: `Couldn't change the role of ${user.email}: ${describeError(error)}`, kind: 'error', duration: 8000 });
    renderUsers();
    return;
  }
  user.role = newRole;
  UI.toast({ message: `${user.email} is now ${newRole === 'admin' ? 'an' : 'a'} ${roleName(newRole)}.`, kind: 'success' });
  renderUsers();
  loadLabelingProgress();
  if (isMe) await Auth.refresh();  // may switch this page to "Not authorized"
}

function setTableMessage(bodyId, span, text) {
  const tbody = document.getElementById(bodyId);
  tbody.innerHTML = '';
  tbody.appendChild(h('tr', {}, h('td', { colspan: String(span), class: 'no-results', text })));
}

// 4. Labeling progress (admin_labeling_by_user(), supabase/migrations/002_labeling.sql)

async function loadLabelingProgress() {
  setTableMessage('labeling-users-body', 5, 'Loading…');
  try {
    const { data, error } = await sb.rpc('admin_labeling_by_user');
    if (error) throw error;
    renderLabelingProgress(data);
  } catch (err) {
    const missing = /PGRST202|schema cache|does not exist|Could not find/i.test(`${err.code} ${err.message}`);
    setTableMessage('labeling-users-body', 5, missing
      ? 'Labeling isn’t switched on yet: apply supabase/migrations/002_labeling.sql to start tracking progress.'
      : "Couldn't load labeling progress.");
    if (!missing) showMessage(`Couldn't load labeling progress: ${describeError(err)}`);
  }
}

function renderLabelingProgress(rows) {
  const tbody = document.getElementById('labeling-users-body');
  tbody.innerHTML = '';
  const labeled = rows.filter(r => Number(r.labeled_count) > 0);
  if (labeled.length === 0) {
    setTableMessage('labeling-users-body', 5, 'No one has labeled any images yet.');
    return;
  }
  const total = labeled.reduce((s, r) => s + Number(r.labeled_count), 0) || 1;
  labeled.forEach(row => {
    const share = (Number(row.labeled_count) / total) * 100;
    tbody.appendChild(h('tr', {},
      h('td', {}, userCell(row, Auth.current().user && Auth.current().user.id === row.id)),
      h('td', {}, h('span', { class: `badge role-badge role-${row.role}`, text: roleName(row.role) })),
      h('td', { class: 'bar-cell' }, h('div', { class: 'progress', title: `${share.toFixed(1)}%` }, h('span', { style: { '--value': `${share}%` } }))),
      h('td', { class: 'num', text: Number(row.labeled_count).toLocaleString() }),
      h('td', { class: 'dim', title: row.last_labeled_at ? new Date(row.last_labeled_at).toLocaleString() : '', text: row.last_labeled_at ? UI.relativeTime(row.last_labeled_at) : '-' })));
  });
}

async function loadLabelStats() {
  const card = document.getElementById('kpi-labeled-card');
  try {
    const { data, error } = await sb.from('labeling_stats').select('*').single();
    if (error) throw error;
    card.hidden = false;
    const pct = Number(data.pct_labeled);
    UI.countUp(document.getElementById('kpi-labeled'), Number(data.labeled_images), { duration: 800 });
    document.getElementById('kpi-labeled-bar').style.setProperty('--value', `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`);
    card.querySelector('.kpi-label').textContent = `Images labeled · ${pct}%`;
  } catch (err) {
    card.hidden = true;
  }
}

async function exportLabels() {
  const btn = document.getElementById('export-btn');
  btn.disabled = true;
  try {
    const rows = [];
    for (let from = 0; ; from += USERS_PAGE_SIZE) {
      const { data, error } = await sb.from('images').select('image_id, folder_name, filename, label, labeled_date')
        .not('label', 'is', null).order('folder_name').order('filename').range(from, from + USERS_PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < USERS_PAGE_SIZE) break;
    }
    if (!rows.length) { UI.toast({ message: 'Nothing has been labeled yet, so there’s nothing to export.', kind: 'info' }); return; }
    UI.download(`water-sample-labels-${new Date().toISOString().slice(0, 10)}.csv`,
      UI.csv(rows, ['image_id', 'folder_name', 'filename', 'label', 'labeled_date']));
    UI.toast({ message: `Exported ${rows.length.toLocaleString()} labels.`, kind: 'success' });
  } catch (err) {
    UI.toast({ message: `Export failed: ${describeError(err)}`, kind: 'error' });
  } finally {
    btn.disabled = false;
  }
}

// 5. Messages

// Database errors carry a message and sometimes a hint, e.g.
// "Cannot remove the last admin" + "Make another user an admin first."
function describeError(err) {
  const message = (err && err.message) || String(err);
  const hint = err && err.hint ? ` ${err.hint}` : '';
  return Auth.friendlyError(message.replace(/\.?$/, '.')) + hint;
}

function showMessage(text) {
  const box = document.getElementById('admin-message');
  box.innerHTML = '';
  box.append(UI.icon('alert'), h('div', { class: 'alert-body', text }));
  box.hidden = false;
}

function hideMessage() {
  document.getElementById('admin-message').hidden = true;
}

// 6. Initialization

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('admin-signin-btn').addEventListener('click', () => Auth.openSignIn('signin'));
  document.getElementById('refresh-users-btn').addEventListener('click', () => {
    hideMessage();
    Promise.all([loadUsers(), loadLabelingProgress(), loadLabelStats()]);
  });
  document.getElementById('export-btn').addEventListener('click', exportLabels);

  document.getElementById('user-search').addEventListener('input', UI.debounce((e) => {
    adminState.search = e.target.value;
    renderUsers();
  }, 150));

  document.getElementById('role-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role]');
    if (!b) return;
    adminState.roleFilter = b.dataset.role;
    document.querySelectorAll('#role-filter button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderUsers();
  });

  // First render once the session is known, then again on every sign-in/out.
  Auth.ready.then(auth => {
    renderForUser(auth);
    Auth.onChange(renderForUser);
  });
});
