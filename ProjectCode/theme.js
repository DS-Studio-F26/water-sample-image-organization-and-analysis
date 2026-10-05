/**
 * Light / dark theme and text size. Loaded in <head> so both are on <html>
 * before the first paint (no flash).
 *
 *   Theme.get()           'light' | 'dark'
 *   Theme.set(theme)      apply + remember (until the visitor picks again)
 *   Theme.toggle(button)  flip, with an expanding-circle reveal from `button`
 *   Theme.onChange(fn)    fn(theme) after every change (charts, canvas, ...)
 *
 *   TextSize.get()        the text scale, 1 (default) to 4
 *   TextSize.set(scale)   apply + remember (rounded to 0.1)
 *   TextSize.onChange(fn) fn(scale) after every change
 *
 * With no saved choice the theme follows the operating system, live.
 * Any element with [data-theme-toggle] becomes a toggle button.
 */
(function () {
  var KEY = 'wsic-theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];
  var META_COLORS = { light: '#eef4f2', dark: '#061317' };

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }
  function remember(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode: still works for this visit */ }
  }
  function system() { return media && media.matches ? 'dark' : 'light'; }
  function get() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_COLORS[theme]);
    syncButtons(theme);
    listeners.forEach(function (fn) { try { fn(theme); } catch (e) { console.error(e); } });
  }

  function syncButtons(theme) {
    var next = theme === 'dark' ? 'light' : 'dark';
    var nodes = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('aria-label', 'Switch to ' + next + ' mode');
      nodes[i].setAttribute('title', 'Switch to ' + next + ' mode');
      nodes[i].setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
  }

  function set(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    remember(theme);
    if (theme !== get()) apply(theme);
  }

  function toggle(origin) {
    var next = get() === 'dark' ? 'light' : 'dark';
    remember(next);

    if (!document.startViewTransition || reducedMotion()) {
      root.classList.add('theme-fade');
      apply(next);
      window.setTimeout(function () { root.classList.remove('theme-fade'); }, 450);
      return;
    }

    var rect = origin && origin.getBoundingClientRect ? origin.getBoundingClientRect() : null;
    var x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    var y = rect ? rect.top + rect.height / 2 : 0;
    var radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    var transition = document.startViewTransition(function () { apply(next); });
    transition.ready.then(function () {
      root.animate(
        { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
        { duration: 650, easing: 'cubic-bezier(0.22, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(function () { /* transition skipped: the theme is already applied */ });
  }

  apply(saved() || system());

  if (media) {
    var onSystem = function (e) { if (!saved()) apply(e.matches ? 'dark' : 'light'); };
    if (media.addEventListener) media.addEventListener('change', onSystem);
    else if (media.addListener) media.addListener(onSystem);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (btn) toggle(btn);
  });
  document.addEventListener('DOMContentLoaded', function () { syncButtons(get()); });

  window.Theme = {
    get: get,
    set: set,
    toggle: toggle,
    onChange: function (fn) { listeners.push(fn); },
  };

  // Text size. The scale multiplies the root font size (base.css), so every
  // rem-sized text, gap and panel grows together and nothing overlaps; the few
  // things that must not grow divide by it (--rem0). The breakpoints are in px,
  // so data-text-big switches on the stacked layouts whenever the chosen size
  // leaves less room than the side-by-side layouts need.
  var SIZE_KEY = 'wsic-text-scale';
  var SIZE_MIN = 1, SIZE_MAX = 4;
  var BIG_BELOW = 1100;  // px of room, measured in 1x text
  var sizeListeners = [];

  function clampScale(value) {
    var n = Math.round(Number(value) * 10) / 10;
    return isFinite(n) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)) : SIZE_MIN;
  }
  function savedScale() {
    try { return clampScale(localStorage.getItem(SIZE_KEY) || SIZE_MIN); } catch (e) { return SIZE_MIN; }
  }

  var scale = savedScale();

  function fitLayout() {
    if (scale > 1 && window.innerWidth / scale < BIG_BELOW) root.setAttribute('data-text-big', '');
    else root.removeAttribute('data-text-big');
  }

  function applyScale(value) {
    scale = value;
    if (scale === 1) root.style.removeProperty('--text-scale');
    else root.style.setProperty('--text-scale', String(scale));
    fitLayout();
  }

  function setScale(value) {
    var next = clampScale(value);
    try {
      if (next === 1) localStorage.removeItem(SIZE_KEY); else localStorage.setItem(SIZE_KEY, String(next));
    } catch (e) { /* private mode: still works for this visit */ }
    if (next === scale) return;
    applyScale(next);
    sizeListeners.forEach(function (fn) { try { fn(scale); } catch (e) { console.error(e); } });
  }

  applyScale(scale);
  var fitFrame = null;
  window.addEventListener('resize', function () {
    if (fitFrame) return;
    fitFrame = window.requestAnimationFrame(function () { fitFrame = null; fitLayout(); });
  });

  window.TextSize = {
    min: SIZE_MIN,
    max: SIZE_MAX,
    get: function () { return scale; },
    set: setScale,
    onChange: function (fn) { sizeListeners.push(fn); },
  };
})();
