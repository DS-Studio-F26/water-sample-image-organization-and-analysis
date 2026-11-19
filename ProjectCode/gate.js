/**
 * Members only: the catalog, labeling, review and stacks pages are for approved
 * accounts (labeler, admin, owner). Everyone else gets a short "members only"
 * card pointing to the admin page, where they can sign in and request a role.
 *
 * Load it in <head>, right after theme.js, so the page is hidden before it is
 * first painted. It needs auth.js (loaded at the end of <body>).
 *
 *   Gate.ready   promise -> true once an approved account is signed in (or in
 *                demo mode), false when the members-only card is shown. The
 *                page scripts wait for it before loading any data.
 *
 * Demo mode (?demo, demo.js) runs on made-up data, so it stays open to anyone.
 *
 * This only decides what the page shows. The database is what keeps the data
 * private: since 007_members_only.sql it returns nothing to anyone else.
 */
(function () {
  'use strict';

  var MEMBER_ROLES = ['owner', 'admin', 'labeler'];
  var root = document.documentElement;

  // The same rule demo.js uses (?demo turns it on for the tab, ?demo=0 off),
  // read early so demo visitors never see the page flash hidden.
  function demoRequested() {
    var params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      var arg = params.get('demo');
      return !(arg === '0' || arg === 'off');
    }
    try { return sessionStorage.getItem('wsic-demo') === '1'; } catch (e) { return false; }
  }

  var resolveReady;
  var ready = new Promise(function (res) { resolveReady = res; });
  window.Gate = { ready: ready };

  if (!demoRequested()) root.classList.add('gate-checking');

  var allowed = null;  // null until the first check

  function isMember(auth) {
    return !!(auth && auth.user && auth.profile && MEMBER_ROLES.indexOf(auth.profile.role) >= 0);
  }

  function check(auth) {
    var now = isMember(auth);
    if (allowed !== null) {
      // Signed in or out, or the role changed, while the page was open: start
      // over so the page loads (or drops) its data cleanly.
      if (now !== allowed) location.reload();
      else if (!now) renderCard(auth);  // e.g. signed in, but still a viewer
      return;
    }
    allowed = now;
    root.classList.remove('gate-checking');
    if (now) {
      resolveReady(true);
    } else {
      root.classList.add('gate-locked');
      renderCard(auth);
      resolveReady(false);
    }
  }

  var card = null;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    [].concat(kids || []).forEach(function (c) {
      if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', 'icons.svg#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function demoHref() {
    return location.pathname + '?demo';
  }

  function renderCard(auth) {
    if (!card) {
      card = el('main', { class: 'gate-main', id: 'gate' });
      var header = document.querySelector('.appbar');
      if (header && header.parentNode) header.parentNode.insertBefore(card, header.nextSibling);
      else document.body.insertBefore(card, document.body.firstChild);
    }
    var signedIn = !!(auth && auth.user);
    var noService = !window.sb;
    var title = noService ? 'Can’t check your account'
      : signedIn ? 'Waiting for approval' : 'Members only';
    var text = noService
      ? 'The sign-in service didn’t load, so this page can’t tell whether you’re a member. Check your connection and reload the page.'
      : signedIn
        ? 'Your account (' + (auth.user.email || 'signed in') + ') is a Viewer. The catalog is open to approved labelers and admins only: request the labeler role on the Admin page, or ask an admin to invite you.'
        : 'The catalog is open to approved labelers and admins only. Sign in, then request a role on the Admin page, or ask an admin to invite your email address.';

    var actions = el('div', { class: 'gate-actions' });
    if (!signedIn && !noService && window.Auth) {
      var signIn = el('button', { type: 'button', class: 'btn btn-primary' }, [icon('log-in'), 'Sign in']);
      signIn.addEventListener('click', function () { Auth.openSignIn('signin'); });
      actions.appendChild(signIn);
    }
    actions.appendChild(el('a', { class: signedIn ? 'btn btn-primary' : 'btn', href: 'admin.html' },
      [icon('shield'), signedIn ? 'Request a role' : 'Go to the Admin page']));
    actions.appendChild(el('a', { class: 'btn btn-ghost', href: demoHref() }, [icon('sparkles'), 'Try the demo']));

    card.innerHTML = '';
    card.appendChild(el('div', { class: 'wrap' },
      el('section', { class: 'page-card gate-card', 'aria-labelledby': 'gate-title' }, [
        el('span', { class: 'gate-icon', 'aria-hidden': 'true' }, icon('lock')),
        el('h1', { id: 'gate-title', text: title }),
        el('p', { text: text }),
        actions,
        el('p', { class: 'gate-note', text: 'The demo runs on made-up sample data, so anyone can try it.' }),
      ])));
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.APP_DEMO) {
      root.classList.remove('gate-checking');
      resolveReady(true);
      return;
    }
    if (!window.Auth) {
      allowed = false;
      root.classList.remove('gate-checking');
      root.classList.add('gate-locked');
      renderCard(null);
      resolveReady(false);
      return;
    }
    Auth.ready.then(function (auth) {
      check(auth);
      Auth.onChange(check);
    });
  });
})();
