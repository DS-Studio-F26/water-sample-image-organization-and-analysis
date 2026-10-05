/**
 * Dashboard for the Water Sample Image Catalog (index.html).
 * Vanilla JS. Data comes from Supabase (window.sb, created in auth.js; see
 * supabase/migrations/) and the images from the Cloudflare Worker at
 * APP_CONFIG.IMAGE_BASE_URL. Shared helpers live in ui.js, labels.js, fx.js and
 * viewer.js.
 */

// PostgREST returns at most 1,000 rows per request, so bigger reads are paged.
const DB_PAGE_SIZE = 1000;
const FOLDER_COLUMNS = 'folder_name, site_normalized, water_body_type, date, sample_date, '
  + 'magnification, sample_code, capture_mode, dilution, is_pp, image_count, '
  + 'min_width, max_width, min_height, max_height';
// No labeled_by/labeled_date here: those columns only exist once migration 002 is applied.
const IMAGE_COLUMNS = 'image_id, filename, relative_path, width, height, file_size_bytes, format, label';
const FILTER_KEYS = ['site_normalized', 'water_body_type', 'date', 'sample_code', 'capture_mode', 'dilution', 'is_pp'];
const FILTER_NAMES = {
  site_normalized: 'Site', water_body_type: 'Water body', date: 'Date', sample_code: 'Code',
  capture_mode: 'Capture', dilution: 'Dilution', is_pp: 'Processing', search: 'Search',
};
const SORTABLE_COLUMNS = ['folder_name', 'site_normalized', 'water_body_type', 'date', 'sample_code',
  'capture_mode', 'dilution', 'is_pp', 'image_count'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const h = UI.h;

// 1. State Management
const state = {
  allData: [],       // all folder rows (folders_visible)
  filteredData: [],  // after applying filters
  sortColumn: 'folder_name',
  sortDirection: 'asc',  // 'asc' or 'desc'
  currentPage: 1,
  pageSize: 25,
  filters: {
    search: '',
    site_normalized: '',
    water_body_type: '',
    date: '',
    sample_code: '',
    capture_mode: '',
    dilution: '',
    is_pp: ''  // '', 'true', 'false'
  },
  qaData: [],
  qaExpanded: false,
  loaded: false,     // true once the catalog data has arrived
  // Unfiltered totals straight from the SQL views; with filters active the
  // same numbers are aggregated from the (already duplicate-free) folder rows.
  viewStats: null,
  viewCharts: null,
  maxCount: 1,       // largest folder in the filtered set (for the table's data bars)
  catIndex: null,    // stable colour slot per category, so a type keeps its colour under filters
  labelStats: null,  // labeling_stats row, once migration 002 is applied
  labelMap: null,    // folder_name -> folder_labeling_progress row
};

// 2. Supabase queries

async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < DB_PAGE_SIZE) return rows;
  }
}

async function fetchFolderImages(folderName) {
  const query = (options) => sb.from('images')
    .select(IMAGE_COLUMNS, options)
    .eq('folder_name', folderName)
    .order('filename');

  const first = await query({ count: 'exact' }).range(0, DB_PAGE_SIZE - 1);
  if (first.error) throw first.error;
  const total = first.count ?? first.data.length;

  // The biggest folders hold ~16K images: fetch the remaining pages 4 at a time.
  const offsets = [];
  for (let from = DB_PAGE_SIZE; from < total; from += DB_PAGE_SIZE) offsets.push(from);
  const pages = [];
  for (let i = 0; i < offsets.length; i += 4) {
    const batch = await Promise.all(offsets.slice(i, i + 4).map(async (from) => {
      const { data, error } = await query({}).range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw error;
      return data;
    }));
    pages.push(...batch);
  }
  return first.data.concat(...pages);
}

// 3. Data Loading
async function loadData() {
  showLoading(true);
  hideDataError();
  try {
    if (!window.sb) {
      throw new Error('The Supabase library did not load (blocked by the network or a browser extension?).');
    }
    const [folders, qa, stats, sites, months, waterBodies] = await Promise.all([
      fetchAllRows(() => sb.from('folders_visible').select(FOLDER_COLUMNS).order('folder_name')),
      fetchAllRows(() => sb.from('qa_log').select('level, target, detail').order('id')),
      sb.from('dashboard_stats').select('*').single(),
      fetchAllRows(() => sb.from('chart_site_counts').select('site_normalized, image_count')
        .order('image_count', { ascending: false }).order('site_normalized')),
      fetchAllRows(() => sb.from('chart_date_counts').select('month, image_count').order('month')),
      fetchAllRows(() => sb.from('chart_water_body_counts').select('water_body_type, folder_count')
        .order('folder_count', { ascending: false }).order('water_body_type')),
    ]);
    if (stats.error) throw stats.error;

    state.allData = folders;
    state.qaData = qa;
    state.viewStats = stats.data;
    state.viewCharts = {
      sites: sites.map(r => [r.site_normalized, Number(r.image_count)]),
      months: months.map(r => [r.month.slice(0, 7), Number(r.image_count)]),
      waterBodies: waterBodies.map(r => [r.water_body_type, Number(r.folder_count)]),
    };
    buildCategoryIndex();

    populateFilters();
    // Sign-in redirects briefly put tokens in the URL hash; wait until
    // supabase-js has consumed them before reading filters from the hash.
    if (window.Auth) await Auth.ready;
    loadStateFromHash(); // Restore before first render
    state.loaded = true;
    applyFilters(false); // don't update hash yet
    renderQALog();
    loadLabelProgress();  // optional extra; never blocks or breaks the page
  } catch (err) {
    console.error('Error loading data:', err);
    showDataError(err);
  } finally {
    showLoading(false);
  }
}

// Labeling progress exists only after supabase/migrations/002_labeling.sql is
// applied; until then these queries fail and the page simply omits the extras.
async function loadLabelProgress() {
  try {
    const [stats, folders] = await Promise.all([
      sb.from('labeling_stats').select('*').single(),
      fetchAllRows(() => sb.from('folder_labeling_progress')
        .select('folder_name, image_count, labeled_count, pct_labeled').order('folder_name')),
    ]);
    if (stats.error) throw stats.error;
    state.labelStats = stats.data;
    state.labelMap = new Map(folders.map(f => [f.folder_name, f]));
    document.getElementById('stat-labeled-card').hidden = false;
    document.getElementById('th-labeled').hidden = false;
    renderStats();
    renderTable();
  } catch (err) {
    state.labelStats = null;
    state.labelMap = null;
  }
}

function buildCategoryIndex() {
  const rank = (key, weighted) => {
    const tally = new Map();
    state.allData.forEach(r => {
      const k = r[key] || 'Unknown';
      tally.set(k, (tally.get(k) || 0) + (weighted ? (r.image_count || 0) : 1));
    });
    return new Map([...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i]));
  };
  state.catIndex = { water: rank('water_body_type', false), capture: rank('capture_mode', true) };
}

function colorVar(map, name) {
  const idx = map && map.has(name) ? map.get(name) : 6;
  return `var(--chart-${(idx % 8) + 1})`;
}

