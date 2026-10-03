/**
 * Visual effects: the drifting "plankton" behind the banner, the rolling waves
 * along its bottom edge, and a confetti burst for finished folders.
 *
 * Everything here is decoration. It pauses when scrolled off-screen or in a
 * background tab, and draws a single still frame for visitors who prefer
 * reduced motion.
 */
(function () {
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function cssRgb(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // 1. Waves ------------------------------------------------------------------

  function wavePath(amp, base) {
    var d = 'M0 ' + base;
    for (var i = 0; i < 4; i++) {
      var x = i * 720;
      d += ' C' + (x + 240) + ' ' + (base - amp) + ',' + (x + 480) + ' ' + (base + amp) + ',' + (x + 720) + ' ' + base;
    }
    return d + ' V120 H0 Z';
  }

  function waves(host) {
    if (host.childElementCount) return;
    [[38, 52], [-30, 64], [22, 78]].forEach(function (cfg) {
      host.insertAdjacentHTML('beforeend',
        '<svg viewBox="0 0 2880 120" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="' +
        wavePath(cfg[0], cfg[1]) + '"/></svg>');
    });
  }

  // 2. Plankton -----------------------------------------------------------------

  function plankton(canvas) {
    var ctx = canvas.getContext('2d');
    var host = canvas.parentElement;
    var w = 0, h = 0, parts = [], raf = 0, visible = true;
    var pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    var c1 = '148, 240, 226', c2 = '158, 205, 255';

    function readColors() {
      c1 = cssRgb('--fx-1', c1);
      c2 = cssRgb('--fx-2', c2);
    }

    function make(initial) {
      var roll = Math.random();
      var kind = roll < 0.52 ? 'cell' : roll < 0.78 ? 'chain' : 'diatom';
      var depth = 0.35 + Math.random() * 0.9;
      return {
        kind: kind,
        x: Math.random() * w,
        y: initial ? Math.random() * h : h + 30,
        r: kind === 'cell' ? 3 + Math.random() * 9 : kind === 'diatom' ? 5 + Math.random() * 6 : 2 + Math.random() * 1.8,
        depth: depth,
        vx: (Math.random() - 0.5) * 0.18 * depth,
        vy: -(0.03 + Math.random() * 0.16) * depth,
        phase: Math.random() * 6.28,
        ang: Math.random() * 6.28,
        spin: (Math.random() - 0.5) * 0.004,
        beads: 4 + Math.floor(Math.random() * 5),
        tone: Math.random() < 0.7 ? c1 : c2,
      };
    }

    function resize() {
      var rect = host.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width; h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.max(14, Math.min(46, Math.round((w * h) / 21000)));
      parts = [];
      for (var i = 0; i < n; i++) parts.push(make(true));
      draw(0);
    }

    function draw(t) {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;

      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var px = p.x + (pointer.x - 0.5) * 46 * p.depth + Math.sin(t * 0.0006 + p.phase) * 10 * p.depth;
        var py = p.y + (pointer.y - 0.5) * 26 * p.depth;
        var a = 0.16 + p.depth * 0.3;

        if (p.kind === 'cell') {
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = 'rgba(' + p.tone + ',' + a + ')';
          ctx.fillStyle = 'rgba(' + p.tone + ',' + a * 0.22 + ')';
          ctx.beginPath(); ctx.arc(px, py, p.r, 0, 6.2832); ctx.fill(); ctx.stroke();
          ctx.fillStyle = 'rgba(' + p.tone + ',' + a * 1.4 + ')';
          ctx.beginPath(); ctx.arc(px + p.r * 0.25, py - p.r * 0.2, p.r * 0.28, 0, 6.2832); ctx.fill();
        } else if (p.kind === 'chain') {
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(' + p.tone + ',' + a * 0.8 + ')';
          ctx.fillStyle = 'rgba(' + p.tone + ',' + a * 1.1 + ')';
          ctx.beginPath();
          var bx = [], by = [];
          for (var b = 0; b < p.beads; b++) {
            var s = b * 9;
            var bxx = px + Math.cos(p.ang) * s - Math.sin(p.ang) * Math.sin(t * 0.0012 + b * 0.9 + p.phase) * 4;
            var byy = py + Math.sin(p.ang) * s + Math.cos(p.ang) * Math.sin(t * 0.0012 + b * 0.9 + p.phase) * 4;
            bx.push(bxx); by.push(byy);
            if (b === 0) ctx.moveTo(bxx, byy); else ctx.lineTo(bxx, byy);
          }
          ctx.stroke();
          for (var k = 0; k < bx.length; k++) { ctx.beginPath(); ctx.arc(bx[k], by[k], p.r, 0, 6.2832); ctx.fill(); }
        } else {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(p.ang);
          ctx.lineWidth = 1.1;
          ctx.strokeStyle = 'rgba(' + p.tone + ',' + a + ')';
          ctx.beginPath();
          ctx.ellipse(0, 0, p.r * 1.9, p.r * 0.75, 0, 0, 6.2832);
          ctx.moveTo(-p.r * 1.6, 0); ctx.lineTo(p.r * 1.6, 0);
          for (var s2 = -3; s2 <= 3; s2++) { ctx.moveTo(s2 * p.r * 0.45, -p.r * 0.5); ctx.lineTo(s2 * p.r * 0.45, p.r * 0.5); }
          ctx.stroke();
          ctx.restore();
        }

        p.x += p.vx; p.y += p.vy; p.ang += p.spin;
        if (p.y < -40 || p.x < -60 || p.x > w + 60) parts[i] = make(false);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function loop(t) {
      raf = 0;
      if (!visible || document.hidden) return;
      draw(t);
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && !reduce.matches) raf = requestAnimationFrame(loop); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    readColors();
    resize();
    if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(host);
    else window.addEventListener('resize', resize);

    host.addEventListener('pointermove', function (e) {
      var r = host.getBoundingClientRect();
      pointer.tx = (e.clientX - r.left) / r.width;
      pointer.ty = (e.clientY - r.top) / r.height;
    }, { passive: true });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) start(); else stop();
      }).observe(host);
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    if (window.Theme) Theme.onChange(function () { readColors(); parts.forEach(function (p) { p.tone = Math.random() < 0.7 ? c1 : c2; }); if (reduce.matches) draw(0); });
    start();
  }

  // 3. Confetti -------------------------------------------------------------------

  function confetti(origin) {
    if (reduce.matches) return;
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:130;pointer-events:none';
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var palette = [1, 2, 3, 4, 5, 6].map(function (n) { return cssRgb('--chart-' + n, '#2dd4bf'); });
    var ox = origin && origin.x != null ? origin.x : window.innerWidth / 2;
    var oy = origin && origin.y != null ? origin.y : window.innerHeight * 0.35;
    var bits = [];
    for (var i = 0; i < 150; i++) {
      var angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      var speed = 5 + Math.random() * 9;
      bits.push({
        x: ox, y: oy,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 7, h: 3 + Math.random() * 5,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
        color: palette[i % palette.length], life: 1,
      });
    }
    var born = performance.now();
    (function frame(now) {
      var elapsed = now - born;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      bits.forEach(function (b) {
        b.vy += 0.28; b.vx *= 0.992; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - 1400) / 900);
        ctx.translate(b.x, b.y); ctx.rotate(b.rot);
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      });
      if (elapsed < 2400) requestAnimationFrame(frame); else canvas.remove();
    })(born);
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.waves').forEach(waves);
    document.querySelectorAll('canvas[data-fx="plankton"]').forEach(plankton);
  });

  window.FX = { plankton: plankton, waves: waves, confetti: confetti };
})();
