/**
 * Dashboard JavaScript for Water Sample Image Catalog
 * Vanilla JS. Data comes from Supabase (window.sb, created in auth.js; see
 * supabase/migrations/001_init.sql) and the images from the Cloudflare Worker
 * at APP_CONFIG.IMAGE_BASE_URL.
 */

// PostgREST returns at most 1,000 rows per request, so bigger reads are paged.
const DB_PAGE_SIZE = 1000;
const FOLDER_COLUMNS = 'folder_name, site_normalized, water_body_type, date, sample_date, '
  + 'magnification, sample_code, capture_mode, dilution, is_pp, image_count, '
  + 'min_width, max_width, min_height, max_height';
const IMAGE_COLUMNS = 'filename, relative_path, width, height, file_size_bytes, format, label';
const FILTER_KEYS = ['site_normalized', 'water_body_type', 'date', 'sample_code', 'capture_mode', 'dilution', 'is_pp'];
const SORTABLE_COLUMNS = ['folder_name', 'site_normalized', 'water_body_type', 'date', 'sample_code',
  'capture_mode', 'dilution', 'is_pp', 'image_count'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  viewCharts: null
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

function imageUrl(relativePath, download = false) {
  const base = window.APP_CONFIG.IMAGE_BASE_URL.replace(/\/+$/, '');
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${base}/${path}${download ? '?download=1' : ''}`;
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

    populateFilters();
    // Sign-in redirects briefly put tokens in the URL hash; wait until
    // supabase-js has consumed them before reading filters from the hash.
    if (window.Auth) await Auth.ready;
    loadStateFromHash(); // Restore before first render
    state.loaded = true;
    applyFilters(false); // don't update hash yet
    renderQALog();

  } catch (err) {
    console.error('Error loading data:', err);
    showDataError(err);
  } finally {
    showLoading(false);
  }
}

function showLoading(show) {
  const loader = document.getElementById('loading-indicator');
  if (loader) {
    loader.style.display = show ? 'flex' : 'none';
  }
}

function showDataError(err) {
  const banner = document.getElementById('data-error');
  if (banner) {
    banner.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = "Couldn't load the catalog data.";
    const explain = document.createElement('p');
    explain.textContent = "The database didn't respond. The free Supabase project pauses after about "
      + 'a week without visits; if it is paused, the project owner can restore it from the Supabase '
      + 'dashboard. Otherwise, check your internet connection and reload the page.';
    const detail = document.createElement('p');
    detail.className = 'text-muted';
    detail.textContent = `Details: ${(err && err.message) || err}`;
    const retry = document.createElement('button');
    retry.className = 'btn btn-sm';
    retry.textContent = 'Reload';
    retry.addEventListener('click', () => window.location.reload());
    banner.append(title, explain, detail, retry);
    banner.hidden = false;
  }

  const tbody = document.getElementById('table-body');
  if (tbody) {
    tbody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'no-results';
    td.textContent = 'Catalog data is unavailable right now (see the message above).';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
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

  // Reset to page 1 on new filter
  state.currentPage = 1;

  // Update UI components
  updateFilterBadge();
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
    if (activeCount > 0) {
      badge.textContent = activeCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
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
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === state.sortColumn) {
      th.classList.add(`sort-${state.sortDirection}`);
    }
  });
}

// 7. Table Rendering
function renderTable() {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const start = (state.currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, state.filteredData.length);

  if (state.filteredData.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'no-results';
    td.textContent = 'No matching folders found.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const addCell = (tr, text, className) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    tr.appendChild(td);
    return td;
  };

  for (let i = start; i < end; i++) {
    const row = state.filteredData[i];
    const tr = document.createElement('tr');
    tr.onclick = () => openDetailPanel(row);

    // Folder Name
    addCell(tr, truncateStr(row.folder_name, 35), 'col-folder').title = row.folder_name || '';
    addCell(tr, row.site_normalized || '-');
    addCell(tr, row.water_body_type || '-');
    addCell(tr, row.date || '-');
    addCell(tr, row.sample_code || '-');
    addCell(tr, row.capture_mode || '-');
    addCell(tr, row.dilution || '-');

    // PP/Raw Badge
    const tdBadge = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${row.is_pp ? 'pp-badge' : 'raw-badge'}`;
    badge.textContent = row.is_pp ? 'PP' : 'Raw';
    tdBadge.appendChild(badge);
    tr.appendChild(tdBadge);

    // Image Count
    addCell(tr, row.image_count != null ? row.image_count.toLocaleString() : '0', 'col-number');

    // Dimensions
    let dims = '-';
    if (row.min_width && row.max_width) {
      if (row.min_width === row.max_width && row.min_height === row.max_height) {
        dims = `${row.max_width}x${row.max_height}`;
      } else {
        dims = `${row.min_width}x${row.min_height} - ${row.max_width}x${row.max_height}`;
      }
    }
    addCell(tr, dims, 'col-dim');

    tbody.appendChild(tr);
  }
}

