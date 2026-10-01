/**
 * Admin page: list every account and change roles.
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
  pending: null,  // { id, role } while a role change waits for confirmation
  saving: false
};

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
  await loadUsers();
}

// 2. Loading users

async function loadUsers() {
  setTableMessage('Loading accounts…');
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
    setTableMessage("Couldn't load the accounts.");
    showMessage(`Couldn't load the accounts: ${describeError(err)}`, 'error');
  }
}

// 3. Users table

function renderUsers() {
  const tbody = document.getElementById('users-body');
  const q = adminState.search.trim().toLowerCase();
  const me = Auth.current().user;
  const visible = adminState.users.filter(u => !q || [u.email, u.full_name, u.provider, u.role]
    .some(v => v && v.toLowerCase().includes(q)));

  const total = adminState.users.length;
  document.getElementById('user-count').textContent = visible.length === total
    ? `${total} ${total === 1 ? 'account' : 'accounts'}`
    : `Showing ${visible.length} of ${total} accounts`;

  tbody.innerHTML = '';
  if (visible.length === 0) {
    setTableMessage(total === 0 ? 'No accounts yet.' : 'No accounts match your search.');
    return;
  }

  visible.forEach(user => {
    const tr = document.createElement('tr');
    const isMe = me && me.id === user.id;

    const tdEmail = cell(tr, user.email || '-');
    if (isMe) {
      const you = document.createElement('span');
      you.className = 'text-muted';
      you.textContent = ' (you)';
      tdEmail.appendChild(you);
    }
    cell(tr, user.full_name || '-');
    cell(tr, user.provider || '-');
    tr.appendChild(roleCell(user, isMe));
    cell(tr, user.created_at ? new Date(user.created_at).toLocaleDateString() : '-', 'col-dim');
    cell(tr, user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : 'Never', 'col-dim');
    tbody.appendChild(tr);
  });
}

function roleCell(user, isMe) {
  const td = document.createElement('td');
  td.className = 'role-cell';
  const pending = adminState.pending && adminState.pending.id === user.id ? adminState.pending : null;

  const select = document.createElement('select');
  select.className = 'role-select';
  select.setAttribute('aria-label', `Role for ${user.email}`);
  select.disabled = adminState.saving;
  ROLES.forEach(role => {
    const option = document.createElement('option');
    option.value = role;
    option.textContent = roleName(role);
    select.appendChild(option);
  });
  select.value = pending ? pending.role : user.role;
  select.addEventListener('change', () => {
    adminState.pending = select.value === user.role ? null : { id: user.id, role: select.value };
    renderUsers();
  });
  td.appendChild(select);

  if (pending) {
    const confirmBox = document.createElement('div');
    confirmBox.className = 'role-confirm';
    const question = document.createElement('span');
    question.textContent = `Change from ${roleName(user.role)} to ${roleName(pending.role)}?`
      + (isMe && pending.role !== 'admin' ? ' You will lose access to this page.' : '');
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-primary btn-sm';
    yes.textContent = adminState.saving ? 'Saving…' : 'Confirm';
    yes.disabled = adminState.saving;
    yes.addEventListener('click', () => saveRole(user, pending.role, isMe));
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-sm';
    no.textContent = 'Cancel';
    no.disabled = adminState.saving;
    no.addEventListener('click', () => {
      adminState.pending = null;
      renderUsers();
    });
    confirmBox.append(question, yes, no);
    td.appendChild(confirmBox);
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
    showMessage(`Couldn't change the role of ${user.email}: ${describeError(error)}`, 'error');
    renderUsers();
    return;
  }
  user.role = newRole;
  showMessage(`${user.email} is now ${roleName(newRole) === 'Admin' ? 'an' : 'a'} ${roleName(newRole)}.`, 'success');
  renderUsers();
  if (isMe) await Auth.refresh();  // may switch this page to "Not authorized"
}

function cell(tr, text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  tr.appendChild(td);
  return td;
}

function setTableMessage(text) {
  const tbody = document.getElementById('users-body');
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 6;
  td.className = 'no-results';
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// 4. Messages

// Database errors carry a message and sometimes a hint, e.g.
// "Cannot remove the last admin" + "Make another user an admin first."
function describeError(err) {
  const message = (err && err.message) || String(err);
  const hint = err && err.hint ? ` ${err.hint}` : '';
  return Auth.friendlyError(message.replace(/\.?$/, '.')) + hint;
}

function showMessage(text, kind) {
  const box = document.getElementById('admin-message');
  box.textContent = text;
  box.className = `alert alert-${kind}`;
  box.hidden = false;
}

function hideMessage() {
  document.getElementById('admin-message').hidden = true;
}

// 5. Initialization

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('admin-signin-btn').addEventListener('click', () => Auth.openSignIn('signin'));
  document.getElementById('refresh-users-btn').addEventListener('click', () => {
    hideMessage();
    loadUsers();
  });

  let searchTimeout;
  document.getElementById('user-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      adminState.search = e.target.value;
      renderUsers();
    }, 150);
  });

  // First render once the session is known, then again on every sign-in/out.
  Auth.ready.then(auth => {
    renderForUser(auth);
    Auth.onChange(renderForUser);
  });
});
