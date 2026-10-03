Self-hosted web fonts (Latin subset, WOFF2), served from this folder so pages
never contact a third-party font service.

  fraunces-opsz-normal.woff2, fraunces-opsz-italic.woff2
      Fraunces (variable: weight + optical size), by Undercase Type.
      SIL Open Font License 1.1.  https://fonts.google.com/specimen/Fraunces

  caladea-400.woff2, caladea-400-italic.woff2, caladea-700.woff2
      Caladea, a metric-compatible, freely licensed stand-in for Cambria,
      by Carlito/Huerta Tipografica. SIL Open Font License 1.1.
      https://fontsource.org/fonts/caladea

Packaged by Fontsource (@fontsource-variable/fraunces, @fontsource/caladea).
The stylesheet lists Cambria first, so machines that have it use the real
thing and everyone else gets Caladea, which looks near-identical.
