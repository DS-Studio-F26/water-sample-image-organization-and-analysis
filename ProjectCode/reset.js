/**
 * Password reset page. The "Forgot password?" email links here; supabase-js
 * turns the link's token into a short-lived session (a PASSWORD_RECOVERY
 * sign-in), and this page lets the user set a new password with it.
 */

let resetFinished = false;  // after a successful update, ignore later sign-in events

function showResetSection(id) {
  ['reset-loading', 'reset-form-card', 'reset-done', 'reset-invalid'].forEach(sectionId => {
    document.getElementById(sectionId).hidden = sectionId !== id;
  });
}

function showResetMessage(text, kind = 'error') {
  const box = document.getElementById('reset-message');
  box.textContent = text;
  box.className = `auth-message auth-message-${kind}`;
  box.hidden = !text;
}

async function onResetSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const password = form.password.value;
  if (password.length < 6) return showResetMessage('Passwords must be at least 6 characters.');
  if (password !== form.confirm.value) return showResetMessage("The two passwords don't match.");

  const buttons = form.querySelectorAll('button, input');
  buttons.forEach(el => { el.disabled = true; });
  const { error } = await sb.auth.updateUser({ password });
  buttons.forEach(el => { el.disabled = false; });

  if (error) return showResetMessage(Auth.friendlyError(error.message));
  resetFinished = true;
  showResetSection('reset-done');
}

function showForUser({ user }) {
  if (resetFinished) return;
  if (!window.sb) {
    document.getElementById('reset-invalid-reason').textContent =
      "Can't reach the sign-in service right now. Please reload the page.";
    return showResetSection('reset-invalid');
  }
  if (Auth.linkError) {
    document.getElementById('reset-invalid-reason').textContent = Auth.friendlyError(Auth.linkError);
    return showResetSection('reset-invalid');
  }
  // Normally a recovery session from the email link; a user who is already
  // signed in can also change their password here directly.
  if (user) {
    document.getElementById('reset-for').textContent = `For ${user.email}`;
    return showResetSection('reset-form-card');
  }
  showResetSection('reset-invalid');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('reset-form').addEventListener('submit', onResetSubmit);
  document.getElementById('request-new-link').addEventListener('click', () => Auth.openSignIn('forgot'));

  Auth.ready.then(auth => {
    showForUser(auth);
    Auth.onChange(showForUser);
  });
});
