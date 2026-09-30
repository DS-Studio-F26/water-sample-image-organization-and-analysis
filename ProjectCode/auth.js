/**
 * Supabase client and sign-in UI shared by every page.
 *
 * Load order: supabase-js (CDN), config.js, auth.js, then the page's script.
 *
 *   window.sb             the Supabase client (null if supabase-js didn't load)
 *   Auth.ready            promise -> { user, profile } once the session is known
 *   Auth.current()        the latest { user, profile }; profile = { role, email, full_name }
 *   Auth.onChange(fn)     fn({ user, profile }) after every sign-in state change
 *   Auth.refresh()        re-read the session and profile (e.g. after a role change)
 *   Auth.openSignIn(mode) open the modal: 'signin' | 'signup' | 'forgot'
 *   Auth.isRecovery()     true on a password-reset link visit
 *
 * Pages with an element #auth-area get the header controls rendered into it.
 * These checks only decide what to show; the database enforces who can do what.
 */
(function () {
  // supabase-js removes tokens from the URL as it starts, so keep a copy.
  const initialHash = window.location.hash;
  const hashParams = new URLSearchParams(initialHash.replace(/^#/, ''));
  let recovery = hashParams.get('type') === 'recovery';

  const config = window.APP_CONFIG;
  const sb = window.supabase && config
    ? window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
    : null;
  window.sb = sb;

  let current = { user: null, profile: null };
  let known = false;  // false until the first session check finishes
  let refreshSeq = 0;
  let latestRefresh = null;  // promise of the most recent refresh()
  const listeners = [];

  // 1. Session and profile

  async function loadProfile(user) {
    const { data, error } = await sb
      .from('profiles')
      .select('role, email, full_name')
      .eq('id', user.id)
      .maybeSingle();
    if (error) console.warn('Could not load profile:', error.message);
    return data || { role: 'viewer', email: user.email, full_name: null };
  }

  // Re-read the session and profile. Overlapping calls are normal: a sign-in
  // from the URL (Google, email links) fires SIGNED_IN while the first check
  // is still running. Only the newest call applies its result, and every
  // caller's promise -- including Auth.ready -- resolves with that newest state.
  function refresh() {
    if (!sb) {
      known = true;
      return Promise.resolve(current);
    }
    const seq = ++refreshSeq;
    const run = (async () => {
      const { data } = await sb.auth.getSession();
      const user = data.session ? data.session.user : null;
      const profile = user ? await loadProfile(user) : null;
      if (seq !== refreshSeq) return latestRefresh;  // superseded: wait for the newer result
      current = { user, profile };
      known = true;
      renderAuthArea();
      listeners.forEach(fn => fn(current));
      return current;
    })();
    latestRefresh = run;
    return run;
  }

  const ready = refresh();

  if (sb) {
    sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recovery = true;
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      // Calling Supabase inside this callback can deadlock, so defer it.
      setTimeout(refresh, 0);
    });
  }

  // An expired or invalid email link comes back as #error=...&error_description=...
  // Pages with a header sign-in area explain it in the modal; the reset page
  // shows its own message.
  const linkError = hashParams.get('error_description');
  if (linkError && document.getElementById('auth-area')) {
    ready.then(() => {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      openModal('signin', friendlyError(linkError.replace(/\+/g, ' ')), 'error');
    });
  }

  // 2. Header controls (#auth-area)

  function renderAuthArea() {
    const area = document.getElementById('auth-area');
    if (!area) return;
    area.innerHTML = '';

    if (!sb || !known) return;
    if (!current.user) {
      area.appendChild(button('Sign in', 'btn btn-primary btn-sm', () => openModal('signin')));
      return;
    }

    const role = (current.profile && current.profile.role) || 'viewer';
    const email = document.createElement('span');
    email.className = 'auth-email';
    email.textContent = current.user.email;
    email.title = current.user.email;
    area.appendChild(email);
    area.appendChild(roleBadge(role));

    if (role === 'admin' && !/admin\.html$/.test(window.location.pathname)) {
      const link = document.createElement('a');
      link.className = 'btn btn-sm';
      link.href = 'admin.html';
      link.textContent = 'Admin';
      area.appendChild(link);
    }
    area.appendChild(button('Sign out', 'btn btn-sm', async () => {
      await sb.auth.signOut();
    }));
  }

  function roleBadge(role) {
    const badge = document.createElement('span');
    badge.className = `badge role-badge role-${role}`;
    badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    return badge;
  }

  function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // 3. Sign-in modal

  const GOOGLE_LOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">'
    + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
    + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
    + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>'
    + '</svg>';

  const MODES = {
    signin: { title: 'Sign in', submit: 'Sign in with email', google: true, password: true, confirm: false },
    signup: { title: 'Create an account', submit: 'Create account', google: true, password: true, confirm: true },
    forgot: { title: 'Reset your password', submit: 'Send reset link', google: false, password: false, confirm: false },
  };

  let modal = null;
  let mode = 'signin';
  let returnFocusTo = null;

  function buildModal() {
    modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'auth-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <div class="modal-header">
          <h2 id="auth-modal-title">Sign in</h2>
          <button type="button" class="close-btn" data-action="close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="modal-intro text-muted">You only need an account for the admin page.
            Browsing, viewing and downloading images work without signing in.</p>
          <button type="button" class="btn-google" data-action="google">${GOOGLE_LOGO}<span>Continue with Google</span></button>
          <div class="auth-divider"><span>or use email</span></div>
          <form class="auth-form" novalidate>
            <div class="form-field">
              <label for="auth-email">Email</label>
              <input id="auth-email" name="email" type="email" autocomplete="email" required>
            </div>
            <div class="form-field" data-field="password">
              <label for="auth-password">Password</label>
              <input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="6">
            </div>
            <div class="form-field" data-field="confirm">
              <label for="auth-confirm">Confirm password</label>
              <input id="auth-confirm" name="confirm" type="password" autocomplete="new-password" minlength="6">
            </div>
            <div class="auth-message" role="alert" hidden></div>
            <button type="submit" class="btn auth-submit">Sign in with email</button>
          </form>
          <div class="auth-links">
            <button type="button" class="link-btn" data-mode="signup">Create an account</button>
            <button type="button" class="link-btn" data-mode="forgot">Forgot password?</button>
            <button type="button" class="link-btn" data-mode="signin">Back to sign in</button>
          </div>
        </div>
        <div class="modal-footer text-muted">
          By signing in you agree to the <a href="privacy.html">Privacy Policy</a>.
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-action="close"]')) closeModal();
      const modeLink = e.target.closest('[data-mode]');
      if (modeLink) setMode(modeLink.dataset.mode);
      if (e.target.closest('[data-action="google"]')) signInWithGoogle();
    });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Tab') trapFocus(e);
    });
    modal.querySelector('.auth-form').addEventListener('submit', onSubmit);
  }

  function setMode(newMode) {
    mode = newMode;
    const m = MODES[mode];
    modal.querySelector('#auth-modal-title').textContent = m.title;
    modal.querySelector('.auth-submit').textContent = m.submit;
    modal.querySelector('.btn-google').hidden = !m.google;
    modal.querySelector('.auth-divider').hidden = !m.google;
    modal.querySelector('[data-field="password"]').hidden = !m.password;
    modal.querySelector('[data-field="confirm"]').hidden = !m.confirm;
    modal.querySelector('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    modal.querySelectorAll('[data-mode]').forEach(link => {
      link.hidden = link.dataset.mode === mode || (mode !== 'signin' && link.dataset.mode !== 'signin');
    });
    showMessage('');
  }

  function openModal(newMode = 'signin', message = '', kind = 'error') {
    if (!sb) return;
    if (!modal) buildModal();
    returnFocusTo = document.activeElement;
    setMode(newMode);
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (message) showMessage(message, kind);
    const first = MODES[mode].google ? modal.querySelector('.btn-google') : modal.querySelector('#auth-email');
    first.focus();
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    modal.querySelector('.auth-form').reset();
    if (returnFocusTo && returnFocusTo.focus) returnFocusTo.focus();
  }

  function trapFocus(e) {
    const focusable = Array.from(modal.querySelectorAll('button, a[href], input'))
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }

  function showMessage(text, kind = 'error') {
    const box = modal.querySelector('.auth-message');
    box.textContent = text;
    box.className = `auth-message auth-message-${kind}`;
    box.hidden = !text;
  }

  function setBusy(busy) {
    modal.querySelectorAll('button, input').forEach(el => { el.disabled = busy; });
  }

  // Where Supabase sends the browser back to after Google or an email link.
  function pageUrl() {
    return window.location.origin + window.location.pathname;
  }

  async function signInWithGoogle() {
    setBusy(true);
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: pageUrl() },
    });
    if (error) {  // on success the browser is already navigating to Google
      setBusy(false);
      showMessage(friendlyError(error.message));
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value.trim();
    const password = form.password.value;

    if (!email || !form.email.checkValidity()) return showMessage('Enter a valid email address.');
    if (MODES[mode].password && password.length < 6) {
      return showMessage('Passwords must be at least 6 characters.');
    }
    if (mode === 'signup' && password !== form.confirm.value) {
      return showMessage("The two passwords don't match.");
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) return showMessage(friendlyError(error.message));
        closeModal();
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: pageUrl() },
        });
        if (error) return showMessage(friendlyError(error.message));
        if (data.session) return closeModal();  // only if email confirmation were turned off
        form.reset();
        showMessage(`Almost done: we sent a confirmation link to ${email}. `
          + 'Open it to finish creating your account.', 'success');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: new URL('reset-password.html', window.location.href).href,
        });
        if (error) return showMessage(friendlyError(error.message));
        showMessage(`If an account exists for ${email}, a password reset link is on its way.`, 'success');
      }
    } catch (err) {
      showMessage(friendlyError(err.message));
    } finally {
      setBusy(false);
    }
  }

  function friendlyError(message) {
    const m = String(message || '');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) {
      return 'Please confirm your email first: open the link we sent when you signed up.';
    }
    if (/rate limit|too many/i.test(m)) {
      return 'Too many attempts or emails in a short time. Please wait a while and try again.';
    }
    if (/expired|invalid/i.test(m) && /link|otp|token/i.test(m)) {
      return 'That email link has expired or was already used. Please request a new one.';
    }
    if (/failed to fetch|network/i.test(m)) {
      return "Can't reach the sign-in service. Check your connection and try again.";
    }
    return m || 'Something went wrong. Please try again.';
  }

  // 4. Public API

  window.Auth = {
    ready,
    current: () => current,
    onChange: fn => listeners.push(fn),
    refresh,
    openSignIn: (m = 'signin') => openModal(m),
    isRecovery: () => recovery,
    linkError,
    friendlyError,
    roleBadge,
  };

  document.addEventListener('DOMContentLoaded', renderAuthArea);
})();
