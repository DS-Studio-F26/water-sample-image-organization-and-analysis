/**
 * Admin page. Everyone can open it; what it shows depends on who is signed in:
 *
 *   signed out     a Sign in button, to request a role
 *   viewer         buttons to request the labeler or admin role
 *   labeler        the labeled tile, labeling progress (names, no emails),
 *                  the labels export, and a button to request admin
 *   admin, owner   every account, role changes and requests, and progress
 *
 * Everything here is convenience only. The database checks every rule itself
 * (supabase/migrations/001_init.sql and 004_roles.sql): only admins list
 * accounts or change roles, only the Owner changes another admin's role,
 * nobody changes the Owner's role, and the last admin can't be removed.
 */

const ROLES = ['admin', 'labeler', 'viewer'];  // what an admin can give; nobody can be made Owner
const USERS_PAGE_SIZE = 1000;  // PostgREST returns at most 1,000 rows per request
const USER_COLUMNS = 6;

const LEDES = {
  'signed-out': 'Ask to become a labeler or an admin.',
  viewer: 'Ask to become a labeler or an admin.',
  labeler: 'See how the labeling is going, export the labels, or ask to become an admin.',
  admin: 'Decide who can label images, and keep an eye on how the labeling is going.',
};

const adminState = {
  users: [],
  requests: new Map(),  // user id -> their latest role request
  myRequest: null,      // a viewer's or labeler's own latest request
  search: '',
  roleFilter: '',       // '', a role, or 'requests' for open requests
  pending: null,  // { id, role } while a role change waits for confirmation
  saving: false,
};

const h = UI.h;
const roleName = role => role.charAt(0).toUpperCase() + role.slice(1);
const withArticle = role => `${role === 'admin' || role === 'owner' ? 'an' : 'a'} ${roleName(role)}`;
const isAdminRole = role => role === 'admin' || role === 'owner';
const myRole = () => {
  const { user, profile } = Auth.current();
  return user ? (profile && profile.role) || 'viewer' : null;
};

// The table or function isn't in the database yet (its migration isn't applied).
const isMissingSchema = err => /PGRST202|PGRST205|schema cache|does not exist|Could not find/i.test(`${err.code} ${err.message}`);

// 1. Which view to show

function showView(view) {
  const shown = {
    'admin-loading': view === 'loading',
    'admin-signed-out': view === 'signed-out',
    'admin-request': view === 'viewer' || view === 'labeler',
    'admin-panel': view === 'labeler' || view === 'admin',
  };
  Object.keys(shown).forEach(id => { document.getElementById(id).hidden = !shown[id]; });
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = view !== 'admin'; });
  if (LEDES[view]) document.getElementById('page-lede').textContent = LEDES[view];
}

// supabase-js can re-announce the same sign-in (e.g. when the tab regains
// focus); only rebuild the page when the user or their role actually changed.
let lastRenderKey = null;

async function renderForUser(auth) {
  const role = (auth.profile && auth.profile.role) || 'viewer';
  const key = auth.user ? `${auth.user.id}|${role}` : 'signed-out';
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  hideMessage();
  if (!window.sb) {
    showView('loading');
    document.getElementById('admin-loading').textContent =
      "Can't reach the sign-in service (the Supabase library didn't load). Please reload the page.";
    return;
  }
  if (!auth.user) {
    showView('signed-out');
    return;
  }
  if (isAdminRole(role)) {
    showView('admin');
    await Promise.all([loadUsers(), loadLabelingProgress(), loadLabelStats()]);
  } else if (role === 'labeler') {
    showView('labeler');
    await Promise.all([loadMyRequest(), loadLabelingProgress(), loadLabelStats()]);
  } else {
    showView('viewer');
    await loadMyRequest();
  }
}

// 2. Loading users and their role requests

async function loadUsers() {
  setTableMessage('users-body', USER_COLUMNS, 'Loading accounts…');
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
    adminState.requests = await fetchRequests();
    renderUsers();
  } catch (err) {
    setTableMessage('users-body', USER_COLUMNS, "Couldn't load the accounts.");
    showMessage(`Couldn't load the accounts: ${describeError(err)}`);
  }
}

// Every account's latest request (role_requests, 004_roles.sql). Until that
// migration is applied there's no table, and so no requests.
async function fetchRequests() {
  const { data, error } = await sb.from('role_requests')
    .select('user_id, requested_role, status, requested_at, decided_at');
  if (error) {
    if (isMissingSchema(error)) return new Map();
    throw error;
  }
  return new Map(data.map(r => [r.user_id, r]));
}

async function reloadRequests() {
  try {
    adminState.requests = await fetchRequests();
  } catch (err) {
    showMessage(`Couldn't load the role requests: ${describeError(err)}`);
  }
  renderUsers();
}

function openRequest(userId) {
  const req = adminState.requests.get(userId);
  return req && req.status === 'pending' ? req : null;
}

// 3. Summary tiles and the accounts table