function truncateStr(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

// 8. Pagination
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
  info.textContent = `Showing ${start}–${end} of ${total} folders`;

  const totalPages = Math.ceil(total / state.pageSize);
  container.innerHTML = '';

  // Prev button
  const btnPrev = document.createElement('button');
  btnPrev.textContent = '« Prev';
  btnPrev.disabled = state.currentPage === 1;
  btnPrev.onclick = () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      saveStateToHash();
      renderTable();
      renderPagination();
    }
  };
  container.appendChild(btnPrev);

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
    if (p === '...') {
      const span = document.createElement('span');
      span.textContent = '...';
      span.className = 'page-ellipsis';
      container.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.textContent = p;
      if (p === state.currentPage) btn.className = 'active';
      btn.onclick = () => {
        state.currentPage = p;
        saveStateToHash();
        renderTable();
        renderPagination();
      };
      container.appendChild(btn);
    }
  });

  // Next button
  const btnNext = document.createElement('button');
  btnNext.textContent = 'Next »';
  btnNext.disabled = state.currentPage === totalPages;
  btnNext.onclick = () => {
    if (state.currentPage < totalPages) {
      state.currentPage++;
      saveStateToHash();
      renderTable();
      renderPagination();
    }
  };
  container.appendChild(btnNext);
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
    ? `${formatIsoDate(s.first_date)} - ${formatIsoDate(s.last_date)}`
    : '-';

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setText('stat-folders', Number(s.total_folders).toLocaleString());
  setText('stat-images', Number(s.total_images).toLocaleString());
  setText('stat-sites', Number(s.unique_sites).toLocaleString());
  setText('stat-dates', dateRange);
  setText('stat-pp', `${s.pp_folders} PP / ${s.raw_folders} Raw`);
}

// 10. Charts

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

/**
 * Resize a canvas to match its container's CSS dimensions,
 * accounting for devicePixelRatio for crisp rendering.
 * Returns the CSS (logical) width and height.
 */
function fitCanvasToContainer(canvas) {
  const container = canvas.parentElement;
  const cssW = container.clientWidth;
  const cssH = container.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { w: cssW, h: cssH };
}

function renderCharts() {
  const canvasSite = document.getElementById('chart-site');
  const canvasTimeline = document.getElementById('chart-timeline');
  const canvasType = document.getElementById('chart-type');

  const data = (!hasActiveFilters() && state.viewCharts)
    ? state.viewCharts
    : aggregateCharts(state.filteredData);

  if (canvasSite) renderSiteChart(canvasSite, data.sites);
  if (canvasTimeline) renderTimelineChart(canvasTimeline, data.months);
  if (canvasType) renderBodyTypeChart(canvasType, data.waterBodies);
}

