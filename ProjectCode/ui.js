/**
 * Shared UI helpers, loaded on every page after auth.js.
 *
 *   UI.h(tag, props, ...children)   build DOM without innerHTML
 *   UI.icon(name, cls)              <svg> from icons.svg ("sun" -> #i-sun)
 *   UI.toast({...})                 non-blocking notification (with Undo etc.)
 *   UI.announce(text)               say something to screen readers
 *   UI.countUp(el, n, opts)         animate a number up to n
 *   UI.dialog({...})                accessible modal dialog
 *   UI.imageUrl(path, download)     public URL of an image (demo-aware)
 *   UI.store.get/set                localStorage that never throws
 *   UI.csv / UI.download            build and save a CSV
 *
 * It also switches on the small effects: button ripples, card spotlights,
 * scroll-reveal, the app bar's scrolled shadow and the active nav link.
 */
(function () {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // 1. DOM helpers

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value == null || value === false) return;
        if (key === 'class' || key === 'className') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { el.dataset[k] = value[k]; });
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(parent, c); });
    else if (child.nodeType) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }

  function icon(name, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', 'icons.svg#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function escapeHTML(value) {
    if (value == null || value === '') return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function relativeTime(value) {
    var then = new Date(value).getTime();
    if (!then) return '';
    var seconds = Math.round((then - Date.now()) / 1000);
    var units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    var fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(seconds) >= units[i][1]) return fmt.format(Math.round(seconds / units[i][1]), units[i][0]);
    }
    return 'just now';
  }

  // localStorage that survives private windows and blocked storage
  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem('wsic-' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem('wsic-' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  function imageUrl(relativePath, download) {
    if (window.Demo && window.Demo.imageUrl) return window.Demo.imageUrl(relativePath, download);
    var base = window.APP_CONFIG.IMAGE_BASE_URL.replace(/\/+$/, '');
    var path = relativePath.split('/').map(encodeURIComponent).join('/');
    return base + '/' + path + (download ? '?download=1' : '');
  }

  // 2. CSV

  function csv(rows, columns) {
    var quote = function (v) {
      if (v == null) return '';
      var s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var lines = [columns.join(',')];
    rows.forEach(function (row) { lines.push(columns.map(function (c) { return quote(row[c]); }).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // 3. Screen-reader announcements and toasts

  var live = null;
  function announce(text) {
    if (!live) {
      live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'sr-live' });
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 40);
  }

  var toastHost = null;
  var toastsById = {};

  function toast(opts) {
    opts = opts || {};
    if (!toastHost) {
      toastHost = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
      document.body.appendChild(toastHost);
    }
    if (opts.id && toastsById[opts.id]) toastsById[opts.id].dismiss(true);

    var kind = opts.kind || 'info';
    var iconName = { success: 'check-circle', error: 'alert', info: 'info' }[kind] || 'info';
    var duration = opts.sticky ? 60000 : (opts.duration || (opts.action ? 8000 : 5000));
    var el = h('div', { class: 'toast ' + kind + (opts.sticky ? ' sticky' : ''), role: kind === 'error' ? 'alert' : 'status' },
      icon(iconName),
      h('div', { class: 'toast-msg', text: opts.message || '' }));
    el.style.setProperty('--toast-ms', duration + 'ms');

    var timer = null;
    var closed = false;
    function dismiss(immediate) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (opts.id) delete toastsById[opts.id];
      if (immediate) { el.remove(); return; }
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 280);
    }

    if (opts.action) {
      el.appendChild(h('button', {
        type: 'button', class: 'toast-action', text: opts.action.label,
        onclick: function () { dismiss(); opts.action.onClick(); },
      }));
    } else {
      el.appendChild(h('span'));
    }
    el.appendChild(h('button', { type: 'button', class: 'close-btn', 'aria-label': 'Dismiss', onclick: function () { dismiss(); } }, icon('x')));

    toastHost.appendChild(el);
    while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
    if (!opts.sticky) {
      var arm = function () { timer = setTimeout(dismiss, duration); };
      el.addEventListener('mouseenter', function () { clearTimeout(timer); });
      el.addEventListener('mouseleave', arm);
      arm();
    }
    var handle = { dismiss: dismiss, el: el };
    if (opts.id) toastsById[opts.id] = handle;
    return handle;
  }

  // 4. Modal dialogs

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapFocus(container, e) {
    if (e.key !== 'Tab') return;
    var nodes = Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
    if (!nodes.length) { e.preventDefault(); return; }
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }

  function dialog(opts) {
    var returnTo = document.activeElement;
    var titleId = 'dlg-' + Math.random().toString(36).slice(2, 8);
    var closeBtn = h('button', { type: 'button', class: 'close-btn', 'aria-label': 'Close' }, icon('x'));
    var box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'modal-header' }, h('h2', { id: titleId, text: opts.title }), closeBtn),
      h('div', { class: 'modal-body' }, opts.content));
    var backdrop = h('div', { class: 'modal-backdrop' }, box);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      document.body.classList.remove('modal-open');
      if (returnTo && returnTo.focus) returnTo.focus();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else trapFocus(box, e);
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    document.body.classList.add('modal-open');
    closeBtn.focus();
    return { close: close, el: box };
  }

  // 5. Number count-up

  function countUp(el, to, opts) {
    opts = opts || {};
    var format = opts.format || function (n) { return Math.round(n).toLocaleString(); };
    if (el._countRaf) cancelAnimationFrame(el._countRaf);
    var from = opts.from != null ? opts.from : (el._countValue != null ? el._countValue : 0);
    el._countValue = to;
    if (reduceMotion.matches || from === to) { el.textContent = format(to); return; }
    var duration = opts.duration || 1000;
    var start = null;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 4);
      el.textContent = format(from + (to - from) * eased);
      if (t < 1) el._countRaf = requestAnimationFrame(frame);
      else el.textContent = format(to);
    }
    el._countRaf = requestAnimationFrame(frame);
  }

  // 6. Small effects

  function initRipples() {
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest && e.target.closest('.btn');
      if (!btn || btn.disabled || reduceMotion.matches) return;
      var rect = btn.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height) * 2.2;
      var dot = h('span', { class: 'ripple', 'aria-hidden': 'true' });
      dot.style.width = dot.style.height = size + 'px';
      dot.style.left = (e.clientX - rect.left - size / 2) + 'px';
      dot.style.top = (e.clientY - rect.top - size / 2) + 'px';
      btn.appendChild(dot);
      setTimeout(function () { dot.remove(); }, 700);
    });
  }

  function initSpotlight() {
    var frame = null;
    document.addEventListener('pointermove', function (e) {
      if (frame || e.pointerType === 'touch') return;
      var target = e.target.closest && e.target.closest('.spot');
      if (!target) return;
      frame = requestAnimationFrame(function () {
        frame = null;
        var rect = target.getBoundingClientRect();
        target.style.setProperty('--mx', (e.clientX - rect.left) + 'px');
        target.style.setProperty('--my', (e.clientY - rect.top) + 'px');
      });
    }, { passive: true });
  }

  var revealObserver = null;
  function reveal(root) {
    var nodes = (root || document).querySelectorAll('.reveal:not(.in)');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window) || reduceMotion.matches) {
      nodes.forEach(function (n) { n.classList.add('in'); });
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('in'); revealObserver.unobserve(entry.target); }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    }
    nodes.forEach(function (n) { revealObserver.observe(n); });
  }

  function initAppbar() {
    var bar = document.querySelector('.appbar');
    if (bar) {
      var onScroll = function () { bar.classList.toggle('scrolled', window.scrollY > 8); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    var here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.appnav a').forEach(function (a) {
      var target = a.getAttribute('href').split(/[?#]/)[0];
      if (target === here || (here === '' && target === 'index.html')) a.setAttribute('aria-current', 'page');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initRipples();
    initSpotlight();
    initAppbar();
    reveal(document);
    var main = document.getElementById('main');
    if (main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  });

  window.UI = {
    h: h, icon: icon, escapeHTML: escapeHTML, formatBytes: formatBytes, debounce: debounce,
    relativeTime: relativeTime, store: store, imageUrl: imageUrl, csv: csv, download: download,
    announce: announce, toast: toast, dialog: dialog, countUp: countUp, reveal: reveal,
    trapFocus: trapFocus, reducedMotion: function () { return reduceMotion.matches; },
  };
})();