function renderKpis() {
  const count = (...roles) => adminState.users.filter(u => roles.includes(u.role)).length;
  const set = (id, n) => UI.countUp(document.getElementById(id), n, { duration: 700 });
  set('kpi-accounts', adminState.users.length);
  set('kpi-admins', count('owner', 'admin'));
  set('kpi-labelers', count('labeler'));
  set('kpi-viewers', count('viewer'));
  const open = adminState.users.filter(u => openRequest(u.id)).length;
  document.getElementById('requests-filter').textContent = open ? `Requests (${open})` : 'Requests';
}

function matchesRoleFilter(user) {
  const filter = adminState.roleFilter;
  if (!filter) return true;
  if (filter === 'requests') return !!openRequest(user.id);
  return filter === 'admin' ? isAdminRole(user.role) : user.role === filter;
}

function renderUsers() {
  renderKpis();
  const tbody = document.getElementById('users-body');
  const q = adminState.search.trim().toLowerCase();
  const me = Auth.current().user;
  const visible = adminState.users.filter(u => matchesRoleFilter(u)
    && (!q || [u.email, u.full_name, u.provider, u.role].some(v => v && v.toLowerCase().includes(q))));

  const total = adminState.users.length;
  document.getElementById('user-count').textContent = visible.length === total
    ? `${total} ${total === 1 ? 'account' : 'accounts'}`
    : `Showing ${visible.length} of ${total} accounts`;

  tbody.innerHTML = '';
  if (visible.length === 0) {
    setTableMessage('users-body', USER_COLUMNS, total === 0 ? 'No accounts yet.'
      : adminState.roleFilter === 'requests' && !q ? 'No open role requests.'
      : 'No accounts match your search.');
    return;
  }

  visible.forEach(user => {
    const isMe = me && me.id === user.id;
    tbody.appendChild(h('tr', {},
      h('td', {}, userCell(user, isMe)),
      h('td', {}, providerChips(user.provider)),
      roleCell(user, isMe),
      statusCell(user),
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

// Why this account's role can't be changed from here, or null if it can.
// set_user_role() refuses the same changes.
function lockReason(user, isMe) {
  if (user.role === 'owner') return 'The Owner’s role can’t be changed.';
  if (user.role === 'admin' && !isMe && myRole() !== 'owner') return 'Only the Owner can change another admin’s role.';
  return null;
}

function roleCell(user, isMe) {
  const td = h('td', { class: 'role-cell' });
  const locked = lockReason(user, isMe);
  if (locked) {
    td.append(
      h('span', { class: `badge role-badge role-${user.role}`, title: locked }, UI.icon('lock'), roleName(user.role)),
      h('span', { class: 'visually-hidden', text: ` ${locked}` }));
    return td;
  }
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
      h('span', { text: `Change from ${roleName(user.role)} to ${roleName(pending.role)}?` + (isMe && !isAdminRole(pending.role) ? ' You will lose your admin access.' : '') }),
      yes, no));
  }
  return td;
}

// The account's latest role request: open ones get Approve and Decline.
function statusCell(user) {
  const req = adminState.requests.get(user.id);
  if (!req) return h('td', { class: 'dim', text: '-' });
  const td = h('td', { class: 'status-cell' });
  const at = req.status === 'pending' ? req.requested_at : req.decided_at;
  const when = h('span', { class: 'dim', title: at ? new Date(at).toLocaleString() : '', text: at ? UI.relativeTime(at) : '' });

  if (req.status !== 'pending') {
    td.appendChild(h('div', { class: 'dim' }, `${req.status === 'approved' ? 'Approved' : 'Declined'}: ${roleName(req.requested_role)} · `, when));
    return td;
  }
  const approve = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Approve', 'aria-label': `Approve ${user.email} as ${withArticle(req.requested_role)}`, onclick: () => reviewRequest(user, req, true) });
  const decline = h('button', { type: 'button', class: 'btn btn-sm', text: 'Decline', 'aria-label': `Decline ${user.email}’s request`, onclick: () => reviewRequest(user, req, false) });
  approve.disabled = decline.disabled = adminState.saving;
  td.append(
    h('div', {}, h('span', { class: `badge role-badge role-${req.requested_role}`, text: `Wants ${roleName(req.requested_role)}` }), ' ', when),
    h('div', { class: 'request-actions' }, approve, decline));
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
  UI.toast({ message: `${user.email} is now ${withArticle(newRole)}.`, kind: 'success' });
  await reloadRequests();  // the change may have answered their request
  loadLabelingProgress();
  if (isMe) await Auth.refresh();  // may switch this page to the labeler or viewer view
}

async function reviewRequest(user, req, approve) {
  adminState.saving = true;
  adminState.pending = null;
  renderUsers();
  const { error } = await sb.rpc('review_role_request', { target: user.id, approve });
  adminState.saving = false;

  if (error) {
    UI.toast({ message: `Couldn't ${approve ? 'approve' : 'decline'} the request from ${user.email}: ${describeError(error)}`, kind: 'error', duration: 8000 });
  } else if (approve) {
    user.role = req.requested_role;
    UI.toast({ message: `${user.email} is now ${withArticle(user.role)}.`, kind: 'success' });
    loadLabelingProgress();
  } else {
    UI.toast({ message: `Declined ${user.email}’s request to become ${withArticle(req.requested_role)}.`, kind: 'success' });
  }
  await reloadRequests();
}

function setTableMessage(bodyId, span, text) {
  const tbody = document.getElementById(bodyId);
  tbody.innerHTML = '';
  tbody.appendChild(h('tr', {}, h('td', { colspan: String(span), class: 'no-results', text })));
}

// 4. Labeling progress: admin_labeling_by_user() (002_labeling.sql) for admins,
// team_labeling_progress() (004_roles.sql) for labelers, which has no emails.

async function loadLabelingProgress() {
  setTableMessage('labeling-users-body', 5, 'Loading…');
  const admin = isAdminRole(myRole());
  const me = Auth.current().user;
  try {
    const { data, error } = await sb.rpc(admin ? 'admin_labeling_by_user' : 'team_labeling_progress');
    if (error) throw error;
    renderLabelingProgress(admin
      ? data.map(row => Object.assign({}, row, { isMe: !!me && me.id === row.id }))
      : data.map(row => Object.assign({}, row, {
        isMe: row.is_me,
        email: row.is_me && me ? me.email : null,
        full_name: row.full_name || (row.is_me ? null : 'Unnamed account'),
      })));
  } catch (err) {
    const missing = isMissingSchema(err);
    setTableMessage('labeling-users-body', 5, !missing ? "Couldn't load labeling progress."
      : admin ? 'Labeling isn’t switched on yet: apply supabase/migrations/002_labeling.sql to start tracking progress.'
      : 'Labeling progress isn’t available yet.');
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
      h('td', {}, userCell(row, row.isMe)),
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

// 5. Requesting a role (viewers and labelers): request_role() and
// cancel_role_request(), 004_roles.sql

// quiet: keep showing the card while it reloads (after sending or cancelling).
async function loadMyRequest(quiet = false) {
  const body = document.getElementById('request-body');
  if (!quiet) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'detail-loading' }, h('div', { class: 'spinner' }), ' Loading…'));
  }
  try {
    const { data, error } = await sb.from('role_requests')
      .select('requested_role, status, requested_at, decided_at')
      .eq('user_id', Auth.current().user.id)
      .maybeSingle();
    if (error) throw error;
    adminState.myRequest = data;
    renderRequestCard();
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(h('p', { text: isMissingSchema(err)
      ? 'Role requests aren’t switched on yet. Please ask an admin for the role you need.'
      : `Couldn't load your role request: ${describeError(err)}` }));
  }
}

