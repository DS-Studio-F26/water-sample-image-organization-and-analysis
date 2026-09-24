/**
 * Dashboard JavaScript for Water Sample Image Catalog
 * 100% Vanilla JS - No external libraries
 */

// 2. State Management
const state = {
  allData: [],       // all folder rows
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
    dilution: '',
    is_pp: ''  // '', 'true', 'false'
  },
  qaData: [],
  qaExpanded: false
};

// 1. CSV Parser
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];
  
  // Parse header
  const headers = parseCSVLine(lines[0]);
  
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let val = values[j];
      if (val === undefined) val = '';
      
      const header = headers[j];
      
      // Type conversions
      if (['image_count', 'unreadable_count', 'min_width', 'max_width', 'min_height', 'max_height'].includes(header)) {
        obj[header] = val ? Number(val) : null;
      } else if (['is_pp', 'parsed_ok'].includes(header)) {
        obj[header] = val.toLowerCase() === 'true';
      } else {
        obj[header] = val;
      }
    }
    data.push(obj);
  }
  return data;
}

function parseCSVLine(line) {
  const result = [];
  let currentVal = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i+1] === '"') {
        currentVal += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(currentVal);
      currentVal = '';
    } else {
      currentVal += char;
    }
  }
  result.push(currentVal);
  return result;
}