function showLoading(show) {
  const wrap = document.getElementById('data-table-container');
  if (wrap) wrap.setAttribute('aria-busy', show ? 'true' : 'false');
  const tbody = document.getElementById('table-body');
  if (show && tbody) {
    tbody.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const td = h('td', { colspan: String(colCount()), class: 'skel-cell' }, h('span', { class: 'skeleton', style: { width: `${55 + ((i * 17) % 40)}%` } }));
      tbody.appendChild(h('tr', { class: 'skel-row' }, td));
    }
  }
}

function colCount() {
  const labeled = document.getElementById('th-labeled');
  return labeled && !labeled.hidden ? 11 : 10;
}

function showDataError(err) {
  const banner = document.getElementById('data-error');
  if (banner) {
    banner.innerHTML = '';
    banner.append(
      UI.icon('alert'),
      h('div', { class: 'alert-body' },
        h('strong', { text: "Couldn't load the catalog data." }),
        h('p', { text: "The database didn't respond. The free Supabase project pauses after about a week without visits; "
          + 'if it is paused, the project owner can restore it from the Supabase dashboard. Otherwise, check your '
          + 'internet connection and reload the page.' }),
        h('p', { class: 'text-muted', text: `Details: ${(err && err.message) || err}` }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => window.location.reload() }, UI.icon('refresh'), 'Reload')));
    banner.hidden = false;
  }

  const tbody = document.getElementById('table-body');
  if (tbody) {
    tbody.innerHTML = '';
    tbody.appendChild(h('tr', {}, h('td', { colspan: String(colCount()), class: 'no-results', text: 'Catalog data is unavailable right now (see the message above).' })));
  }
  const count = document.getElementById('results-count');
  if (count) count.textContent = 'Catalog unavailable';
}

function hideDataError() {
  const banner = document.getElementById('data-error');
  if (banner) banner.hidden = true;
}

// sample_date arrives as 'YYYY-MM-DD'; format it as M/D/YYYY without any
// timezone conversion (new Date('2021-06-19') would be UTC midnight).
function formatIsoDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// 4. Filter Population
function populateFilters() {
  const getUnique = (key) => {
    const values = new Set();
    state.allData.forEach(row => {
      if (row[key] !== null && row[key] !== undefined && row[key] !== '') {
        values.add(row[key]);
      }
    });
    return Array.from(values);
  };

  // Dates are written M.D.YY or M.D.YYYY; order them by the parsed sample_date.
  const sortKeyForDate = {};
  state.allData.forEach(row => {
    if (row.date) sortKeyForDate[row.date] = row.sample_date || '';
  });
  const dates = getUnique('date').sort((a, b) =>
    (sortKeyForDate[a] || '9999').localeCompare(sortKeyForDate[b] || '9999') || a.localeCompare(b));

  populateDropdown('filter-site_normalized', getUnique('site_normalized').sort());
  populateDropdown('filter-water_body_type', getUnique('water_body_type').sort());
  populateDropdown('filter-date', dates);
  populateDropdown('filter-sample_code', getUnique('sample_code').sort());
  populateDropdown('filter-capture_mode', getUnique('capture_mode').sort());
  populateDropdown('filter-dilution', getUnique('dilution').sort());
}

function populateDropdown(id, values) {
  const select = document.getElementById(id);
  if (!select) return;

  // Clear existing options except the first (All)
  while (select.options.length > 1) {
    select.remove(1);
  }

  values.forEach(val => {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = val;
    select.appendChild(option);
  });
}

// 5. Filtering
function hasActiveFilters() {
  return Object.values(state.filters).some(v => v !== '');
}

function applyFilters(updateHash = true) {
  const f = state.filters;
  const searchLower = f.search.toLowerCase();

  state.filteredData = state.allData.filter(row => {
    if (searchLower && !(row.folder_name && row.folder_name.toLowerCase().includes(searchLower))) {
      return false;
    }
    if (f.site_normalized && row.site_normalized !== f.site_normalized) return false;
    if (f.water_body_type && row.water_body_type !== f.water_body_type) return false;
    if (f.date && row.date !== f.date) return false;
    if (f.sample_code && row.sample_code !== f.sample_code) return false;
    if (f.capture_mode && row.capture_mode !== f.capture_mode) return false;
    if (f.dilution && row.dilution !== f.dilution) return false;

    if (f.is_pp !== '') {
      const isPPFilter = f.is_pp === 'true';
      if (row.is_pp !== isPPFilter) return false;
    }

    return true;
  });
  state.maxCount = Math.max(1, ...state.filteredData.map(r => r.image_count || 0));

  // Reset to page 1 on new filter
  state.currentPage = 1;

  // Update UI components
  updateFilterBadge();
  renderActiveFilters();
  performSort(); // Sorts and renders table & pagination
  renderStats();
  renderCharts();

  if (updateHash) {
    saveStateToHash();
  }
}

function updateFilterBadge() {
  const activeCount = Object.keys(state.filters).filter(k => k !== 'search' && state.filters[k] !== '').length;
  const badge = document.getElementById('filter-badge');
  if (badge) {
    badge.hidden = activeCount === 0;
    badge.textContent = activeCount;
  }
  const toggle = document.getElementById('filters-toggle');
  if (toggle) toggle.classList.toggle('btn-primary', activeCount > 0);
}

function displayFilterValue(key, value) {
  if (key === 'is_pp') return value === 'true' ? 'Post-processed' : 'Raw only';
  if (key === 'search') return `“${value}”`;
  return value;
}

function clearFilter(key) {
  state.filters[key] = '';
  if (key === 'search') {
    const input = document.getElementById('search-input');
    if (input) input.value = '';
  } else {
    const select = document.getElementById(`filter-${key}`);
    if (select) select.value = '';
  }
  applyFilters();
}

function renderActiveFilters() {
  const host = document.getElementById('active-filters');
  if (!host) return;
  host.innerHTML = '';
  Object.keys(state.filters).forEach(key => {
    const value = state.filters[key];
    if (!value) return;
    host.appendChild(h('span', { class: 'filter-pill' },
      `${FILTER_NAMES[key]}: ${displayFilterValue(key, value)}`,
      h('button', { type: 'button', 'aria-label': `Remove ${FILTER_NAMES[key]} filter`, onclick: () => clearFilter(key) }, UI.icon('x'))));
  });
}

// 6. Sorting
function sortData(column) {
  if (state.sortColumn === column) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortColumn = column;
    state.sortDirection = 'asc';
  }
  state.currentPage = 1;
  saveStateToHash();
  performSort();
}

function performSort() {
  // The date column sorts by the parsed sample_date (YYYY-MM-DD sorts as text).
  const col = state.sortColumn === 'date' ? 'sample_date' : state.sortColumn;
  const dir = state.sortDirection === 'asc' ? 1 : -1;

  state.filteredData.sort((a, b) => {
    let valA = a[col];
    let valB = b[col];

    // Handle null/undefined
    if (valA == null) valA = '';
    if (valB == null) valB = '';

    if (typeof valA === 'number' && typeof valB === 'number') {
      return (valA - valB) * dir;
    }

    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();
    if (strA < strB) return -1 * dir;
    if (strA > strB) return 1 * dir;
    return 0;
  });

  updateSortHeaders();
  renderTable();
  renderPagination();
}

