/**
 * Demo mode: the catalog and labeling running on made-up data. Turn it on by
 * adding ?demo to any page's address, and off with ?demo=0:
 *
 *   labeling.html?demo
 *   index.html?demo=0
 *
 * It swaps the data side of window.supabase for a small in-memory imitation
 * (the handful of calls the pages make) and generates microscope-style images
 * as SVG, so the labeling workflow can be tried -- or shown to the professor --
 * before the real database has the labeling migration, or offline. Anyone may
 * label the sample images, signed in or not. Labels are kept in the browser
 * tab's session storage; nothing is ever sent anywhere.
 *
 * Accounts stay real: sign-in, sign-out, the header and your role all come from
 * Supabase as usual, so entering or leaving the demo never signs you in or out.
 *
 * The 45 folders below are a real sample of the catalog's folder names.
 */
(function () {
  'use strict';

  var FLAG = 'wsic-demo', DATA = 'wsic-demo-data';

  function session(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
    } catch (e) { /* storage blocked: demo still works for this page */ }
    return null;
  }

  var params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    var arg = params.get('demo');
    if (arg === '0' || arg === 'off') { session(FLAG, null); session(DATA, null); }
    else session(FLAG, '1');
  }
  if (session(FLAG) !== '1') return;
  window.APP_DEMO = true;

  // The real supabase-js (null if the CDN didn't load), kept for accounts.
  var realLib = window.supabase && window.supabase.createClient ? window.supabase : null;

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  // [folder_name, site, water_body, date, iso_date, magnification, code, capture, dilution, is_pp, images, minW, maxW, minH, maxH]
  var FOLDER_DATA = [
    ["Indian Lake_10.14.2023_10x_TM 0.5 dilution -pp","indian lake","lake","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,380,18,731,26,816],
    ["Indian_CR10.15.22_10x_AI1-pp-1","indian lake","lake","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,16,374,19,1089],
    ["Indian_WCMC_CR10.16.21_TR1-PP","indian lake","lake","10.16.21","2021-10-16","10x","TR1","trigger","",true,93,25,268,27,368],
    ["Coes Reservoir_10.14.2023_10x_TM 0.5 dilution -pp","coes reservoir","reservoir","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,65,24,358,26,571],
    ["CoesPond_WCMC_CR10.16.21_TR1-pp","coes reservoir","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,21,22,197,30,452],
    ["Coes Reservoir_10.2.2023_10x_TM 0.5 dilution -pp","coes reservoir","reservoir","10.2.2023","2023-10-02","10x","TM","trigger","0.5 dilution",true,71,23,462,29,640],
    ["Little Indian Lake_10.14.2023_10x_TM 0.1 dilution -pp","little indian lake","lake","10.14.2023","2023-10-14","10x","TM","trigger","0.1 dilution",true,38,26,211,25,270],
    ["LittleIndian_CR10.15.22_10x_AI1 .1dilution-pp","little indian lake","lake","10.15.22","2022-10-15","10x","AI1","autoimage","1dilution",true,430,19,427,21,1038],
    ["LittleIndian_WCMC_CR10.16.21_TR1-PP","little indian lake","lake","10.16.21","2021-10-16","10x","TR1","trigger","",true,150,18,430,27,814],
    ["Cooks_CR10.15.22_10x_AI1-pp","cooks pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,17,385,18,373],
    ["Cooks_WCMC_CR10.16.21_TR1-PP","cooks pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,40,27,321,28,712],
    ["Cooks_CR10.3.22_10x_AI1-pp","cooks pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","",true,150,20,343,19,347],
    ["Newton Pond_10.14.2023_10x_TM 0.5 dilution -pp","newton pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,16,31,113,30,111],
    ["Newton_CR10.15.22_10x_AI1-pp","newton pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,17,315,16,284],
    ["Newton_WCMC_CR10.16.21_TR1-PP","newton pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,45,23,229,28,342],
    ["Manchaug Pond_10.14.2023_10x_TM 0.5 dilution -pp","manchaug pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,16,27,133,32,123],
    ["Manchaug_CR10.15.22_10x_AI1-pp","manchaug pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,44,18,169,25,184],
    ["Manchaug_WCMC_CR10.16.21_TR1-PP","manchaug pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,16,27,113,30,131],
    ["Burncoat Pond_10.14.2023_10x_TM 0.1 dilution -pp","burncoat pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.1 dilution",true,43,26,513,29,585],
    ["Burncoat_CR10.15.22_10x_AI1 .1 dilution-pp","burncoat pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","1 dilution",true,260,22,134,18,341],
    ["Burncoat_WCMC_CR10.16.21_TR1-PP","burncoat pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,150,18,660,24,1062],
    ["Green Hill Pond_10.14.2023_10x_TM 0.5 dilution -pp","green hill pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,110,22,797,24,1050],
    ["GreenHill_CR10.15.22_10x_AI1 .1 dilution-pp","green hill pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","1 dilution",true,150,22,263,23,419],
    ["Green Hill Pond_10.2.2023_10x_TM 0.1 dilution -pp","green hill pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.1 dilution",true,16,30,608,26,464],
    ["Patch Reservoir_10.14.2023_10x_TM 0.5 dilution -pp","patch reservoir","reservoir","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,78,26,258,25,239],
    ["Patch Res_10.2.2023_10x_TM 0.5 dilution -pp","patch reservoir","reservoir","10.2.2023","2023-10-02","10x","TM","trigger","0.5 dilution",true,51,27,398,29,488],
    ["Patch Res_10.30.2023_10x_TM 0.5 dilution-pp","patch reservoir","reservoir","10.30.2023","2023-10-30","10x","TM","trigger","0.5 dilution",true,30,29,171,28,258],
    ["Kiver Pond_10.14.2023_10x_TM 0.1 dilution -pp","kiver pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.1 dilution",true,16,33,178,41,85],
    ["Kiver_CR10.15.22_10x_AI1 .1dilution-pp","kiver pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","1dilution",true,138,21,163,24,304],
    ["Kiver_WCMC_CR10.16.21_TR2-PP","kiver pond","pond","10.16.21","2021-10-16","10x","TR2","trigger","",true,150,19,485,20,586],
    ["Patch Pond_10.14.2023_10x_TM 0.5 dilution -pp","patch pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,26,23,223,27,251],
    ["PatchPond_CR10.15.22_10x_AI1-pp","patch pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,18,262,22,425],
    ["Patch Pond_10.2.2023_10x_TM 0.5 dilution -pp","patch pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.5 dilution",true,19,34,215,32,142],
    ["Salisbury Pond_10.14.2023_10x_TM 0.5 dilution -pp","salisbury pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,150,24,499,22,960],
    ["Salisbury_WCMC_CR10.16.21_TR1-PP","salisbury pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,63,22,235,24,416],
    ["Salisbury Pond_10.2.2023_10x_TM 0.1 dilution -pp","salisbury pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.1 dilution",true,20,21,161,33,202],
    ["Ecotarium Pond_10.14.2023_10x_TM 0.5 dilution -pp","ecotarium pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,17,29,132,29,152],
    ["Ecotarium_CR10.3.22_10x AI1 0.1 dilution-pp","ecotarium pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","0.1 dilution",true,73,20,92,25,159],
    ["Ecotarium_5.15.2023_10X_TR1 0.1 dilution-pp","ecotarium pond","pond","5.15.2023","2023-05-15","10x","TR1","trigger","0.1 dilution",true,16,28,259,33,226],
    ["Stevens Pond_10.14.2023_10x_TM 0.5 dilution -pp","stevens pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5 dilution",true,16,38,139,34,109],
    ["Stevens_CR10.15.22_10x_AI1-pp","stevens pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,36,21,97,27,100],
    ["Stevens_CR10.3.22_10x AI1-pp","stevens pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","",true,135,22,237,22,185],
    ["Farm_CR10.15.22_10x_AI1-pp","farm pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,20,166,24,258],
    ["Farm Pond_10.30.2023_10x_TM 0.5 dilution -pp","farm pond","pond","10.30.2023","2023-10-30","10x","TM","trigger","0.5 dilution",true,16,43,105,45,93],
    ["Farm Pond_4.29.23_10x_TR1 no dilution-pp","farm pond","pond","4.29.23","2023-04-29","10x","TR1","trigger","no dilution",true,16,42,96,33,132]
  ];

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hex16(s) {
    var a = hashStr(s).toString(16), b = hashStr(s + '#').toString(16);
    return (('00000000' + a).slice(-8) + ('00000000' + b).slice(-8));
  }

  // --- procedural "microscope" images -----------------------------------------------

  var specCache = {};
  function specimen(relPath) {
    if (specCache[relPath]) return specCache[relPath];
    var seed = hashStr(relPath), r = rng(seed), roll = r();
    var cls = roll < 0.34 ? 'filament' : roll < 0.46 ? 'colony' : roll < 0.62 ? 'diatom' : roll < 0.74 ? 'other' : roll < 0.9 ? 'debris' : 'blank';
    var w, h;
    if (cls === 'filament') { w = 110 + Math.floor(r() * 200); h = 46 + Math.floor(r() * 110); }
    else if (cls === 'colony') { w = 70 + Math.floor(r() * 120); h = Math.max(60, w - 20 + Math.floor(r() * 40)); }
    else if (cls === 'diatom') { w = 64 + Math.floor(r() * 110); h = 28 + Math.floor(r() * 44); }
    else if (cls === 'other') { w = 54 + Math.floor(r() * 90); h = 54 + Math.floor(r() * 80); }
    else if (cls === 'debris') { w = 28 + Math.floor(r() * 130); h = 28 + Math.floor(r() * 110); }
    else { w = 44 + Math.floor(r() * 80); h = 40 + Math.floor(r() * 70); }
    var truth = { filament: 'cyanobacteria', colony: 'cyanobacteria', diatom: 'diatom', other: 'other_organism', debris: 'debris', blank: 'blank' }[cls];
    return (specCache[relPath] = { cls: cls, truth: truth, w: w, h: h, seed: seed });
  }

  function svgFor(spec) {
    var r = rng(spec.seed ^ 0x9e3779b9), w = spec.w, h = spec.h, s = [];
    var pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    var f = function (n) { return n.toFixed(1); };
    var bg = pick(['#dad8d0', '#dddbd3', '#d4d3cc', '#e1dfd7']);
    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
    s.push('<defs><radialGradient id="v" cx=".5" cy=".5" r=".78"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></radialGradient>'
      + '<filter id="b" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="' + (Math.min(w, h) / 150).toFixed(2) + '"/></filter></defs>');
    s.push('<rect width="' + w + '" height="' + h + '" fill="' + bg + '"/>');
    for (var i = 0; i < 7; i++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(0.6 + r() * 1.6) + '" fill="#8d8b82" opacity=".16"/>');
    s.push('<g filter="url(#b)">');

    var cx = w / 2, cy = h / 2, k;
    if (spec.cls === 'filament') {
      var n = 10 + Math.floor(r() * 10), amp = h * (0.12 + r() * 0.18), freq = 0.8 + r() * 1.5, ph = r() * 6.28, cr = Math.max(2.4, h * (0.07 + r() * 0.03)), pts = [];
      var col = pick(['#4d8c5a', '#3f7d63', '#5a9a4e']);
      for (k = 0; k < n; k++) {
        var t = k / (n - 1);
        pts.push([w * (0.07 + t * 0.86), cy + (r() - 0.5) * 2 + Math.sin(t * freq * 6.283 + ph) * amp]);
      }
      s.push('<polyline fill="none" stroke="' + col + '" stroke-width="' + f(cr * 1.5) + '" stroke-linecap="round" stroke-linejoin="round" opacity=".85" points="' + pts.map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' ') + '"/>');
      pts.forEach(function (p) {
        s.push('<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(cr) + '" fill="' + col + '" stroke="#2f5d3b" stroke-width=".6"/>');
        s.push('<circle cx="' + f(p[0] - cr * 0.25) + '" cy="' + f(p[1] - cr * 0.25) + '" r="' + f(cr * 0.38) + '" fill="#bfe3b3" opacity=".6"/>');
      });
    } else if (spec.cls === 'colony') {
      var R = Math.min(w, h) * (0.3 + r() * 0.1), cnt = 18 + Math.floor(r() * 24);
      s.push('<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(R * 1.18) + '" fill="#6fa56b" opacity=".16"/>');
      for (k = 0; k < cnt; k++) {
        var ang = r() * 6.283, d = Math.sqrt(r()) * R, rr = Math.max(2, R * (0.1 + r() * 0.08));
        s.push('<circle cx="' + f(cx + Math.cos(ang) * d) + '" cy="' + f(cy + Math.sin(ang) * d) + '" r="' + f(rr) + '" fill="#6ba66a" stroke="#3d6f47" stroke-width=".6" opacity=".92"/>');
      }
    } else if (spec.cls === 'diatom') {
      var a = w * 0.36, b = h * 0.2, rot = (r() - 0.5) * 36;
      s.push('<g transform="rotate(' + f(rot) + ' ' + f(cx) + ' ' + f(cy) + ')">');
      s.push('<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(a) + '" ry="' + f(b) + '" fill="#d4b062" stroke="#8c6a26" stroke-width="1.4"/>');
      s.push('<line x1="' + f(cx - a * 0.9) + '" y1="' + f(cy) + '" x2="' + f(cx + a * 0.9) + '" y2="' + f(cy) + '" stroke="#8c6a26" stroke-width="1"/>');
      for (k = -5; k <= 5; k++) s.push('<line x1="' + f(cx + k * a * 0.16) + '" y1="' + f(cy - b * 0.82) + '" x2="' + f(cx + k * a * 0.16) + '" y2="' + f(cy + b * 0.82) + '" stroke="#8c6a26" stroke-width=".7" opacity=".7"/>');
      s.push('</g>');
    } else if (spec.cls === 'other') {
      var m = 7 + Math.floor(r() * 6), RR = Math.min(w, h) * 0.3;
      for (k = 0; k < m; k++) {
        var an = (k / m) * 6.283;
        s.push('<ellipse cx="' + f(cx + Math.cos(an) * RR) + '" cy="' + f(cy + Math.sin(an) * RR) + '" rx="' + f(RR * 0.42) + '" ry="' + f(RR * 0.26) + '" transform="rotate(' + f(an * 57.3) + ' ' + f(cx + Math.cos(an) * RR) + ' ' + f(cy + Math.sin(an) * RR) + ')" fill="#86b25e" stroke="#4f7a36" stroke-width=".8"/>');
      }
      s.push('<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(RR * 0.45) + '" fill="#a6c97f" stroke="#4f7a36" stroke-width=".8"/>');
    } else if (spec.cls === 'debris') {
      var v = 7 + Math.floor(r() * 6), pts2 = [], base = Math.min(w, h) * (0.26 + r() * 0.14), tone = pick(['#6a5948', '#5a626b', '#7a6a55']);
      for (k = 0; k < v; k++) {
        var a2 = (k / v) * 6.283, rr2 = base * (0.55 + r() * 0.75);
        pts2.push(f(cx + Math.cos(a2) * rr2 * 1.2) + ',' + f(cy + Math.sin(a2) * rr2));
      }
      s.push('<polygon points="' + pts2.join(' ') + '" fill="' + tone + '" stroke="#3a3a3a" stroke-width="1" opacity=".92"/>');
      for (k = 0; k < 3; k++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(1 + r() * 2.5) + '" fill="' + tone + '" opacity=".7"/>');
    } else {
      for (k = 0; k < 4; k++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(1 + r() * 2) + '" fill="#9a988e" opacity=".28"/>');
      s.push('<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(w * 0.3) + '" ry="' + f(h * 0.16) + '" fill="#bdbbb0" opacity=".25"/>');
    }
    s.push('</g><rect width="100%" height="100%" fill="url(#v)"/></svg>');
    return s.join('');
  }

  var urlCache = {};
  function imageUrl(relPath) {
    if (!urlCache[relPath]) urlCache[relPath] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(specimen(relPath)));
    return urlCache[relPath];
  }

  // --- folders, images, people ---------------------------------------------------------

  // Made-up labelers; the admin page lists them alongside your real account.
  var USERS = [
    { id: 'demo-labeler-2', email: 'avery.lin@example.com', full_name: 'Avery Lin', provider: 'google', role: 'labeler', created_at: '2026-09-04T16:45:00Z', last_sign_in_at: '2026-10-02T21:08:00Z' },
    { id: 'demo-labeler-3', email: 'sam.okafor@example.com', full_name: 'Sam Okafor', provider: 'email', role: 'labeler', created_at: '2026-09-06T12:20:00Z', last_sign_in_at: '2026-10-01T18:40:00Z' },
    { id: 'demo-viewer-2', email: 'riley.chen@example.com', full_name: 'Riley Chen', provider: 'google', role: 'viewer', created_at: '2026-09-25T08:05:00Z', last_sign_in_at: '2026-09-30T13:12:00Z' },
  ];

  var folders = FOLDER_DATA.map(function (d) {
    return {
      folder_name: d[0], site_raw: d[1], site_normalized: d[1], water_body_type: d[2], date: d[3], sample_date: d[4],
      magnification: d[5], sample_code: d[6], capture_mode: d[7], dilution: d[8], is_pp: d[9], pp_of_folder: null,
      image_count: d[10], unreadable_count: 0, min_width: d[11], max_width: d[12], min_height: d[13], max_height: d[14],
    };
  });

  var stored = {};
  try { stored = JSON.parse(session(DATA) || '{}'); } catch (e) { stored = {}; }
  stored.labels = stored.labels || {};   // image_id -> [label, by, iso date]
  stored.roles = stored.roles || {};     // user id -> role
  function persist() { session(DATA, JSON.stringify(stored)); }
  USERS.forEach(function (u) { if (stored.roles[u.id]) u.role = stored.roles[u.id]; });

  var images = [];
  folders.forEach(function (f, fi) {
    var fraction = fi % 7 === 0 ? 1 : fi % 3 === 0 ? 0.55 : fi % 5 === 1 ? 0.2 : 0;
    var slug = f.site_normalized.replace(/\s+/g, '_');
    for (var i = 0; i < f.image_count; i++) {
      var filename = slug + '_' + f.date.replace(/\./g, '-') + '_' + ('00000' + (i + 1)).slice(-5) + '.png';
      var rel = f.folder_name + '/' + filename;
      var spec = specimen(rel);
      var r = rng(hashStr(rel + 'label'));
      var row = {
        image_id: hex16(rel), folder_name: f.folder_name, filename: filename, relative_path: rel,
        width: spec.w, height: spec.h, file_size_bytes: Math.round(spec.w * spec.h * 1.1 + 900), format: 'PNG', mode: 'RGB',
        is_readable: true, source_dataset: 'demo', label: null, labeled_by: null, labeled_date: null,
      };
      if (r() < fraction) {
        var wrong = r() < 0.1;
        row.label = wrong ? ['diatom', 'debris', 'other_organism', 'unsure'][Math.floor(r() * 4)] : spec.truth;
        row.labeled_by = r() < 0.6 ? 'demo-labeler-2' : 'demo-labeler-3';
        row.labeled_date = new Date(Date.now() - Math.floor(r() * 12 * 86400000) - 3600000).toISOString();
      }
      var s = stored.labels[row.image_id];
      if (s) { row.label = s[0]; row.labeled_by = s[1]; row.labeled_date = s[2]; }
      images.push(row);
    }
  });

  // Make the folders' own size ranges agree with their generated images.
  folders.forEach(function (f) {
    var mine = images.filter(function (x) { return x.folder_name === f.folder_name; });
    f.min_width = Math.min.apply(null, mine.map(function (x) { return x.width; }));
    f.max_width = Math.max.apply(null, mine.map(function (x) { return x.width; }));
    f.min_height = Math.min.apply(null, mine.map(function (x) { return x.height; }));
    f.max_height = Math.max.apply(null, mine.map(function (x) { return x.height; }));
  });

  // ---------------------------------------------------------------------------
  // Views the real database computes
  // ---------------------------------------------------------------------------

  function groupSum(rows, keyFn, valFn) {
    var m = {};
    rows.forEach(function (r) { var k = keyFn(r); m[k] = (m[k] || 0) + valFn(r); });
    return m;
  }

  var views = {
    folders_visible: function () { return folders; },
    qa_log: function () {
      return [
        { id: 1, level: 'INFO', target: 'catalog', detail: 'Demo data: 45 folders sampled from the real catalog.' },
        { id: 2, level: 'WARN', target: 'Bell_CR9.12.22_10xTR1 1', detail: 'Raw folder kept: no -pp counterpart found.' },
        { id: 3, level: 'INFO', target: 'sites', detail: 'Site names merged: 6 spelling variants folded into their parent sites.' },
      ];
    },
    dashboard_stats: function () {
      var dates = folders.map(function (f) { return f.sample_date; }).sort();
      return [{
        total_folders: folders.length,
        total_images: folders.reduce(function (s, f) { return s + f.image_count; }, 0),
        unique_sites: new Set(folders.map(function (f) { return f.site_normalized; })).size,
        first_date: dates[0], last_date: dates[dates.length - 1],
        pp_folders: folders.filter(function (f) { return f.is_pp; }).length,
        raw_folders: folders.filter(function (f) { return !f.is_pp; }).length,
      }];
    },
    chart_site_counts: function () {
      var m = groupSum(folders, function (f) { return f.site_normalized; }, function (f) { return f.image_count; });
      return Object.keys(m).map(function (k) { return { site_normalized: k, image_count: m[k], folder_count: 1 }; })
        .sort(function (a, b) { return b.image_count - a.image_count || a.site_normalized.localeCompare(b.site_normalized); });
    },
    chart_date_counts: function () {
      var m = groupSum(folders, function (f) { return f.sample_date.slice(0, 7) + '-01'; }, function (f) { return f.image_count; });
      return Object.keys(m).sort().map(function (k) { return { month: k, image_count: m[k], folder_count: 1 }; });
    },
    chart_water_body_counts: function () {
      var m = groupSum(folders, function (f) { return f.water_body_type || 'Unknown'; }, function () { return 1; });
      return Object.keys(m).map(function (k) { return { water_body_type: k, folder_count: m[k], image_count: 0 }; })
        .sort(function (a, b) { return b.folder_count - a.folder_count || a.water_body_type.localeCompare(b.water_body_type); });
    },
    labeling_stats: function () {
      var labeled = images.filter(function (x) { return x.label; });
      var who = new Set(labeled.map(function (x) { return x.labeled_by; }));
      var dates = labeled.map(function (x) { return x.labeled_date; }).sort();
      return [{
        total_images: images.length, labeled_images: labeled.length, unlabeled_images: images.length - labeled.length,
        pct_labeled: images.length ? Math.round(1000 * labeled.length / images.length) / 10 : 0,
        labeler_count: who.size, last_labeled_at: dates.length ? dates[dates.length - 1] : null,
      }];
    },
    label_counts: function () {
      var m = groupSum(images.filter(function (x) { return x.label; }), function (x) { return x.label; }, function () { return 1; });
      return Object.keys(m).map(function (k) { return { label: k, image_count: m[k] }; })
        .sort(function (a, b) { return b.image_count - a.image_count || a.label.localeCompare(b.label); });
    },
    folder_labeling_progress: function () {
      var m = groupSum(images.filter(function (x) { return x.label; }), function (x) { return x.folder_name; }, function () { return 1; });
      return folders.map(function (f) {
        var l = m[f.folder_name] || 0;
        return {
          folder_name: f.folder_name, site_normalized: f.site_normalized, image_count: f.image_count, labeled_count: l,
          unlabeled_count: f.image_count - l, pct_labeled: f.image_count ? Math.round(1000 * l / f.image_count) / 10 : 0,
        };
      }).sort(function (a, b) { return a.folder_name.localeCompare(b.folder_name); });
    },
    images: function () { return images; },
    profiles: function () { return []; },  // only used when the real client is missing (no one is signed in then)
  };

  // ---------------------------------------------------------------------------
  // Who is acting: your real account (auth.js), or a guest when signed out
  // ---------------------------------------------------------------------------

  var GUEST = { id: 'demo-guest', email: null };

  function signedIn() {
    var a = window.Auth && window.Auth.current();
    return a && a.user ? a : null;
  }
  function actor() { var a = signedIn(); return a ? a.user : GUEST; }
  function realRole() { var a = signedIn(); return a ? ((a.profile && a.profile.role) || 'viewer') : null; }

  // The sample people, plus your real account at the top when you're signed in.
  function people() {
    var a = signedIn();
    if (!a) return USERS.slice();
    var meta = a.user.app_metadata || {};
    var now = new Date().toISOString();
    return [{
      id: a.user.id, email: a.user.email, full_name: (a.profile && a.profile.full_name) || null,
      provider: (meta.providers || [meta.provider || 'email']).join(','), role: realRole(),
      created_at: a.user.created_at || now, last_sign_in_at: a.user.last_sign_in_at || now,
    }].concat(USERS);
  }

  // ---------------------------------------------------------------------------
  // The query builder (the subset of supabase-js the pages use)
  // ---------------------------------------------------------------------------

  var failRate = parseFloat(params.get('fail') || '0') || 0;
  function delay() { return new Promise(function (res) { setTimeout(res, 70 + Math.random() * 110); }); }
  function err(message, code) { return { data: null, error: { message: message, code: code || 'DEMO', hint: null }, count: null }; }

  function Query(table, kind, args) {
    this.table = table; this.kind = kind || 'table'; this.args = args || {};
    this.filters = []; this.orders = []; this.window = null; this.cols = '*'; this.wantCount = false;
    this.mode = 'select'; this.patch = null; this.single_ = false; this.maybe_ = false;
  }
  var P = Query.prototype;
  P.select = function (cols, opts) { this.cols = cols || '*'; if (opts && opts.count === 'exact') this.wantCount = true; return this; };
  P.eq = function (c, v) { this.filters.push(function (r) { return r[c] === v; }); return this; };
  P.in = function (c, arr) { var set = new Set(arr); this.filters.push(function (r) { return set.has(r[c]); }); return this; };
  P.not = function (c, op, v) { if (op === 'is' && v === null) this.filters.push(function (r) { return r[c] != null; }); return this; };
  P.is = function (c, v) { if (v === null) this.filters.push(function (r) { return r[c] == null; }); return this; };
  P.order = function (c, o) { this.orders.push([c, !o || o.ascending !== false]); return this; };
  P.range = function (a, b) { this.window = [a, b]; return this; };
  P.limit = function (n) { this.window = [0, n - 1]; return this; };
  P.single = function () { this.single_ = true; return this; };
  P.maybeSingle = function () { this.maybe_ = true; return this; };
  P.update = function (values) { this.mode = 'update'; this.patch = values; return this; };
  P.then = function (resolve, reject) { return this.run().then(resolve, reject); };

  P.run = function () {
    var q = this;
    return delay().then(function () {
      if (q.kind === 'rpc') return q.runRpc();
      if (!views[q.table]) return err("Could not find the table 'public." + q.table + "' in the schema cache", 'PGRST205');
      if (q.mode === 'update') return q.runUpdate();

      var rows = views[q.table]().filter(function (r) { return q.filters.every(function (f) { return f(r); }); });
      return q.shape(rows);
    });
  };

  P.shape = function (rows) {
    var q = this;
    q.orders.slice().reverse().forEach(function (o) {
      rows = rows.slice().sort(function (a, b) {
        var x = a[o[0]], y = b[o[0]];
        if (x == null) x = ''; if (y == null) y = '';
        var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return o[1] ? c : -c;
      });
    });
    var count = rows.length;
    if (q.window) rows = rows.slice(q.window[0], q.window[1] + 1);
    if (q.cols && q.cols !== '*') {
      var keys = q.cols.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      rows = rows.map(function (r) { var o = {}; keys.forEach(function (k) { o[k] = r[k]; }); return o; });
    } else {
      rows = rows.map(function (r) { return Object.assign({}, r); });
    }
    if (q.single_ || q.maybe_) {
      if (rows.length === 1) return { data: rows[0], error: null, count: count };
      if (q.maybe_ && rows.length === 0) return { data: null, error: null, count: 0 };
      return err('JSON object requested, multiple (or no) rows returned', 'PGRST116');
    }
    return { data: rows, error: null, count: q.wantCount ? count : null };
  };

  P.runUpdate = function () {
    var q = this;
    if (q.table !== 'images') return err('Updates are not supported on ' + q.table);
    if (failRate && Math.random() < failRate) return err('Simulated network failure (demo ?fail=' + failRate + ')', 'DEMO_FAIL');
    var keys = Object.keys(q.patch);
    if (keys.some(function (k) { return k !== 'label'; })) return err('permission denied for table images', '42501');
    var me = actor(), now = new Date().toISOString();
    images.filter(function (r) { return q.filters.every(function (f) { return f(r); }); }).forEach(function (r) {
      var value = q.patch.label == null ? null : q.patch.label;
      if (value === r.label) return;
      r.label = value;
      r.labeled_by = value ? me.id : null;
      r.labeled_date = value ? now : null;
      if (value) stored.labels[r.image_id] = [value, me.id, now];
      else stored.labels[r.image_id] = [null, null, null];
    });
    persist();
    return { data: null, error: null, count: null };
  };

  P.runRpc = function () {
    var name = this.table, a = this.args, me = actor(), admin = realRole() === 'admin';
    var rows;
    if (name === 'my_labeling_count') {
      return { data: images.filter(function (x) { return x.labeled_by === me.id; }).length, error: null };
    }
    if (name === 'can_label') return { data: true, error: null };
    if (name === 'is_admin') return { data: admin, error: null };
    if (name === 'admin_list_users') {
      if (!admin) return err('Not authorized', '42501');
      rows = people().map(function (u) { return Object.assign({ avatar_url: null }, u); });
    } else if (name === 'admin_labeling_by_user') {
      if (!admin) return err('Not authorized', '42501');
      var guest = { id: GUEST.id, email: null, full_name: 'Guest (not signed in)', role: 'viewer' };
      rows = people().concat([guest]).map(function (u) {
        var mine = images.filter(function (x) { return x.labeled_by === u.id; });
        var dates = mine.map(function (x) { return x.labeled_date; }).sort();
        return { id: u.id, email: u.email, full_name: u.full_name, role: u.role, labeled_count: mine.length, last_labeled_at: dates.length ? dates[dates.length - 1] : null };
      }).sort(function (x, y) { return y.labeled_count - x.labeled_count; });
    } else if (name === 'set_user_role') {
      if (!admin) return err('Only admins can change roles', '42501');
      if (a.target === me.id) return err("Demo mode can't change your real account's role", 'DEMO');
      var target = USERS.filter(function (u) { return u.id === a.target; })[0];
      if (!target) return err('No user with id ' + a.target, 'P0002');
      target.role = a.new_role;
      stored.roles[target.id] = a.new_role;
      persist();
      return { data: null, error: null };
    } else {
      return err('Could not find the function public.' + name, 'PGRST202');
    }
    return this.shape(rows);
  };

  // ---------------------------------------------------------------------------
  // The client auth.js talks to: made-up data, real accounts
  // ---------------------------------------------------------------------------

  // Without supabase-js (offline, or blocked) nobody can sign in, but the
  // demo data still works.
  function noSignIn() {
    return Promise.resolve({ data: null, error: { message: 'Network error: the sign-in service did not load.' } });
  }
  var offlineAuth = {
    getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    signOut: function () { return Promise.resolve({ error: null }); },
    signInWithPassword: noSignIn, signInWithOAuth: noSignIn, signUp: noSignIn,
    resetPasswordForEmail: noSignIn, updateUser: noSignIn,
  };

  window.supabase = {
    createClient: function (url, key) {
      var real = null;
      try { real = realLib ? realLib.createClient(url, key) : null; } catch (e) { real = null; }
      return {
        // Your profile (and so your role) is read from the real database.
        from: function (t) { return t === 'profiles' && real ? real.from(t) : new Query(t); },
        rpc: function (name, args) { return new Query(name, 'rpc', args); },
        auth: real ? real.auth : offlineAuth,
      };
    },
  };

  window.Demo = {
    imageUrl: imageUrl,
    guest: GUEST,  // who labels when no one is signed in
    truth: function (relPath) { return specimen(relPath).truth; },
    reset: function () { session(DATA, null); location.reload(); },
    exit: function () { session(FLAG, null); session(DATA, null); },
  };

  // ---------------------------------------------------------------------------
  // The little pill that says "this is a demo"
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var pill = document.createElement('div');
    pill.className = 'demo-pill';
    pill.setAttribute('role', 'region');
    pill.setAttribute('aria-label', 'Demo mode');
    pill.innerHTML = '<span>Demo mode · sample data, nothing is saved</span>'
      + '<a href="#" id="demo-reset">Reset</a><a href="?demo=0" id="demo-exit">Exit</a>';
    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) document.body.insertBefore(pill, document.body.firstChild);
    else document.body.appendChild(pill);
    pill.querySelector('#demo-reset').addEventListener('click', function (e) { e.preventDefault(); window.Demo.reset(); });
  });
})();