function renderSiteChart(canvas, entries) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const sorted = entries.slice(0, 15);
  if (sorted.length === 0) return drawNoData(ctx, w, h);

  const max = Math.max(...sorted.map(x => x[1]));

  // Reserve right margin for value labels — measure the widest one
  ctx.font = '11px sans-serif';
  const maxLabelW = ctx.measureText(max.toLocaleString()).width;
  const margin = { left: 120, right: maxLabelW + 16, top: 10, bottom: 10 };
  const graphW = w - margin.left - margin.right;
  const graphH = h - margin.top - margin.bottom;

  const step = graphH / sorted.length;
  const barH = step * 0.75;

  // Clip to the full chart area (labels + bars + values)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';

  sorted.forEach((item, i) => {
    const site = item[0];
    const count = item[1];
    const y = margin.top + i * step;

    // Site label (left of bars)
    let label = site;
    if (label.length > 15) label = label.substring(0, 13) + '…';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'right';
    ctx.fillText(label, margin.left - 8, y + barH / 2);

    // Bar — clamped to graphW
    const barW = max > 0 ? Math.min((count / max) * graphW, graphW) : 0;
    ctx.fillStyle = '#4a90e2';
    ctx.fillRect(margin.left, y, Math.max(2, barW), barH);

    // Value label — always placed right after bar, clamped inside canvas
    ctx.fillStyle = '#555';
    ctx.textAlign = 'left';
    const valX = Math.min(margin.left + barW + 5, w - maxLabelW - 4);
    ctx.fillText(count.toLocaleString(), valX, y + barH / 2);
  });

  ctx.restore();
}

function renderTimelineChart(canvas, months) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // months: [['2022-05', count], ...] in date order
  const sorted = months.map(([key, count]) => {
    const [y, m] = key.split('-').map(Number);
    return [`${MONTH_NAMES[m - 1]} ${y}`, count];
  });

  if (sorted.length === 0) return drawNoData(ctx, w, h);

  const max = Math.max(...sorted.map(x => x[1])) || 1;

  // Generous bottom margin for rotated labels
  const margin = { left: 55, right: 15, top: 15, bottom: 80 };
  const graphW = w - margin.left - margin.right;
  const graphH = h - margin.top - margin.bottom;

  const step = graphW / sorted.length;
  const barW = Math.max(1, step * 0.75);

  // Clip the bar-drawing area so bars can't escape
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, graphW, graphH);
  ctx.clip();

  ctx.fillStyle = '#4a90e2';
  sorted.forEach((item, i) => {
    const count = item[1];
    const x = margin.left + i * step + (step - barW) / 2;
    const bh = (count / max) * graphH;
    const y = margin.top + graphH - bh;
    ctx.fillRect(x, y, barW, bh);
  });

  ctx.restore(); // release clip

  // Draw labels outside the clip so they appear in the bottom margin
  ctx.save();
  ctx.font = '9px sans-serif';
  sorted.forEach((item, i) => {
    const date = item[0];
    const x = margin.left + i * step + step / 2;

    ctx.save();
    ctx.translate(x, margin.top + graphH + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#666';
    ctx.fillText(date, 0, 0);
    ctx.restore();
  });
  ctx.restore();

  // Y-axis labels
  ctx.fillStyle = '#999';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(max.toLocaleString(), margin.left - 5, margin.top);
  ctx.fillText(Math.floor(max / 2).toLocaleString(), margin.left - 5, margin.top + graphH / 2);
  ctx.fillText('0', margin.left - 5, margin.top + graphH);

  // Baseline
  ctx.strokeStyle = '#ddd';
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top + graphH);
  ctx.lineTo(margin.left + graphW, margin.top + graphH);
  ctx.stroke();
}

