/**
 * Labels: the shared label list, and the type-ahead box used to apply them.
 *
 * The list lives in the database (label_options, supabase/migrations/
 * 005_label_options.sql), so a label one labeler adds shows up for everyone.
 * images.label stores the label's name exactly as shown ("Microcystis Debris").
 * Every label belongs to one category; colour and shape come from the category,
 * so a label is never told apart by colour alone.
 *
 *   Labels.ready                  resolves once the list is loaded
 *   Labels.options                every label: { value, text, category }
 *   Labels.get(value)             one label (an unknown value gets no category)
 *   Labels.category(value)        its category: { key, text, glyph }
 *   Labels.search(query)          labels whose name contains the query, best first
 *   Labels.create(name, category) add a label (labelers and admins)
 *   Labels.onChange(fn)           called whenever the list changes
 *   Labels.paint(el, value)       set data-label / data-cat, for the colours
 *   Labels.chip(value)            a coloured pill: [shape] Name
 *   Labels.picker(opts)           the type-ahead box (see picker() below)
 *
 * Colours live in base.css as [data-cat="<category>"] rules.
 */
(function () {
  var CATEGORIES = [
    { key: 'cyanobacteria', text: 'Cyanobacteria', glyph: 'g-wave' },
    { key: 'other_significant', text: 'Other significant', glyph: 'g-diamond' },
    { key: 'non_organism', text: 'Non-organism / Unsure', glyph: 'g-ring' },
  ];
  var UNKNOWN = { key: '', text: 'Not on the label list', glyph: 'g-dot' };

  // Used until the database answers, and in place of it if 005 isn't applied yet.
  var STARTING = [
    ['Aphanizomenon', 'cyanobacteria'], ['Dolichospermum', 'cyanobacteria'], ['Microcystis', 'cyanobacteria'],
    ['Oscillatoria', 'cyanobacteria'], ['Woronichinia', 'cyanobacteria'], ['Microcystis Debris', 'cyanobacteria'],
    ['Staurastrum', 'other_significant'], ['Fragilaria', 'other_significant'], ['Dinobryon', 'other_significant'],
    ['Centric Diatom', 'other_significant'],
    ['Blank / empty', 'non_organism'], ['Unsure', 'non_organism'],
  ];

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var options = [];
  var byValue = new Map();
  var listeners = [];
  var loaded = false;

  function catOf(key) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].key === key) return CATEGORIES[i];
    return UNKNOWN;
  }

  function makeOption(row, i) {
    return { value: row.name, text: row.name, category: row.category, builtin: !!row.is_builtin, created_at: row.created_at || null, order: i };
  }

  // Category order, then the starting labels in their agreed order, then added ones A-Z.
  function sortOptions(list) {
    var catIndex = function (k) { var c = CATEGORIES.map(function (x) { return x.key; }).indexOf(k); return c < 0 ? 99 : c; };
    return list.sort(function (a, b) {
      return catIndex(a.category) - catIndex(b.category)
        || (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1)
        || (a.builtin ? a.order - b.order : a.text.localeCompare(b.text));
    });
  }

  function setOptions(rows) {
    options = sortOptions(rows.map(makeOption));
    byValue = new Map(options.map(function (o) { return [o.value, o]; }));
    if (window.Labels) window.Labels.options = options;
    repaintPending();
    listeners.slice().forEach(function (fn) { try { fn(options); } catch (e) { console.error(e); } });
  }

  setOptions(STARTING.map(function (s) { return { name: s[0], category: s[1], is_builtin: true }; }));

  function isMissingSchema(err) {
    var text = ((err && err.code) || '') + ' ' + ((err && err.message) || '');
    return /PGRST205|42P01|schema cache|does not exist/i.test(text);
  }

  function load() {
    if (!window.sb) return Promise.resolve(options);
    return window.sb.from('label_options').select('name, category, is_builtin, created_at').order('name')
      .then(function (res) {
        if (res.error) {
          // Before 005 is applied: keep the starting list so the pages still work.
          window.Labels.missing = isMissingSchema(res.error);
          if (!window.Labels.missing) console.error('Could not load the label list:', res.error);
          loaded = true;
          repaintPending();
          return options;
        }
        window.Labels.missing = false;
        // Keep the starting labels' agreed order: the database returns A-Z.
        var rank = new Map(STARTING.map(function (s, i) { return [s[0], i]; }));
        var rows = res.data.slice().sort(function (a, b) {
          var x = rank.has(a.name) ? rank.get(a.name) : 999, y = rank.has(b.name) ? rank.get(b.name) : 999;
          return x - y;
        });
        setOptions(rows);
        loaded = true;
        return options;
      }, function (err) { console.error('Could not load the label list:', err); return options; });
  }

  function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' '); }

  // Resolves with the new label. An exact duplicate (someone added it a moment
  // ago) resolves with the existing one instead of failing.
  function create(name, category) {
    var clean = cleanName(name);
    if (!clean) return Promise.reject(new Error('Give the label a name.'));
    if (clean.length > 60) return Promise.reject(new Error('Keep the name to 60 characters or fewer.'));
    if (!catOf(category).key) return Promise.reject(new Error('Choose a category.'));
    if (byValue.has(clean)) return Promise.resolve(byValue.get(clean));
    if (!window.sb) return Promise.reject(new Error('Can’t reach the database.'));
    if (window.Labels.missing) return Promise.reject(new Error('New labels need the database update supabase/migrations/005_label_options.sql. Ask whoever holds the database password to run deploy/apply_migrations.py.'));
    return window.sb.from('label_options').insert({ name: clean, category: category }).select('name, category, is_builtin, created_at').single()
      .then(function (res) {
        if (res.error) {
          if (res.error.code === '23505') return load().then(function () { return byValue.get(clean); });
          if (res.error.code === '42501' || /row-level security/i.test(res.error.message || '')) throw new Error('Your account can’t add labels. Ask an admin for the labeler role.');
          throw new Error(res.error.message || 'Couldn’t add the label.');
        }
        var rows = options.map(function (o) { return { name: o.value, category: o.category, is_builtin: o.builtin, created_at: o.created_at }; });
        rows.push(res.data);
        setOptions(rows);
        return byValue.get(res.data.name);
      });
  }

  function get(value) {
    return byValue.get(value) || { value: value, text: String(value), category: '', builtin: false, unknown: true };
  }

  // Name contains the query (any case); names that start with it come first.
  function search(query) {
    var q = cleanName(query).toLowerCase();
    if (!q) return options.slice();
    return options
      .map(function (o) { return { o: o, at: o.text.toLowerCase().indexOf(q) }; })
      .filter(function (r) { return r.at >= 0; })
      .sort(function (a, b) { return (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.o.text.localeCompare(b.o.text); })
      .map(function (r) { return r.o; });
  }

  // Elements painted before the list arrived get their category once it does.
  function paint(el, value) {
    if (!value) { el.removeAttribute('data-label'); el.removeAttribute('data-cat'); el.removeAttribute('data-cat-pending'); return el; }
    el.setAttribute('data-label', value);
    var cat = get(value).category;
    if (cat) el.setAttribute('data-cat', cat); else el.removeAttribute('data-cat');
    if (!loaded) el.setAttribute('data-cat-pending', '');
    return el;
  }
  function repaintPending() {
    if (typeof document === 'undefined') return;
    var els = document.querySelectorAll('[data-cat-pending]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      paint(el, el.getAttribute('data-label'));
      if (loaded) el.removeAttribute('data-cat-pending');
      if (el.classList.contains('label-chip')) {
        var g = el.querySelector('.glyph use');
        if (g) g.setAttribute('href', 'icons.svg#' + catOf(get(el.getAttribute('data-label')).category).glyph);
      }
    }
  }

  function glyph(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', 'icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  // A coloured pill: [shape] Label. Pass no value for the "Unlabeled" placeholder.
  function chip(value) {
    var span = document.createElement('span');
    if (!value) {
      span.className = 'label-chip is-none';
      span.textContent = 'Unlabeled';
      return span;
    }
    span.className = 'label-chip';
    paint(span, value);
    span.title = get(value).text + ' · ' + catOf(get(value).category).text;
    span.appendChild(glyph(catOf(get(value).category).glyph));
    span.appendChild(document.createTextNode(get(value).text));
    return span;
  }

  // ---------------------------------------------------------------------------
  // The type-ahead box
  // ---------------------------------------------------------------------------
  //
  // opts:
  //   onPick(option)      a label was chosen (from the list, or just created)
  //   current()           the value to mark as current, or null
  //   canCreate           show "Enter new label" (default true)
  //   onEscape()          Esc with an empty box
  //   placeholder, label  input placeholder and accessible name
  //
  // Returns { el, input, focus(), reset(), refresh(), destroy() }.
  // Keys in the box: ↑ ↓ move, Enter applies, Esc clears (then calls onEscape).

  var pickerSeq = 0;

  function picker(opts) {
    opts = opts || {};
    var id = 'lp' + (++pickerSeq);
    var canCreate = opts.canCreate !== false;
    var query = '';
    var active = 0;
    var mode = 'list';
    var shown = [];

    var input = el('input', {
      type: 'text', id: id + '-input', class: 'lp-input', autocomplete: 'off', spellcheck: 'false',
      placeholder: opts.placeholder || 'Type a label, e.g. Microcystis',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': id + '-list',
      'aria-label': opts.label || 'Label',
    });
    var field = el('div', { class: 'lp-field' }, [iconEl('search'), input, el('kbd', { text: '/' })]);
    var list = el('ul', { class: 'lp-list', id: id + '-list', role: 'listbox', 'aria-label': 'Labels' });
    var body = el('div', { class: 'lp-body' }, [list]);
    var root = el('div', { class: 'label-picker' + (opts.className ? ' ' + opts.className : '') }, [field, body]);

    function items() { return list.querySelectorAll('.lp-item'); }

    function setActive(i, scroll) {
      var nodes = items();
      if (!nodes.length) return;
      active = Math.max(0, Math.min(nodes.length - 1, i));
      for (var j = 0; j < nodes.length; j++) {
        nodes[j].classList.toggle('active', j === active);
        nodes[j].setAttribute('aria-selected', String(j === active));
      }
      input.setAttribute('aria-activedescendant', nodes[active].id);
      if (scroll && nodes[active].scrollIntoView) nodes[active].scrollIntoView({ block: 'nearest' });
    }

    function render() {
      if (mode !== 'list') return;
      list.innerHTML = '';
      shown = search(query);
      var cur = opts.current ? opts.current() : null;
      if (!shown.length) list.appendChild(el('li', { class: 'lp-empty', role: 'presentation', text: 'No label matches “' + cleanName(query) + '”.' }));
      shown.forEach(function (o, i) {
        var cat = catOf(o.category);
        var li = el('li', { class: 'lp-item' + (o.value === cur ? ' is-current' : ''), id: id + '-o' + i, role: 'option', 'aria-selected': 'false' }, [
          glyph(cat.glyph),
          el('span', { class: 'lp-text' }, [nameWithMatch(o.text, query), el('span', { class: 'lp-cat', text: cat.text })]),
          o.value === cur ? el('span', { class: 'lp-current', text: 'Current' }) : null,
        ]);
        paint(li, o.value);
        li.addEventListener('pointerdown', function (e) { e.preventDefault(); });
        li.addEventListener('click', function () { choose(o); });
        li.addEventListener('pointermove', function () { if (active !== i) setActive(i); });
        list.appendChild(li);
      });
      if (canCreate) {
        var typed = cleanName(query);
        var n = shown.length;
        var add = el('li', { class: 'lp-item lp-new', id: id + '-new', role: 'option', 'aria-selected': 'false' }, [
          el('span', { class: 'lp-plus', 'aria-hidden': 'true', text: '+' }),
          el('span', { class: 'lp-text' }, [
            el('span', { class: 'lp-name' }, typed ? ['Enter new label ', el('q', { text: typed })] : ['Enter new label']),
            el('span', { class: 'lp-cat', text: 'Name it and choose a category' })]),
        ]);
        add.addEventListener('pointerdown', function (e) { e.preventDefault(); });
        add.addEventListener('click', startNew);
        add.addEventListener('pointermove', function () { if (active !== n) setActive(n); });
        list.appendChild(add);
      }
      setActive(Math.min(active, items().length - 1));
    }

    function choose(option) {
      reset();
      if (opts.onPick) opts.onPick(option);
    }

    function onKey(e) {
      if (mode !== 'list') return;
      var n = items().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % n, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + n) % n, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); setActive(active + 5, true); }
      else if (e.key === 'PageUp') { e.preventDefault(); setActive(active - 5, true); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (active < shown.length) choose(shown[active]);
        else if (canCreate) startNew();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query) { query = ''; input.value = ''; active = 0; render(); }
        else if (opts.onEscape) opts.onEscape();
      }
    }

    input.addEventListener('input', function () { query = input.value; active = 0; render(); });
    input.addEventListener('keydown', onKey);

    // "Enter new label": a short form in place of the list.
    function startNew() {
      mode = 'new';
      var draft = cleanName(query);
      var nameIn = el('input', { type: 'text', id: id + '-new-name', class: 'lp-new-name', autocomplete: 'off', maxlength: '60', value: draft, placeholder: 'e.g. Anabaena' });
      var err = el('p', { class: 'lp-error', role: 'alert', hidden: true });
      var save = el('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Save and apply' });
      var chosen = null;
      var cats = el('fieldset', { class: 'lp-cats' }, [el('legend', { text: 'Category' })].concat(CATEGORIES.map(function (c) {
        var radio = el('input', { type: 'radio', name: id + '-cat', value: c.key });
        radio.addEventListener('change', function () { chosen = c.key; err.hidden = true; });
        return el('label', { class: 'lp-cat-opt', 'data-cat': c.key }, [radio, glyph(c.glyph), el('span', { text: c.text })]);
      })));
      var form = el('form', { class: 'lp-form', novalidate: true }, [
        el('p', { class: 'lp-form-title', text: 'New label' }),
        el('label', { class: 'lp-field-label', for: id + '-new-name', text: 'Label name' }), nameIn,
        cats, err,
        el('div', { class: 'lp-form-actions' }, [save, el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Cancel', onclick: cancelNew })]),
      ]);
      form.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelNew(); } });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = cleanName(nameIn.value);
        if (!name) { showErr('Give the label a name.'); nameIn.focus(); return; }
        if (!chosen) { showErr('Choose a category.'); return; }
        save.disabled = true;
        save.textContent = 'Saving…';
        create(name, chosen).then(function (option) {
          mode = 'list';
          body.innerHTML = '';
          body.appendChild(list);
          field.hidden = false;
          if (window.UI) UI.toast({ message: 'Added the label “' + option.text + '”.', kind: 'success', duration: 3000 });
          choose(option);
        }, function (e2) {
          save.disabled = false;
          save.textContent = 'Save and apply';
          showErr(e2.message || String(e2));
        });
      });
      function showErr(text) { err.textContent = text; err.hidden = false; }
      field.hidden = true;
      body.innerHTML = '';
      body.appendChild(form);
      nameIn.focus();
      nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length);
    }

    function cancelNew() {
      mode = 'list';
      body.innerHTML = '';
      body.appendChild(list);
      field.hidden = false;
      render();
      input.focus();
    }

    function reset() {
      if (mode === 'new') { mode = 'list'; body.innerHTML = ''; body.appendChild(list); field.hidden = false; }
      query = ''; input.value = ''; active = 0;
      render();
    }

    var off = onChange(function () { render(); });
    render();

    return {
      el: root,
      input: input,
      focus: function () { if (mode === 'list') input.focus(); else { var f = root.querySelector('.lp-new-name'); if (f) f.focus(); } },
      reset: reset,
      refresh: render,
      destroy: off,
    };
  }

  function nameWithMatch(text, query) {
    var span = el('span', { class: 'lp-name' });
    var q = cleanName(query).toLowerCase();
    var at = q ? text.toLowerCase().indexOf(q) : -1;
    if (at < 0) { span.textContent = text; return span; }
    span.appendChild(document.createTextNode(text.slice(0, at)));
    span.appendChild(el('mark', { text: text.slice(at, at + q.length) }));
    span.appendChild(document.createTextNode(text.slice(at + q.length)));
    return span;
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function iconEl(name) {
    if (window.UI && UI.icon) return UI.icon(name);
    return glyph('g-dot');
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
  }

  window.Labels = {
    categories: CATEGORIES,
    options: options,
    missing: false,
    get: get,
    text: function (value) { return value ? get(value).text : 'Unlabeled'; },
    category: function (value) { return catOf(get(value).category); },
    categoryOf: catOf,
    search: search,
    create: create,
    load: load,
    onChange: onChange,
    paint: paint,
    glyph: glyph,
    chip: chip,
    picker: picker,
  };
  // auth.js (loaded before this file) has already created window.sb.
  window.Labels.ready = load();
})();