function updateSortHeaders() {
  document.querySelectorAll('th[data-sortable]').forEach(th => {
    if (th.dataset.col === state.sortColumn) {
      th.setAttribute('aria-sort', state.sortDirection === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

// 7. Table Rendering
function titleCase(str) {
  return String(str).replace(/\b[a-z]/g, c => c.toUpperCase());
}

function typeChip(type) {
  const name = type || 'Unknown';
  return h('span', { class: 'badge chip-dot', style: { '--dot': colorVar(state.catIndex && state.catIndex.water, name) }, text: titleCase(name) });
}

function captureChip(mode) {
  if (!mode) return document.createTextNode('-');
  const trigger = mode === 'trigger';
  return h('span', { class: `badge ${trigger ? 'badge-amber' : 'badge-sky'}` }, UI.icon(trigger ? 'zap' : 'camera'), mode);
}

function renderTable() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const start = (state.currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, state.filteredData.length);
  const images = state.filteredData.reduce((s, r) => s + (r.image_count || 0), 0);
  const count = document.getElementById('results-count');
  if (count) {
    count.innerHTML = '';
    count.append(h('strong', { text: state.filteredData.length.toLocaleString() }),
      state.filteredData.length === 1 ? ' folder' : ' folders',
      ` · ${images.toLocaleString()} images`);
  }

  if (state.filteredData.length === 0) {
    const reset = hasActiveFilters()
      ? h('div', { style: { marginTop: '0.8rem' } }, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => document.getElementById('clear-filters-btn').click() }, 'Clear all filters'))
      : null;
    tbody.appendChild(h('tr', {}, h('td', { colspan: String(colCount()), class: 'no-results' },
      UI.icon('search'), h('div', { text: 'No folders match these filters.' }), reset)));
    return;
  }

  const addCell = (tr, label, content, className) => {
    const td = h('td', { 'data-label': label, class: className || null });
    if (typeof content === 'string') td.textContent = content; else if (content) td.appendChild(content);
    tr.appendChild(td);
    return td;
  };

  for (let i = start; i < end; i++) {
    const row = state.filteredData[i];
    const tr = h('tr', { style: { '--i': String(i - start) } });

    const link = h('button', { type: 'button', class: 'row-link', title: row.folder_name || '', text: row.folder_name || '' });
    tr.addEventListener('click', () => openDetailPanel(row, link));
    addCell(tr, 'Folder', link, 'col-folder');
    addCell(tr, 'Site', row.site_normalized ? h('span', { class: 'site-name', text: row.site_normalized }) : '-');
    addCell(tr, 'Water body', typeChip(row.water_body_type));
    addCell(tr, 'Date', row.date || '-', 'nowrap');
    addCell(tr, 'Code', row.sample_code ? h('span', { class: 'code-tag', text: row.sample_code }) : '-');
    addCell(tr, 'Capture', captureChip(row.capture_mode));
    addCell(tr, 'Dilution', row.dilution || '-', 'nowrap');
    addCell(tr, 'Type', h('span', { class: `badge ${row.is_pp ? 'badge-primary' : 'badge-amber'}`, text: row.is_pp ? 'PP' : 'Raw' }));

    const pct = Math.max(2, Math.round(((row.image_count || 0) / state.maxCount) * 100));
    const countTd = addCell(tr, 'Images', null, 'num count-cell');
    countTd.append(h('i', { class: 'bar', style: { '--pct': `${pct}%` }, 'aria-hidden': 'true' }),
      h('span', { text: row.image_count != null ? row.image_count.toLocaleString() : '0' }));

    if (state.labelMap) {
      const lp = state.labelMap.get(row.folder_name);
      const done = lp ? Number(lp.pct_labeled) : 0;
      addCell(tr, 'Labeled', h('div', { class: 'mini-progress' },
        h('div', { class: `progress${done >= 100 ? ' done' : ''}` }, h('span', { style: { '--value': `${done}%` } })),
        h('small', { text: lp ? `${Number(lp.labeled_count).toLocaleString()} / ${Number(lp.image_count).toLocaleString()}` : '0' })));
    }

    // Dimensions
    let dims = '-';
    if (row.min_width && row.max_width) {
      if (row.min_width === row.max_width && row.min_height === row.max_height) {
        dims = `${row.max_width}×${row.max_height}`;
      } else {
        dims = `${row.min_width}×${row.min_height} – ${row.max_width}×${row.max_height}`;
      }
    }
    addCell(tr, 'Size range', dims, 'dim');

    tbody.appendChild(tr);
  }
}

function truncateStr(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '…';
}

// 8. Pagination
function goToPage(p) {
  state.currentPage = p;
  saveStateToHash();
  renderTable();
  renderPagination();
  const card = document.getElementById('folders-card');
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: UI.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function renderPagination() {
  const container = document.getElementById('pagination-container');
  const info = document.getElementById('pagination-info');
  if (!container || !info) return;

  const total = state.filteredData.length;
  if (total === 0) {
    info.textContent = 'Showing 0 folders';
    container.innerHTML = '';
    return;
  }

  const start = (state.currentPage - 1) * state.pageSize + 1;
  const end = Math.min(start + state.pageSize - 1, total);
  info.textContent = `Showing ${start}–${end} of ${total.toLocaleString()} folders`;

  const totalPages = Math.ceil(total / state.pageSize);
  container.innerHTML = '';

  const btn = (content, page, opts = {}) => {
    const b = h('button', { type: 'button', 'aria-label': opts.label || `Page ${page}`, 'aria-current': opts.active ? 'page' : null, class: opts.active ? 'active' : null, onclick: () => goToPage(page) }, content);
    b.disabled = !!opts.disabled;
    return b;
  };
  container.appendChild(btn([UI.icon('chevron-left'), ' Prev'], state.currentPage - 1, { label: 'Previous page', disabled: state.currentPage === 1 }));

  // Page numbers (max 7)
  let pagesToShow = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pagesToShow.push(i);
  } else {
    pagesToShow = [1];
    if (state.currentPage > 3) pagesToShow.push('...');

    let midStart = Math.max(2, state.currentPage - 1);
    let midEnd = Math.min(totalPages - 1, state.currentPage + 1);

    if (state.currentPage === 1) midEnd = 3;
    if (state.currentPage === totalPages) midStart = totalPages - 2;

    for (let i = midStart; i <= midEnd; i++) pagesToShow.push(i);

    if (state.currentPage < totalPages - 2) pagesToShow.push('...');
    pagesToShow.push(totalPages);
  }

  pagesToShow.forEach(p => {
    if (p === '...') container.appendChild(h('span', { class: 'page-ellipsis', text: '…' }));
    else container.appendChild(btn(String(p), p, { active: p === state.currentPage }));
  });

  container.appendChild(btn(['Next ', UI.icon('chevron-right')], state.currentPage + 1, { label: 'Next page', disabled: state.currentPage === totalPages }));
}

// 9. Stats Cards
function computeStats(rows) {
  const sites = new Set();
  let firstDate = null;
  let lastDate = null;
  let ppFolders = 0;
  let totalImages = 0;

  rows.forEach(row => {
    totalImages += row.image_count || 0;
    if (row.site_normalized) sites.add(row.site_normalized);
    if (row.is_pp) ppFolders++;
    if (row.sample_date) {
      if (!firstDate || row.sample_date < firstDate) firstDate = row.sample_date;
      if (!lastDate || row.sample_date > lastDate) lastDate = row.sample_date;
    }
  });

  return {
    total_folders: rows.length,
    total_images: totalImages,
    unique_sites: sites.size,
    first_date: firstDate,
    last_date: lastDate,
    pp_folders: ppFolders,
    raw_folders: rows.length - ppFolders
  };
}

function renderStats() {
  const s = (!hasActiveFilters() && state.viewStats) ? state.viewStats : computeStats(state.filteredData);
  const dateRange = (s.first_date && s.last_date)
    ? `${formatIsoDate(s.first_date)} – ${formatIsoDate(s.last_date)}`
    : '-';

  const count = (id, val) => {
    const el = document.getElementById(id);
    if (el) UI.countUp(el, Number(val));
  };
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  count('stat-folders', s.total_folders);
  count('stat-images', s.total_images);
  count('stat-sites', s.unique_sites);
  setText('stat-dates', dateRange);
  setText('stat-pp', `${s.pp_folders} PP / ${s.raw_folders} Raw`);

  const bar = document.getElementById('stat-pp-bar');
  if (bar) {
    const total = Math.max(1, Number(s.pp_folders) + Number(s.raw_folders));
    bar.children[0].style.flexBasis = `${(Number(s.pp_folders) / total) * 100}%`;
    bar.children[1].style.flexBasis = `${(Number(s.raw_folders) / total) * 100}%`;
  }

  if (state.labelStats) {
    const pct = Number(state.labelStats.pct_labeled);
    const el = document.getElementById('stat-labeled');
    if (el) UI.countUp(el, pct, { format: n => `${n.toFixed(n >= 10 || n === 0 ? 0 : 1)}%` });
    const fill = document.getElementById('stat-labeled-bar');
    if (fill) fill.style.setProperty('--value', `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`);
  }
}

// Unique sites, Date range and PP / Raw split (the .stat-link cards) open their
// dropdown under "Find a sample": the page glides down to the filters, then
// the list drops open. A browser that can't open a dropdown from a script
// (no select.showPicker(), e.g. older Safari) focuses it instead, so Space or
// Alt+Down opens it.
function openFilterDropdown(key) {
  const select = document.getElementById(`filter-${key}`);
  if (!select) return;
  const grid = document.getElementById('filter-grid');
  if (grid && grid.classList.contains('collapsed')) document.getElementById('filters-toggle').click();  // folded away on phones

  const group = select.closest('.filter-group');
  document.getElementById('catalog').scrollIntoView({ behavior: UI.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  // Open it only once the page is still: a scroll would close it again.
  afterScroll(() => {
    select.focus({ preventScroll: true });
    group.classList.remove('flash');
    void group.offsetWidth;  // restart the highlight
    group.classList.add('flash');
    select.addEventListener('animationend', () => group.classList.remove('flash'), { once: true });
    if (typeof select.showPicker === 'function') {
      try { select.showPicker(); } catch (e) { /* not allowed here: the focus will do */ }
    }
  });
}

// Calls fn once the page has stopped scrolling (or never started). Polls
// instead of waiting for 'scrollend', which older Safari doesn't send; gives
// up after 2 s, well inside the time a click lets a page open a dropdown.
function afterScroll(fn) {
  const started = performance.now();
  let last = window.scrollY;
  let stillFrames = 0;
  const tick = () => {
    stillFrames = window.scrollY === last ? stillFrames + 1 : 0;
    last = window.scrollY;
    if (stillFrames >= 4 || performance.now() - started > 2000) fn();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 10. Charts (inline SVG, coloured with the theme's CSS variables, so a theme
// switch restyles them without redrawing)

// The same shapes as the chart_* views: [label, value] pairs.
function aggregateCharts(rows) {
  const sites = {};
  const months = {};
  const waterBodies = {};
  rows.forEach(r => {
    const site = r.site_normalized || 'Unknown';
    sites[site] = (sites[site] || 0) + (r.image_count || 0);
    if (r.sample_date) {
      const month = r.sample_date.slice(0, 7);
      months[month] = (months[month] || 0) + (r.image_count || 0);
    }
    const body = r.water_body_type || 'Unknown';
    waterBodies[body] = (waterBodies[body] || 0) + 1;
  });
  const byValueThenLabel = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    sites: Object.entries(sites).sort(byValueThenLabel),
    months: Object.entries(months).sort((a, b) => a[0].localeCompare(b[0])),
    waterBodies: Object.entries(waterBodies).sort(byValueThenLabel)
  };
}

function renderCharts() {
  const data = (!hasActiveFilters() && state.viewCharts)
    ? state.viewCharts
    : aggregateCharts(state.filteredData);

  const capture = {};
  state.filteredData.forEach(r => {
    const k = r.capture_mode || 'Unknown';
    capture[k] = (capture[k] || 0) + (r.image_count || 0);
  });
  const captureEntries = Object.entries(capture).sort((a, b) => b[1] - a[1]);

  const site = document.getElementById('chart-site');
  const timeline = document.getElementById('chart-timeline');
  const type = document.getElementById('chart-type');
  const cap = document.getElementById('chart-capture');
  if (site) renderSiteChart(site, data.sites);
  if (timeline) renderTimelineChart(timeline, data.months);
  if (type) renderDonut(type, data.waterBodies, { index: state.catIndex && state.catIndex.water, unit: 'folders', noun: 'folders', filterKey: 'water_body_type' });
  if (cap) renderDonut(cap, captureEntries, { index: state.catIndex && state.catIndex.capture, unit: 'images', noun: 'images', filterKey: 'capture_mode' });
}

// A click on a graph's bar, slice or legend entry filters the catalog to it;
// clicking the one already filtered on clears it. "Unknown" (no value) isn't
// one of the filter's choices, so it can't be picked.
function canPick(name) {
  return !!name && name !== 'Unknown';
}

function pickHint(key, name) {
  return state.filters[key] === name ? 'Click to clear this filter' : 'Click to filter to this';
}

function pickFilter(key, value) {
  const before = state.filters[key];
  setFilter(key, before === value ? '' : value);
  const name = FILTER_NAMES[key];
  UI.toast({
    id: 'chart-filter', kind: 'info', duration: 5000,
    message: state.filters[key] ? `Filtered to ${name}: ${displayFilterValue(key, value)}` : `Removed the ${name} filter`,
    action: { label: 'Undo', onClick: () => setFilter(key, before) },
  });
}

function setFilter(key, value) {
  state.filters[key] = value;
  const select = document.getElementById(`filter-${key}`);
  if (select) select.value = value;
  applyFilters();
}

const esc = UI.escapeHTML;

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n % 1e3 ? 1 : 0)}k` : String(n);
}

function noData(el, label) {
  el.innerHTML = '';
  el.appendChild(h('div', { class: 'empty-state' }, UI.icon('bar-chart'), h('strong', { text: 'Nothing to chart' }), h('span', { text: label || 'No data for the current filters.' })));
}

// Shared hover tooltip for every chart
const chartTip = (() => {
  let node = null;
  const ensure = () => {
    if (!node) {
      node = h('div', { class: 'chart-tip', role: 'presentation' }, h('strong'), h('span'));
      document.body.appendChild(node);
    }
    return node;
  };
  return {
    show(title, body, x, y) {
      const n = ensure();
      n.children[0].textContent = title;
      n.children[1].textContent = body;
      n.style.left = `${Math.max(90, Math.min(window.innerWidth - 90, x))}px`;
      n.style.top = `${y}px`;
      n.classList.add('on');
    },
    hide() { if (node) node.classList.remove('on'); },
  };
})();

function bindTips(el) {
  if (el._tipsBound) return;
  el._tipsBound = true;
  el.addEventListener('pointermove', (e) => {
    const item = e.target.closest && e.target.closest('[data-tip-title]');
    if (!item) return chartTip.hide();
    chartTip.show(item.dataset.tipTitle, item.dataset.tipBody, e.clientX, item.getBoundingClientRect().top);
  });
  el.addEventListener('pointerleave', () => chartTip.hide());
}

function renderSiteChart(el, entries) {
  bindTips(el);
  if (!el._pickBound) {
    el._pickBound = true;
    el.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('g.item[data-value]');
      if (item) pickFilter('site_normalized', item.dataset.value);
    });
  }
  const rows = entries.slice(0, 12);
  if (rows.length === 0) return noData(el);
  const total = entries.reduce((s, r) => s + r[1], 0) || 1;
  const max = Math.max(...rows.map(r => r[1])) || 1;

  const W = Math.max(280, el.clientWidth);
  const rowH = 30;
  const H = rows.length * rowH + 4;
  const chars = W < 400 ? 12 : 17;
  const labelW = Math.round(chars * 7.4) + 14;
  const barMax = Math.max(40, W - labelW - 66);

  let g = '';
  rows.forEach(([name, count], i) => {
    const y = i * rowH + 2;
    const bw = Math.max(4, (count / max) * barMax);
    const pct = ((count / total) * 100).toFixed(count / total < 0.1 ? 1 : 0);
    const pick = canPick(name);
    const picked = pick && state.filters.site_normalized === name;
    g += `<g class="item${picked ? ' picked' : ''}"${pick ? ` data-value="${esc(name)}"` : ''} data-tip-title="${esc(titleCase(name))}" `
      + `data-tip-body="${count.toLocaleString()} images · ${pct}% of the total${pick ? ` · ${pickHint('site_normalized', name)}` : ''}">`
      + `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>`
      + `<text class="axis-label" x="${labelW - 10}" y="${y + rowH / 2}" dy="0.35em" text-anchor="end">${esc(truncateStr(titleCase(name), chars))}</text>`
      + `<rect class="bar-h" style="--i:${i}" x="${labelW}" y="${y + 5}" width="${bw}" height="${rowH - 10}" rx="6" fill="url(#gSite)"/>`
      + `<text class="value-label" x="${labelW + bw + 8}" y="${y + rowH / 2}" dy="0.35em">${count.toLocaleString()}</text></g>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
    + '<defs><linearGradient id="gSite" x1="0" x2="1"><stop offset="0" style="stop-color:var(--chart-1)"/><stop offset="1" style="stop-color:var(--chart-2)"/></linearGradient></defs>'
    + `${g}</svg>`;
  el.setAttribute('aria-label', `Bar chart. Top sites by images: ${rows.slice(0, 5).map(r => `${titleCase(r[0])} ${r[1].toLocaleString()}`).join(', ')}.`);
}

function renderTimelineChart(el, months) {
  bindTips(el);
  if (months.length === 0) return noData(el);

  // Fill the quiet months with zero so the axis shows the real gaps between seasons.
  const byKey = new Map(months);
  const [fy, fm] = months[0][0].split('-').map(Number);
  const [ly, lm] = months[months.length - 1][0].split('-').map(Number);
  const data = [];
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? (y++, m = 1) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    data.push({ label: `${MONTH_NAMES[m - 1]} ${y}`, short: `${MONTH_NAMES[m - 1]} ’${String(y).slice(2)}`, count: byKey.get(key) || 0 });
  }

  const W = Math.max(300, el.clientWidth);
  const H = 270;
  const m = { l: 46, r: 8, t: 12, b: 40 };
  const gw = W - m.l - m.r;
  const gh = H - m.t - m.b;
  const top = niceMax(Math.max(...data.map(d => d.count)));
  const step = gw / data.length;
  const bw = Math.max(2, Math.min(30, step * 0.68));
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(gw / 58))));

  let g = '';
  for (let t = 0; t <= 4; t++) {
    const v = (top / 4) * t;
    const y = m.t + gh - (v / top) * gh;
    g += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/><text x="${m.l - 8}" y="${y}" dy="0.35em" text-anchor="end">${compact(v)}</text>`;
  }
  data.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const bh = d.count ? Math.max(3, (d.count / top) * gh) : 0;
    g += `<g class="item" data-tip-title="${esc(d.label)}" data-tip-body="${d.count ? `${d.count.toLocaleString()} images` : 'No samples this month'}">`
      + `<rect class="hit" x="${m.l + i * step}" y="${m.t}" width="${step}" height="${gh + m.b}"/>`
      + (bh ? `<rect class="bar-v" style="--i:${i}" x="${x}" y="${m.t + gh - bh}" width="${bw}" height="${bh}" rx="${Math.min(5, bw / 2)}" fill="url(#gTime)"/>` : '')
      + (i % every === 0 ? `<text x="${m.l + i * step + step / 2}" y="${H - 16}" text-anchor="middle">${d.short}</text>` : '')
      + '</g>';
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
    + '<defs><linearGradient id="gTime" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--chart-2)"/><stop offset="1" style="stop-color:var(--chart-1)"/></linearGradient></defs>'
    + `${g}</svg>`;
  const peak = data.reduce((a, b) => (b.count > a.count ? b : a));
  el.setAttribute('aria-label', `Column chart of images per month from ${data[0].label} to ${data[data.length - 1].label}. Busiest month: ${peak.label} with ${peak.count.toLocaleString()} images.`);
}

function renderDonut(el, entries, opts) {
  const total = entries.reduce((s, r) => s + r[1], 0);
  el.innerHTML = '';
  if (!entries.length || total === 0) return noData(el);

  const size = 200, c = size / 2, R = 72, SW = 30;
  const C = 2 * Math.PI * R;
  const gap = entries.length > 1 ? 3 : 0;
  const key = opts.filterKey;
  const pickable = (name) => !!key && canPick(name);
  let cum = 0;
  let circles = '';
  entries.forEach(([name, value], i) => {
    const len = Math.max(1, (value / total) * C - gap);
    const pct = ((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0);
    const pick = pickable(name);
    circles += `<circle class="dseg" data-i="${i}"${pick ? ` data-value="${esc(name)}"` : ''} style="--i:${i};stroke:${colorVar(opts.index, name)}" cx="${c}" cy="${c}" r="${R}" fill="none" stroke-width="${SW}" `
      + `stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-cum * C}" data-tip-title="${esc(titleCase(name))}" `
      + `data-tip-body="${value.toLocaleString()} ${opts.noun} · ${pct}%${pick ? ` · ${pickHint(key, name)}` : ''}"/>`;
    cum += value / total;
  });

  // Only the ring is an image: the legend's entries are buttons screen readers must reach.
  const donut = h('div', { class: 'donut', role: 'img',
    'aria-label': `Donut chart. ${entries.slice(0, 4).map(r => `${r[0]} ${r[1].toLocaleString()}`).join(', ')}.` });
  donut.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="100%" aria-hidden="true"><g transform="rotate(-90 ${c} ${c})">${circles}</g>`
    + `<text class="donut-center" x="${c}" y="${c}" dy="0.1em" text-anchor="middle">${compact(total)}</text>`
    + `<text class="donut-sub" x="${c}" y="${c + 20}" text-anchor="middle">${opts.unit}</text></svg>`;

  const legend = h('ul', { class: 'legend' });
  entries.forEach(([name, value], i) => {
    const pct = ((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0);
    const parts = [
      h('span', { class: 'sw', style: { '--c': colorVar(opts.index, name) } }),
      h('span', { class: 'name', text: name }),
      h('span', { class: 'count', text: `${value.toLocaleString()} · ${pct}%` })];
    if (!pickable(name)) {
      legend.appendChild(h('li', { 'data-i': String(i) }, parts));
      return;
    }
    const on = state.filters[key] === name;
    const btn = h('button', {
      type: 'button', class: 'legend-btn', 'data-value': name, 'aria-pressed': String(on),
      title: on ? 'Click to clear this filter' : `Show only ${FILTER_NAMES[key]}: ${name}`,
      onclick: () => {
        const hadFocus = document.activeElement === btn;
        pickFilter(key, name);
        // The legend was redrawn: keep keyboard focus on the same entry.
        const again = [...el.querySelectorAll('.legend-btn')].find(b => b.dataset.value === name);
        if (hadFocus && again) again.focus({ preventScroll: true });
      },
    }, parts);
    legend.appendChild(h('li', { 'data-i': String(i), class: 'pick' }, btn));
  });
  el.append(donut, legend);
  if (key) {
    donut.addEventListener('click', (e) => {
      const s = e.target.closest('.dseg[data-value]');
      if (s) pickFilter(key, s.dataset.value);
    });
  }

  const setOn = (i) => {
    donut.classList.toggle('dim', i != null);
    donut.querySelectorAll('.dseg').forEach(s => s.classList.toggle('on', i != null && Number(s.dataset.i) === i));
    legend.querySelectorAll('li').forEach(li => li.classList.toggle('on', i != null && Number(li.dataset.i) === i));
  };
  legend.addEventListener('pointerover', (e) => { const li = e.target.closest('li'); if (li) setOn(Number(li.dataset.i)); });
  legend.addEventListener('pointerleave', () => setOn(null));
  donut.addEventListener('pointerover', (e) => { const s = e.target.closest('.dseg'); if (s) setOn(Number(s.dataset.i)); });
  donut.addEventListener('pointerleave', () => { setOn(null); chartTip.hide(); });
  donut.addEventListener('pointermove', (e) => {
    const s = e.target.closest('.dseg');
    if (!s) return chartTip.hide();
    chartTip.show(s.dataset.tipTitle, s.dataset.tipBody, e.clientX, e.clientY - 4);
  });
}

// 11. QA Log
function renderQALog() {
  const tbody = document.getElementById('qa-table-body');
  const toggleBtn = document.getElementById('qa-toggle-btn');
  const content = document.getElementById('qa-log-content');
  const badge = document.getElementById('qa-count');

  if (!tbody || !toggleBtn) return;

  tbody.innerHTML = '';
  if (badge) badge.textContent = state.qaData.length;

  if (state.qaData.length === 0) {
    tbody.appendChild(h('tr', {}, h('td', { colspan: '3', class: 'no-results', text: 'No QA entries. The catalog build found nothing to flag.' })));
  }

  state.qaData.forEach(row => {
    const level = (row.level || 'info').toLowerCase().replace(/[^a-z]/g, '');
    tbody.appendChild(h('tr', { class: `qa-${level}` },
      h('td', { text: row.level || 'INFO' }),
      h('td', { text: row.target || '-' }),
      h('td', { text: row.detail || '-' })));
  });

  toggleBtn.onclick = () => {
    state.qaExpanded = !state.qaExpanded;
    toggleBtn.setAttribute('aria-expanded', String(state.qaExpanded));
    if (content) content.hidden = !state.qaExpanded;
  };
}

// 12. Detail Panel

// Increments on every open, so a slow load for a previous folder is ignored.
let detailRequestId = 0;
let detailOpener = null;

const formatBytes = UI.formatBytes;

function detailOpen() {
  const panel = document.getElementById('detail-panel');
  return !!panel && panel.classList.contains('open');
}

async function openDetailPanel(row, opener) {
  const panel = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');
  const content = document.getElementById('detail-content');
  if (!panel || !overlay || !content) return;
  detailOpener = opener || null;

  document.getElementById('detail-title').textContent = row.folder_name;

  const metaFields = [
    ['Site', row.site_normalized ? titleCase(row.site_normalized) : null],
    ['Water body', row.water_body_type ? titleCase(row.water_body_type) : null],
    ['Date', row.date],
    ['Magnification', row.magnification],
    ['Sample code', row.sample_code],
    ['Capture mode', row.capture_mode],
    ['Dilution', row.dilution],
    ['Type', row.is_pp ? 'Post-processed (PP)' : 'Raw'],
    ['Images', row.image_count != null ? row.image_count.toLocaleString() : null],
    ['Size range', (row.min_width && row.max_width)
      ? `${row.min_width}×${row.min_height} – ${row.max_width}×${row.max_height}` : null],
  ];
  const meta = h('dl', { class: 'meta-grid' });
  metaFields.forEach(([label, val]) => {
    meta.appendChild(h('div', {}, h('dt', { text: label }), h('dd', { text: val || '-' })));
  });

  const labelHref = `labeling.html?folder=${encodeURIComponent(row.folder_name)}`;
  const lp = state.labelMap && state.labelMap.get(row.folder_name);
  const actions = h('div', { class: 'detail-actions' },
    h('a', { class: 'btn btn-primary', href: labelHref }, UI.icon('tag'), 'Label this folder'),
    lp ? h('span', { class: 'badge badge-primary', text: `${Number(lp.pct_labeled)}% labeled` }) : null);

  const gallery = h('section', { class: 'detail-images-section', 'aria-label': 'Images in this folder' },
    h('div', { class: 'detail-images-header' }, h('h3', { text: 'Images' })),
    h('div', { id: 'detail-images-container' }, h('div', { class: 'detail-loading' }, h('div', { class: 'spinner' }), 'Loading images…')));

  content.innerHTML = '';
  content.append(actions, meta, gallery);
  content.scrollTop = 0;

  panel.classList.add('open');
  overlay.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  document.getElementById('detail-close').focus({ preventScroll: true });

  // --- Load image data ---
  const requestId = ++detailRequestId;
  try {
    const images = await fetchFolderImages(row.folder_name);
    const container = document.getElementById('detail-images-container');
    if (requestId !== detailRequestId || !container) return;
    renderImageListing(container, images, row, labelHref);
  } catch (e) {
    const container = document.getElementById('detail-images-container');
    if (requestId !== detailRequestId || !container) return;
    container.innerHTML = '';
    container.appendChild(h('div', { class: 'alert alert-error' }, UI.icon('alert'),
      h('div', { class: 'alert-body' }, `Failed to load image data: ${e.message || String(e)}`)));
  }
}

function renderImageListing(container, images, folderRow, labelHref) {
  if (!images || images.length === 0) {
    container.innerHTML = '';
    container.appendChild(h('div', { class: 'empty-state' }, UI.icon('image'), h('strong', { text: 'No images in this folder' })));
    return;
  }

  const S = { view: UI.store.get('detail-view', 'grid'), search: '', shown: 60, sortCol: 'filename', sortDir: 'asc' };
  const displayLimit = 200;

  function filtered() {
    let list = images;
    if (S.search) {
      const q = S.search.toLowerCase();
      list = list.filter(img => img.filename.toLowerCase().includes(q));
    }
    return list;
  }

  function sortedForTable(list) {
    const dir = S.sortDir === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      let va = a[S.sortCol];
      let vb = b[S.sortCol];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function openViewer(list, index, originEl) {
    ImageViewer.open({
      items: list.slice(),
      index,
      folderName: folderRow.folder_name,
      canLabel: false,
      labelHref,
      originEl,
    });
  }

  function render() {
    const list = filtered();
    const totalSize = list.reduce((s, img) => s + (img.file_size_bytes || 0), 0);
    container.innerHTML = '';

    // Controls
    const search = h('input', { type: 'search', placeholder: 'Search filenames…', value: S.search, 'aria-label': 'Search filenames', autocomplete: 'off' });
    search.addEventListener('input', UI.debounce(() => {
      S.search = search.value;
      S.shown = 60;
      render();
      const again = container.querySelector('input[type="search"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 220));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Image view' },
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'grid'), onclick: () => { S.view = 'grid'; UI.store.set('detail-view', 'grid'); render(); } }, UI.icon('grid'), ' Grid'),
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'table'), onclick: () => { S.view = 'table'; UI.store.set('detail-view', 'table'); render(); } }, UI.icon('list'), ' Table'));
    container.appendChild(h('div', { class: 'img-controls' },
      h('div', { class: 'search-field' }, UI.icon('search'), search), seg));
    container.appendChild(h('div', { class: 'img-controls' },
      h('span', { class: 'img-count', text: `${list.length.toLocaleString()} of ${images.length.toLocaleString()} images · ${formatBytes(totalSize)}` }),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => downloadVisible(list) }, UI.icon('download'), `Download first ${Math.min(list.length, displayLimit)}`)));

    if (list.length === 0) {
      container.appendChild(h('div', { class: 'empty-state' }, UI.icon('search'), h('strong', { text: 'No filenames match' })));
      return;
    }

    if (S.view === 'grid') {
      const grid = h('div', { class: 'thumb-grid' });
      list.slice(0, S.shown).forEach((img, i) => {
        const thumb = h('button', {
          type: 'button', class: 'thumb', style: { '--i': String(i % 30) }, 'data-label': img.label || null,
          'aria-label': `Open ${img.filename}${img.label ? `, labeled ${Labels.text(img.label)}` : ''}`,
        }, h('img', { src: UI.imageUrl(img.relative_path), alt: '', loading: 'lazy', decoding: 'async' }),
          img.width ? h('span', { class: 'thumb-dim', text: `${img.width}×${img.height}` }) : null);
        if (img.label) thumb.appendChild(h('span', { class: 'thumb-tag' }, Labels.chip(img.label)));
        thumb.addEventListener('click', () => openViewer(list, i, thumb));
        grid.appendChild(thumb);
      });
      container.appendChild(grid);
      if (list.length > S.shown) {
        container.appendChild(h('div', { class: 'thumb-more' },
          h('button', { type: 'button', class: 'btn', onclick: () => { S.shown += 60; render(); } }, `Show ${Math.min(60, list.length - S.shown)} more`)));
      }
      return;
    }

    // Table view
    const cols = [['filename', 'Filename'], ['width', 'W'], ['height', 'H'], ['file_size_bytes', 'Size'], ['format', 'Fmt'], ['label', 'Label']];
    const head = h('tr');
    cols.forEach(([key, text]) => {
      const th = h('th', { scope: 'col', 'aria-sort': S.sortCol === key ? (S.sortDir === 'asc' ? 'ascending' : 'descending') : null },
        h('button', { type: 'button', class: 'th-btn', onclick: () => {
          if (S.sortCol === key) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc'; else { S.sortCol = key; S.sortDir = 'asc'; }
          render();
        } }, text, UI.icon('chevron-down', 'sort-icon')));
      head.appendChild(th);
    });
    head.appendChild(h('th', { scope: 'col' }, h('span', { class: 'visually-hidden', text: 'Actions' })));

    const sorted = sortedForTable(list);
    const body = h('tbody');
    sorted.slice(0, displayLimit).forEach((img, i) => {
      const viewBtn = h('button', { type: 'button', class: 'icon-btn sm plain', title: 'Preview', 'aria-label': `Preview ${img.filename}` }, UI.icon('eye'));
      viewBtn.addEventListener('click', () => openViewer(sorted, i, viewBtn));
      body.appendChild(h('tr', {},
        h('td', { class: 'img-filename', title: img.filename, text: img.filename }),
        h('td', { class: 'num', text: img.width != null ? String(img.width) : '-' }),
        h('td', { class: 'num', text: img.height != null ? String(img.height) : '-' }),
        h('td', { class: 'num', text: formatBytes(img.file_size_bytes) }),
        h('td', { text: img.format || '-' }),
        h('td', {}, Labels.chip(img.label)),
        h('td', {}, h('div', { class: 'img-actions-cell' }, viewBtn,
          h('a', { class: 'icon-btn sm plain', href: UI.imageUrl(img.relative_path, true), title: 'Download', 'aria-label': `Download ${img.filename}` }, UI.icon('download'))))));
    });
    container.appendChild(h('div', { class: 'img-table-wrap' }, h('table', { class: 'data img-table' }, h('thead', {}, head), body)));
    if (list.length > displayLimit) {
      container.appendChild(h('p', { class: 'img-truncated', text: `Showing the first ${displayLimit} of ${list.length.toLocaleString()} images. Use search to narrow the list.` }));
    }
  }

  // Download — the image server answers ?download=1 with Content-Disposition:
  // attachment, so each link saves instead of navigating.
  function downloadVisible(list) {
    const toDownload = list.slice(0, displayLimit);
    if (toDownload.length > 50 && !confirm(`This will download ${toDownload.length} files. Continue?`)) return;
    toDownload.forEach((img, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = UI.imageUrl(img.relative_path, true);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 250); // stagger downloads to avoid browser blocking
    });
    UI.toast({ message: `Started ${toDownload.length} download${toDownload.length === 1 ? '' : 's'}.`, kind: 'success' });
  }

  render();
}

function closeDetailPanel() {
  const panel = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  overlay.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  detailRequestId++;
  if (detailOpener && document.contains(detailOpener)) detailOpener.focus({ preventScroll: true });
}

// 13. URL Hash State
function saveStateToHash() {
  const hashObj = {
    p: state.currentPage,
    sz: state.pageSize,
    sc: state.sortColumn,
    sd: state.sortDirection
  };

  Object.keys(state.filters).forEach(k => {
    if (state.filters[k]) {
      hashObj[`f_${k}`] = state.filters[k];
    }
  });

  const params = new URLSearchParams(hashObj);
  const newHash = '#' + params.toString();

  if (window.location.hash !== newHash) {
    history.replaceState(null, null, newHash);
  }
}

function loadStateFromHash() {
  if (!window.location.hash) return;

  try {
    const params = new URLSearchParams(window.location.hash.substring(1));

    if (params.has('p')) state.currentPage = parseInt(params.get('p'), 10) || 1;
    if (params.has('sz') && [10, 25, 50, 100].includes(parseInt(params.get('sz'), 10))) {
      state.pageSize = parseInt(params.get('sz'), 10);
    }
    if (SORTABLE_COLUMNS.includes(params.get('sc'))) state.sortColumn = params.get('sc');
    if (['asc', 'desc'].includes(params.get('sd'))) state.sortDirection = params.get('sd');

    // Load filters
    Object.keys(state.filters).forEach(k => {
      const pKey = `f_${k}`;
      if (params.has(pKey)) {
        state.filters[k] = params.get(pKey);

        // Update DOM elements
        if (k === 'search') {
          const input = document.getElementById('search-input');
          if (input) input.value = state.filters[k];
        } else {
          const select = document.getElementById(`filter-${k}`);
          if (select) select.value = state.filters[k];
        }
      }
    });

    // update page size selector
    const szSelect = document.getElementById('page-size');
    if (szSelect) szSelect.value = state.pageSize;

  } catch (err) {
    console.error('Error parsing hash state:', err);
  }
}

// 14. Text size (theme.js applies and remembers it on every page)

function openTextSizeDialog() {
  const label = n => `${n.toFixed(1)}×`;
  let pending = TextSize.get();

  const range = h('input', {
    type: 'range', min: String(TextSize.min), max: String(TextSize.max), step: '0.1',
    value: String(pending), 'aria-label': 'Text size',
  });
  const readout = h('output', { class: 'ts-value' });
  const smaller = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Smaller text' }, UI.icon('minus'));
  const larger = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Larger text' }, UI.icon('plus'));
  const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
  const apply = h('button', { type: 'button', class: 'btn btn-primary', text: 'Apply' });

  const body = h('div', { class: 'ts-dialog' },
    h('p', { class: 'ts-intro', style: { '--i': '0' },
      text: 'Make the text on every page bigger, from 1× (the default) up to 4×. The example below shows the size before you apply it.' }),
    h('div', { class: 'ts-control', style: { '--i': '1' } },
      smaller,
      h('div', { class: 'ts-range' }, range,
        h('div', { class: 'ts-ticks', 'aria-hidden': 'true' }, ['1×', '2×', '3×', '4×'].map(t => h('span', { text: t })))),
      larger, readout),
    h('div', { class: 'ts-preview', style: { '--i': '2' } },
      h('p', { class: 'eyebrow', text: 'Sample folder' }),
      h('p', { class: 'ts-sample-title', text: 'Indian Lake, October 14, 2023' }),
      h('p', { class: 'ts-sample-body', text: '380 FlowCam images of cyanobacteria and other plankton, ready to browse, download and label.' })),
    h('div', { class: 'ts-actions', style: { '--i': '3' } }, cancel, apply));

  function show(value, bump) {
    pending = Math.min(TextSize.max, Math.max(TextSize.min, Math.round(value * 10) / 10));
    range.value = String(pending);
    range.setAttribute('aria-valuetext', `${pending.toFixed(1)} times`);
    readout.textContent = label(pending);
    body.style.setProperty('--ts', String(pending));
    if (bump && !UI.reducedMotion()) {
      readout.classList.remove('bump');
      void readout.offsetWidth;  // restart the pop
      readout.classList.add('bump');
    }
  }
  range.addEventListener('input', () => show(Number(range.value), true));
  smaller.addEventListener('click', () => show(pending - 0.1, true));
  larger.addEventListener('click', () => show(pending + 0.1, true));
  show(pending, false);

  // Cancel, Esc and a click outside all close it without changing anything.
  const dlg = UI.dialog({ title: 'Change text size', content: body, wide: true, closeButton: false, focus: range });
  cancel.addEventListener('click', () => dlg.close());
  apply.addEventListener('click', () => {
    const changed = pending !== TextSize.get();
    dlg.close();
    TextSize.set(pending);
    if (changed) UI.toast({ message: `Text size set to ${label(pending)}.`, kind: 'success', duration: 3000 });
  });
}

// 15. Initialization
document.addEventListener('DOMContentLoaded', async () => {
  const textSizeBtn = document.getElementById('text-size-btn');
  if (textSizeBtn) textSizeBtn.addEventListener('click', openTextSizeDialog);

  document.querySelectorAll('.stat-link').forEach(card => {
    const open = () => openFilterDropdown(card.dataset.filter);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  // Setup search debounce
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', UI.debounce((e) => {
      state.filters.search = e.target.value;
      applyFilters();
    }, 300));
  }

  // Setup select filters
  FILTER_KEYS.forEach(k => {
    const select = document.getElementById(`filter-${k}`);
    if (select) {
      select.addEventListener('change', (e) => {
        state.filters[k] = e.target.value;
        applyFilters();
      });
    }
  });

  // Clear filters
  const clearBtn = document.getElementById('clear-filters-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      // Reset filter state
      Object.keys(state.filters).forEach(k => state.filters[k] = '');

      // Reset DOM
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.filter-select').forEach(sel => sel.value = '');

      applyFilters();
    });
  }

  // Filters fold away on phones
  const toggle = document.getElementById('filters-toggle');
  const grid = document.getElementById('filter-grid');
  if (toggle && grid) {
    const setCollapsed = (collapsed) => {
      grid.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
    };
    setCollapsed(window.matchMedia('(max-width: 760px)').matches);
    toggle.addEventListener('click', () => setCollapsed(!grid.classList.contains('collapsed')));
  }

  // Page size
  const szSelect = document.getElementById('page-size');
  if (szSelect) {
    szSelect.addEventListener('change', (e) => {
      state.pageSize = parseInt(e.target.value, 10);
      state.currentPage = 1;
      saveStateToHash();
      renderTable();
      renderPagination();
    });
  }

  // Sort headers
  document.querySelectorAll('th[data-sortable]').forEach(th => {
    th.addEventListener('click', () => {
      sortData(th.dataset.col);
    });
  });

  // Detail panel: close button, backdrop, Esc, and keep Tab inside it
  const closeBtn = document.getElementById('detail-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetailPanel);
  const overlay = document.getElementById('detail-overlay');
  if (overlay) overlay.addEventListener('click', closeDetailPanel);
  document.addEventListener('keydown', (e) => {
    if (!detailOpen() || ImageViewer.current || document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDetailPanel(); }
    else UI.trapFocus(document.getElementById('detail-panel'), e);
  });

  // Hash change
  window.addEventListener('hashchange', () => {
    // Only reload if we actually triggered browser nav (back/forward)
    // In a full app we'd compare hash precisely
    if (!state.loaded) return;
    loadStateFromHash();
    applyFilters(false);
  });

  // Re-draw charts on resize (debounced) and text-size changes: their layout
  // depends on the width
  window.addEventListener('resize', UI.debounce(() => { if (state.loaded) renderCharts(); }, 200));
  TextSize.onChange(() => { if (state.loaded) renderCharts(); });

  // Go!
  await loadData();
});