function renderBodyTypeChart(canvas, entries) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // entries: [['pond', folderCount], ...], largest first
  const sorted = entries;
  const total = sorted.reduce((sum, item) => sum + item[1], 0);
  if (sorted.length === 0 || total === 0) return drawNoData(ctx, w, h);

  const colors = ['#4a90e2', '#50e3c2', '#b8e986', '#f8e71c', '#f5a623', '#d0021b', '#bd10e0', '#9013fe'];

  // Position donut so legend fits on the right
  const padding = 15;
  const legendW = 140; // reserve for legend text
  const availW = w - legendW - padding * 2;
  const cx = padding + availW / 2;
  const cy = h / 2;
  const radius = Math.max(30, Math.min(availW / 2, (h - padding * 2) / 2));

  let startAngle = -Math.PI / 2;

  // Clip to canvas
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  sorted.forEach((item, i) => {
    const count = item[1];
    const sliceAngle = (count / total) * 2 * Math.PI;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
    ctx.closePath();

    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();

    startAngle += sliceAngle;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // Legend — positioned right of the donut, vertically centered
  const legX = cx + radius + 20;
  const lineH = 22;
  const legTotalH = sorted.length * lineH;
  const legYStart = cy - legTotalH / 2 + lineH / 2;

  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  sorted.forEach((item, i) => {
    const type = item[0];
    const count = item[1];
    const y = legYStart + i * lineH;

    // Only draw if it fits vertically
    if (y < padding || y > h - padding) return;

    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(legX, y - 5, 10, 10);

    ctx.fillStyle = '#333';
    let label = `${type} (${count})`;
    // Truncate if it would overflow the canvas width
    while (ctx.measureText(label).width > w - legX - 20 && label.length > 4) {
      label = label.substring(0, label.length - 4) + '…';
    }
    ctx.fillText(label, legX + 15, y);
  });

  ctx.restore();
}

function drawNoData(ctx, w, h) {
  ctx.fillStyle = '#999';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No data available', w/2, h/2);
}

// 11. QA Log
function renderQALog() {
  const tbody = document.getElementById('qa-table-body');
  const toggleBtn = document.getElementById('qa-toggle-btn');
  const content = document.getElementById('qa-log-content');

  if (!tbody || !toggleBtn) return;

  tbody.innerHTML = '';

  if (state.qaData.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'no-results';
    td.textContent = 'No QA entries';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  state.qaData.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = `qa-${(row.level || 'info').toLowerCase().replace(/[^a-z]/g, '')}`;

    const tdLevel = document.createElement('td');
    tdLevel.textContent = row.level || 'INFO';

    const tdTarget = document.createElement('td');
    tdTarget.textContent = row.target || '-';

    const tdDetail = document.createElement('td');
    tdDetail.textContent = row.detail || '-';

    tr.appendChild(tdLevel);
    tr.appendChild(tdTarget);
    tr.appendChild(tdDetail);
    tbody.appendChild(tr);
  });

  const count = state.qaData.length;
  const label = () => `${state.qaExpanded ? 'Hide' : 'Show'} QA Log (${count} ${count === 1 ? 'entry' : 'entries'})`;

  toggleBtn.onclick = () => {
    state.qaExpanded = !state.qaExpanded;
    if (content) {
      content.style.display = state.qaExpanded ? 'block' : 'none';
    }
    toggleBtn.textContent = label();
  };

  // initial setup
  toggleBtn.textContent = label();
}

// 12. Detail Panel

// Increments on every open, so a slow load for a previous folder is ignored.
let detailRequestId = 0;