// 3. Data Loading
async function loadData() {
  showLoading(true);
  try {
    const [summaryRes, qaRes] = await Promise.all([
      fetch('catalog_output/folder_summary.csv'),
      fetch('catalog_output/qa_log.csv')
    ]);
    
    if (summaryRes.ok) {
      const summaryText = await summaryRes.text();
      state.allData = parseCSV(summaryText);
    }
    
    if (qaRes.ok) {
      const qaText = await qaRes.text();
      state.qaData = parseCSV(qaText);
    }
    
    populateFilters();
    loadStateFromHash(); // Restore before first render
    applyFilters(false); // don't update hash yet
    renderQALog();
    
  } catch (err) {
    console.error('Error loading data:', err);
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

// Helper to parse custom M.D.YY dates
function parseCustomDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    let y = parseInt(parts[2], 10);
    // Assume 2-digit years are 2000+
    if (y < 100) {
      y += 2000;
    }
    return new Date(y, m - 1, d);
  }
  return null;
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
  
  const siteNormalized = getUnique('site_normalized').sort();
  const waterBodyTypes = getUnique('water_body_type').sort();
  
  const rawDates = getUnique('date');
  const dates = rawDates.sort((a, b) => {
    const da = parseCustomDate(a);
    const db = parseCustomDate(b);
    if (!da && !db) return a.localeCompare(b);
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });
  
  const sampleCodes = getUnique('sample_code').sort();
  const dilutions = getUnique('dilution').sort();
  
  populateDropdown('filter-site_normalized', siteNormalized);
  populateDropdown('filter-water_body_type', waterBodyTypes);
  populateDropdown('filter-date', dates);
  populateDropdown('filter-sample_code', sampleCodes);
  populateDropdown('filter-dilution', dilutions);
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
  const col = state.sortColumn;
  const dir = state.sortDirection === 'asc' ? 1 : -1;
  
  state.filteredData.sort((a, b) => {
    let valA = a[col];
    let valB = b[col];
    
    // Handle null/undefined
    if (valA == null) valA = '';
    if (valB == null) valB = '';
    
    if (col === 'date') {
      const dateA = parseCustomDate(valA);
      const dateB = parseCustomDate(valB);
      if (dateA && dateB) {
        return (dateA - dateB) * dir;
      }
    }
    
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
  
  for (let i = start; i < end; i++) {
    const row = state.filteredData[i];
    const tr = document.createElement('tr');
    tr.onclick = () => openDetailPanel(row);
    
    // Folder Name
    const tdName = document.createElement('td');
    tdName.className = 'col-folder';
    tdName.textContent = truncateStr(row.folder_name, 35);
    tdName.title = row.folder_name || '';
    tr.appendChild(tdName);
    
    // Site
    const tdSite = document.createElement('td');
    tdSite.textContent = row.site_normalized || '-';
    tr.appendChild(tdSite);
    
    // Water Body Type
    const tdType = document.createElement('td');
    tdType.textContent = row.water_body_type || '-';
    tr.appendChild(tdType);
    
    // Date
    const tdDate = document.createElement('td');
    tdDate.textContent = row.date || '-';
    tr.appendChild(tdDate);
    
    // Sample Code
    const tdSample = document.createElement('td');
    tdSample.textContent = row.sample_code || '-';
    tr.appendChild(tdSample);
    
    // Dilution
    const tdDilution = document.createElement('td');
    tdDilution.textContent = row.dilution || '-';
    tr.appendChild(tdDilution);
    
    // PP/Raw Badge
    const tdBadge = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${row.is_pp ? 'pp-badge' : 'raw-badge'}`;
    badge.textContent = row.is_pp ? 'PP' : 'Raw';
    tdBadge.appendChild(badge);
    tr.appendChild(tdBadge);
    
    // Image Count
    const tdImg = document.createElement('td');
    tdImg.className = 'col-number';
    tdImg.textContent = row.image_count != null ? row.image_count.toLocaleString() : '0';
    tr.appendChild(tdImg);
    
    // Dimensions
    const tdDim = document.createElement('td');
    if (row.min_width && row.max_width) {
      if (row.min_width === row.max_width && row.min_height === row.max_height) {
        tdDim.textContent = `${row.max_width}x${row.max_height}`;
      } else {
        tdDim.textContent = `${row.min_width}x${row.min_height} - ${row.max_width}x${row.max_height}`;
      }
    } else {
      tdDim.textContent = '-';
    }
    tdDim.className = 'col-dim';
    tr.appendChild(tdDim);
    
    // Status
    const tdStatus = document.createElement('td');
    tdStatus.className = 'col-status';
    const statusDot = document.createElement('span');
    statusDot.className = `status-dot status-${row.parsed_ok ? 'ok' : 'error'}`;
    statusDot.title = row.parsed_ok ? 'Parsed OK' : 'Parse Error';
    tdStatus.appendChild(statusDot);
    tr.appendChild(tdStatus);
    
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
function renderStats() {
  const data = state.filteredData;
  
  const totalFolders = data.length;
  const totalImages = data.reduce((sum, row) => sum + (row.image_count || 0), 0);
  
  const sites = new Set();
  let earliest = null;
  let latest = null;
  let ppCount = 0;
  
  data.forEach(row => {
    if (row.site_normalized) sites.add(row.site_normalized);
    if (row.is_pp) ppCount++;
    
    const d = parseCustomDate(row.date);
    if (d) {
      if (!earliest || d < earliest) earliest = d;
      if (!latest || d > latest) latest = d;
    }
  });
  
  const rawCount = totalFolders - ppCount;
  
  const formatDate = d => d ? `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` : '-';
  const dateRange = (earliest && latest) ? `${formatDate(earliest)} - ${formatDate(latest)}` : '-';
  
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  
  setText('stat-folders', totalFolders.toLocaleString());
  setText('stat-images', totalImages.toLocaleString());
  setText('stat-sites', sites.size.toLocaleString());
  setText('stat-dates', dateRange);
  setText('stat-pp', `${ppCount} PP / ${rawCount} Raw`);
}

// 10. Charts

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

  if (canvasSite) renderSiteChart(canvasSite, state.filteredData);
  if (canvasTimeline) renderTimelineChart(canvasTimeline, state.filteredData);
  if (canvasType) renderBodyTypeChart(canvasType, state.filteredData);
}

function renderSiteChart(canvas, data) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (data.length === 0) return drawNoData(ctx, w, h);

  // Aggregate image counts by site
  const map = {};
  data.forEach(r => {
    const site = r.site_normalized || 'Unknown';
    map[site] = (map[site] || 0) + (r.image_count || 0);
  });

  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15);
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
  const gap = step * 0.25;

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
    const barW = Math.min((count / max) * graphW, graphW);
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

function renderTimelineChart(canvas, data) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (data.length === 0) return drawNoData(ctx, w, h);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const map = {};
  data.forEach(r => {
    const parsed = parseCustomDate(r.date);
    if (parsed) {
      const key = `${parsed.getFullYear()}-${String(parsed.getMonth()).padStart(2,'0')}`; // sortable key
      const label = `${monthNames[parsed.getMonth()]} ${parsed.getFullYear()}`;
      if (!map[key]) map[key] = { label, count: 0 };
      map[key].count += (r.image_count || 0);
    }
  });

  const sorted = Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => [v.label, v.count]);

  if (sorted.length === 0) return drawNoData(ctx, w, h);

  const max = Math.max(...sorted.map(x => x[1]));

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

function renderBodyTypeChart(canvas, data) {
  const { w, h } = fitCanvasToContainer(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (data.length === 0) return drawNoData(ctx, w, h);

  const map = {};
  data.forEach(r => {
    const t = r.water_body_type || 'Unknown';
    map[t] = (map[t] || 0) + 1;
  });

  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return drawNoData(ctx, w, h);

  const colors = ['#4a90e2', '#50e3c2', '#b8e986', '#f8e71c', '#f5a623', '#d0021b', '#bd10e0', '#9013fe'];

  // Position donut so legend fits on the right
  const padding = 15;
  const legendW = 140; // reserve for legend text
  const availW = w - legendW - padding * 2;
  const cx = padding + availW / 2;
  const cy = h / 2;
  const radius = Math.max(30, Math.min(availW / 2, (h - padding * 2) / 2));

  const total = data.length;
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
  const container = document.getElementById('qa-log-container');
  const tbody = document.getElementById('qa-table-body');
  const toggleBtn = document.getElementById('qa-toggle-btn');
  
  if (!container || !tbody || !toggleBtn) return;
  
  tbody.innerHTML = '';
  
  if (state.qaData.length === 0) {
    container.style.display = 'none';
    return;
  }
  
  state.qaData.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = `qa-${(row.level || 'info').toLowerCase()}`;
    
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
  
  toggleBtn.onclick = () => {
    state.qaExpanded = !state.qaExpanded;
    const content = document.getElementById('qa-log-content');
    if (content) {
      content.style.display = state.qaExpanded ? 'block' : 'none';
    }
    toggleBtn.textContent = state.qaExpanded ? 'Hide QA Log' : `Show QA Log (${state.qaData.length} issues)`;
  };
  
  // initial setup
  toggleBtn.textContent = `Show QA Log (${state.qaData.length} issues)`;
}

// 12. Detail Panel

// Cache for the folder-name → hash-key index
let folderIndex = null;

async function loadFolderIndex() {
  if (folderIndex) return folderIndex;
  try {
    const res = await fetch('catalog_output/folder_images/_index.json');
    if (res.ok) {
      folderIndex = await res.json();
    }
  } catch (e) {
    console.warn('Could not load folder image index:', e);
  }
  return folderIndex || {};
}

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
    ['Dilution', row.dilution],
    ['Type', row.is_pp ? 'Post-Processed (PP)' : 'Raw'],
    ['Image Count', row.image_count != null ? row.image_count.toLocaleString() : '-'],
    ['Dimensions', (row.min_width && row.max_width)
      ? `${row.min_width}×${row.min_height} – ${row.max_width}×${row.max_height}`
      : '-'],
    ['Parse Status', row.parsed_ok ? '✓ OK' : '✗ Error'],
  ];

  let html = `<h3 class="detail-folder-title" title="${escapeHTML(row.folder_name)}">${escapeHTML(row.folder_name)}</h3>`;
  html += '<table class="detail-table"><tbody>';
  metaFields.forEach(([label, val]) => {
    html += `<tr><th>${label}</th><td>${val || '-'}</td></tr>`;
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
  const index = await loadFolderIndex();
  const entry = index[row.folder_name];
  const container = document.getElementById('detail-images-container');
  if (!container) return;

  if (!entry) {
    container.innerHTML = '<p class="text-muted">No image data available. Run <code>python prepare_image_data.py</code> to generate.</p>';
    return;
  }

  try {
    const res = await fetch(`catalog_output/folder_images/${entry.key}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const images = await res.json();
    renderImageListing(container, images, row);
  } catch (e) {
    container.innerHTML = `<p class="text-muted">Failed to load image data: ${e.message}</p>`;
  }
}

function renderImageListing(container, images, folderRow) {
  if (!images || images.length === 0) {
    container.innerHTML = '<p class="text-muted">No images found in this folder.</p>';
    return;
  }

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

    // Download All link (zip not available, but we provide folder path)
    html += '<div class="img-actions">';
    html += `<button class="btn btn-primary btn-sm" id="detail-download-all">⬇ Download All Visible (${filtered.length})</button>`;
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

    // Limit to 200 rows for performance, show "and X more" if truncated
    const displayLimit = 200;
    const displayImages = filtered.slice(0, displayLimit);

    displayImages.forEach(img => {
      const imgPath = `../WCMC_raw_images_2023_and_others/${img.relative_path}`;
      const dims = (img.width && img.height) ? `${img.width}` : '-';
      const hDims = (img.width && img.height) ? `${img.height}` : '-';
      html += '<tr>';
      html += `<td class="img-filename" title="${escapeHTML(img.filename)}">${escapeHTML(truncateStr(img.filename, 30))}</td>`;
      html += `<td class="img-num">${dims}</td>`;
      html += `<td class="img-num">${hDims}</td>`;
      html += `<td class="img-num">${formatBytes(img.file_size_bytes)}</td>`;
      html += `<td>${img.format || '-'}</td>`;
      html += `<td>${img.label ? `<span class="badge pp-badge">${escapeHTML(img.label)}</span>` : '<span class="text-muted">—</span>'}</td>`;
      html += `<td><a href="${encodeURI(imgPath)}" download="${escapeHTML(img.filename)}" class="btn-download" title="Download">⬇</a>`;
      html += ` <a href="${encodeURI(imgPath)}" target="_blank" class="btn-view" title="View">👁</a></td>`;
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

    // Download All — triggers sequential download of visible images
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
            a.href = encodeURI(`../WCMC_raw_images_2023_and_others/${img.relative_path}`);
            a.download = img.filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }, i * 100); // stagger downloads to avoid browser blocking
        });
      });
    }
  }

  render();
}

function escapeHTML(str) {
  if (!str) return '';
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
    if (params.has('sz')) state.pageSize = parseInt(params.get('sz'), 10) || 25;
    if (params.has('sc')) state.sortColumn = params.get('sc');
    if (params.has('sd')) state.sortDirection = params.get('sd');
    
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
  ['site_normalized', 'water_body_type', 'date', 'sample_code', 'dilution', 'is_pp'].forEach(k => {
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