function renderRequestCard() {
  const role = myRole();
  const req = adminState.myRequest;
  const body = document.getElementById('request-body');
  body.innerHTML = '';
  body.appendChild(h('p', {}, 'Your account (', h('strong', { text: Auth.current().user.email }), ') has the ',
    h('strong', { text: roleName(role) }), ' role.'));

  if (req && req.status === 'pending') {
    body.appendChild(notice('info', 'clock',
      `You asked to become ${withArticle(req.requested_role)} ${UI.relativeTime(req.requested_at)}.`,
      'An admin will review your request.'));
    body.appendChild(h('div', { class: 'request-actions' },
      h('button', { type: 'button', class: 'btn', onclick: cancelRequest }, UI.icon('x'), 'Cancel request')));
    return;
  }
  if (req && req.status === 'declined') {
    body.appendChild(notice('warn', 'info',
      `Your request to become ${withArticle(req.requested_role)} was declined ${UI.relativeTime(req.decided_at)}.`,
      'You can ask again.'));
  }
  const choices = role === 'viewer' ? ['admin', 'labeler'] : ['admin'];
  body.appendChild(h('div', { class: 'request-actions' }, choices.map(r =>
    h('button', { type: 'button', class: 'btn', onclick: () => sendRequest(r) }, UI.icon(r === 'admin' ? 'shield' : 'tag'), `Request ${r}`))));
}

function notice(kind, iconName, title, text) {
  return h('div', { class: `alert alert-${kind}`, role: 'status' }, UI.icon(iconName),
    h('div', { class: 'alert-body' }, h('div', {}, h('strong', { text: title }), ` ${text}`)));
}

function setRequestBusy(busy) {
  document.querySelectorAll('#request-body button').forEach(b => { b.disabled = busy; });
}

async function sendRequest(role) {
  setRequestBusy(true);
  const { error } = await sb.rpc('request_role', { requested: role });
  if (error) {
    setRequestBusy(false);
    UI.toast({ message: `Couldn't send your request: ${describeError(error)}`, kind: 'error', duration: 8000 });
    return;
  }
  UI.toast({ message: `Request sent: an admin will review your request to become ${withArticle(role)}.`, kind: 'success' });
  await loadMyRequest(true);
}

async function cancelRequest() {
  setRequestBusy(true);
  const { error } = await sb.rpc('cancel_role_request');
  if (error) {
    setRequestBusy(false);
    UI.toast({ message: `Couldn't cancel your request: ${describeError(error)}`, kind: 'error', duration: 8000 });
    return;
  }
  UI.toast({ message: 'Your request was cancelled.', kind: 'success' });
  await loadMyRequest(true);
}

// 6. Messages

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

// 7. Initialization

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