function formatBytes(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function openDetailPanel(row) {
  const panel = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');
  const content = document.getElementById('detail-content');
  if (!panel || !overlay || !content) return;

  // --- Folder metadata section ---
  const metaFields = [
    ['Site', row.site_normalized],
    ['Water Body', row.water_body_type],
    ['Date', row.date],
    ['Magnification', row.magnification],
    ['Sample Code', row.sample_code],
    ['Capture Mode', row.capture_mode],
    ['Dilution', row.dilution],
    ['Type', row.is_pp ? 'Post-Processed (PP)' : 'Raw'],
    ['Image Count', row.image_count != null ? row.image_count.toLocaleString() : '-'],
    ['Dimensions', (row.min_width && row.max_width)
      ? `${row.min_width}×${row.min_height} – ${row.max_width}×${row.max_height}`
      : '-'],
  ];

  let html = `<h3 class="detail-folder-title" title="${escapeHTML(row.folder_name)}">${escapeHTML(row.folder_name)}</h3>`;
  html += '<table class="detail-table"><tbody>';
  metaFields.forEach(([label, val]) => {
    html += `<tr><th>${label}</th><td>${escapeHTML(val) || '-'}</td></tr>`;
  });
  html += '</tbody></table>';

  // --- Image listing placeholder (loading state) ---
  html += '<div class="detail-images-section">';
  html += '<div class="detail-images-header">';
  html += '<h4>Images</h4>';
  html += '</div>';
  html += '<div id="detail-images-container"><div class="detail-loading"><div class="spinner"></div> Loading images…</div></div>';
  html += '</div>';

  content.innerHTML = html;
  panel.classList.add('open');
  overlay.classList.add('open');

  // --- Load image data ---
  const requestId = ++detailRequestId;
  try {
    const images = await fetchFolderImages(row.folder_name);
    const container = document.getElementById('detail-images-container');
    if (requestId !== detailRequestId || !container) return;
    renderImageListing(container, images, row);
  } catch (e) {
    const container = document.getElementById('detail-images-container');
    if (requestId !== detailRequestId || !container) return;
    container.innerHTML = `<p class="text-muted">Failed to load image data: ${escapeHTML(e.message || String(e))}</p>`;
  }
}

function renderImageListing(container, images, folderRow) {
  if (!images || images.length === 0) {
    container.innerHTML = '<p class="text-muted">No images found in this folder.</p>';
    return;
  }

  // Limit to 200 rows for performance, show "and X more" if truncated
  const displayLimit = 200;

  // State for image listing
  let imageSort = { col: 'filename', dir: 'asc' };
  let imageSearch = '';

  function getFilteredImages() {
    let filtered = images;
    if (imageSearch) {
      const q = imageSearch.toLowerCase();
      filtered = filtered.filter(img => img.filename.toLowerCase().includes(q));
    }
    filtered.sort((a, b) => {
      const dir = imageSort.dir === 'asc' ? 1 : -1;
      let va = a[imageSort.col];
      let vb = b[imageSort.col];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return filtered;
  }

  function render() {
    const filtered = getFilteredImages();
    const totalSize = filtered.reduce((s, img) => s + (img.file_size_bytes || 0), 0);

    let html = '';

    // Controls bar
    html += '<div class="img-controls">';
    html += `<input type="text" class="img-search" id="detail-img-search" placeholder="Search filenames…" value="${escapeHTML(imageSearch)}">`;
    html += `<span class="img-count">${filtered.length} of ${images.length} images (${formatBytes(totalSize)})</span>`;
    html += '</div>';

    // Download All: one file at a time from the image server
    html += '<div class="img-actions">';
    html += `<button class="btn btn-primary btn-sm" id="detail-download-all">⬇ Download All Visible (${Math.min(filtered.length, displayLimit)})</button>`;
    html += '</div>';

    // Image table
    html += '<div class="img-table-wrap">';
    html += '<table class="img-table">';
    html += '<thead><tr>';

    const columns = [
      { key: 'filename', label: 'Filename' },
      { key: 'width', label: 'W' },
      { key: 'height', label: 'H' },
      { key: 'file_size_bytes', label: 'Size' },
      { key: 'format', label: 'Fmt' },
      { key: 'label', label: 'Label' },
    ];

    columns.forEach(col => {
      const sortClass = imageSort.col === col.key
        ? (imageSort.dir === 'asc' ? 'sort-asc' : 'sort-desc')
        : '';
      html += `<th class="sortable img-th ${sortClass}" data-img-col="${col.key}">${col.label}</th>`;
    });
    html += '<th class="img-th">Action</th>';
    html += '</tr></thead><tbody>';

    const displayImages = filtered.slice(0, displayLimit);

    displayImages.forEach(img => {
      const viewUrl = imageUrl(img.relative_path);
      const downloadUrl = imageUrl(img.relative_path, true);
      html += '<tr>';
      html += `<td class="img-filename" title="${escapeHTML(img.filename)}">${escapeHTML(truncateStr(img.filename, 30))}</td>`;
      html += `<td class="img-num">${img.width != null ? img.width : '-'}</td>`;
      html += `<td class="img-num">${img.height != null ? img.height : '-'}</td>`;
      html += `<td class="img-num">${formatBytes(img.file_size_bytes)}</td>`;
      html += `<td>${escapeHTML(img.format) || '-'}</td>`;
      html += `<td>${img.label ? `<span class="badge pp-badge">${escapeHTML(img.label)}</span>` : '<span class="text-muted">—</span>'}</td>`;
      html += `<td><a href="${escapeHTML(downloadUrl)}" class="btn-download" title="Download">⬇</a>`;
      html += ` <a href="${escapeHTML(viewUrl)}" target="_blank" rel="noopener" class="btn-view" title="View">👁</a></td>`;
      html += '</tr>';
    });

    html += '</tbody></table>';
    html += '</div>';

    if (filtered.length > displayLimit) {
      html += `<p class="text-muted img-truncated">Showing first ${displayLimit} of ${filtered.length} images. Use search to narrow results.</p>`;
    }

    container.innerHTML = html;

    // --- Attach event listeners ---

    // Search
    const searchInput = document.getElementById('detail-img-search');
    if (searchInput) {
      let timeout;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          imageSearch = e.target.value;
          render();
          // Re-focus and restore cursor position
          const newInput = document.getElementById('detail-img-search');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(newInput.value.length, newInput.value.length);
          }
        }, 250);
      });
    }

    // Column sort
    container.querySelectorAll('th[data-img-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.imgCol;
        if (imageSort.col === col) {
          imageSort.dir = imageSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          imageSort.col = col;
          imageSort.dir = 'asc';
        }
        render();
      });
    });

    // Download All — the image server answers ?download=1 with
    // Content-Disposition: attachment, so each link saves instead of navigating.
    const downloadAllBtn = document.getElementById('detail-download-all');
    if (downloadAllBtn) {
      downloadAllBtn.addEventListener('click', () => {
        const toDownload = filtered.slice(0, displayLimit);
        if (toDownload.length > 50) {
          if (!confirm(`This will download ${toDownload.length} files. Continue?`)) return;
        }
        toDownload.forEach((img, i) => {
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = imageUrl(img.relative_path, true);
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }, i * 250); // stagger downloads to avoid browser blocking
        });
      });
    }
  }

  render();
}

function escapeHTML(str) {
  if (str == null || str === '') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function closeDetailPanel() {
  const panel = document.getElementById('detail-panel');
  const overlay = document.getElementById('detail-overlay');
  if (panel) panel.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
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

// 14. Initialization
document.addEventListener('DOMContentLoaded', async () => {
  // Setup search debounce
  const searchInput = document.getElementById('search-input');
  let searchTimeout;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.filters.search = e.target.value;
        applyFilters();
      }, 300);
    });
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

  // Detail panel close
  const closeBtn = document.getElementById('detail-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetailPanel);
  const overlay = document.getElementById('detail-overlay');
  if (overlay) overlay.addEventListener('click', closeDetailPanel);

  // Hash change
  window.addEventListener('hashchange', () => {
    // Only reload if we actually triggered browser nav (back/forward)
    // In a full app we'd compare hash precisely
    if (!state.loaded) return;
    loadStateFromHash();
    applyFilters(false);
  });

  // Re-render charts on resize (debounced)
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => renderCharts(), 200);
  });

  // Go!
  await loadData();
});
