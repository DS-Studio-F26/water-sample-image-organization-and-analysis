/**
 * The label taxonomy -- the one place to edit when the team (and Prof. Ahlgren)
 * settle on the final categories.
 *
 *   value   what is stored in images.label (keep it lowercase, no spaces)
 *   text    what people see
 *   key     the number key that applies the label in the labeling page
 *   glyph   a shape from icons.svg, so a label is never told apart by colour alone
 *
 * Colours live in base.css as [data-label="<value>"] rules. A value with no
 * rule there still works; it just shows in neutral grey. The six below are a
 * placeholder set.
 */
(function () {
  var OPTIONS = [
    { value: 'cyanobacteria', text: 'Cyanobacteria', key: '1', glyph: 'g-wave' },
    { value: 'diatom', text: 'Diatom', key: '2', glyph: 'g-diamond' },
    { value: 'other_organism', text: 'Other organism', key: '3', glyph: 'g-hex' },
    { value: 'debris', text: 'Debris', key: '4', glyph: 'g-triangle' },
    { value: 'blank', text: 'Blank / empty', key: '5', glyph: 'g-ring' },
    { value: 'unsure', text: 'Unsure', key: '6', glyph: 'g-question' },
  ];

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function pretty(value) {
    var s = String(value).replace(/[_-]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function get(value) {
    for (var i = 0; i < OPTIONS.length; i++) if (OPTIONS[i].value === value) return OPTIONS[i];
    return { value: value, text: pretty(value), key: '', glyph: 'g-dot' };
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

  // A coloured pill: [glyph] Label. Pass no value for the "Unlabeled" placeholder.
  function chip(value) {
    var span = document.createElement('span');
    if (!value) {
      span.className = 'label-chip is-none';
      span.textContent = 'Unlabeled';
      return span;
    }
    var opt = get(value);
    span.className = 'label-chip';
    span.setAttribute('data-label', opt.value);
    span.appendChild(glyph(opt.glyph));
    span.appendChild(document.createTextNode(opt.text));
    return span;
  }

  window.Labels = {
    options: OPTIONS,
    get: get,
    text: function (value) { return value ? get(value).text : 'Unlabeled'; },
    byKey: function (key) {
      for (var i = 0; i < OPTIONS.length; i++) if (OPTIONS[i].key === key) return OPTIONS[i];
      return null;
    },
    glyph: glyph,
    chip: chip,
  };
})();
