/**
 * Labeling page: admins and labelers tag images from a chosen folder, one at
 * a time or in bulk. Data comes from Supabase (window.sb, created in
 * auth.js); images from the Cloudflare Worker at APP_CONFIG.IMAGE_BASE_URL.
 *
 * Only the `label` column is writable from the browser -- see
 * supabase/migrations/002_labeling.sql. labeled_by/labeled_date are set by a
 * database trigger from the signed-in user and the current time, never from
 * anything sent here.
 */

// Placeholder label taxonomy -- edit this to match whatever categories
// Prof. Ahlgren/the team settles on before real labeling starts. The `key` is
// the number key that applies that label to the current selection.
const LABEL_OPTIONS = [
  { value: 'cyanobacteria', text: 'Cyanobacteria', key: '1' },
  { value: 'diatom', text: 'Diatom', key: '2' },
  { value: 'other_organism', text: 'Other organism', key: '3' },
  { value: 'debris', text: 'Debris', key: '4' },
  { value: 'blank', text: 'Blank / empty', key: '5' },
  { value: 'unsure', text: 'Unsure', key: '6' },
];
const LABEL_TEXT = Object.fromEntries(LABEL_OPTIONS.map(o => [o.value, o.text]));

const DB_PAGE_SIZE = 1000; // PostgREST's per-request row cap

const state = {
  stats: null,           // labeling_stats row
  labelCounts: [],        // label_counts rows
  myCount: 0,
  folders: [],            // folder_labeling_progress rows
  currentFolder: null,    // folder_name
  folderImages: [],       // images in the current folder: {image_id, filename, relative_path, label, labeled_date}
  filter: 'all',          // 'all' | 'unlabeled' | 'labeled'
  page: 1,
  pageSize: 48,
  selected: new Set(),    // image_id
  saving: false,
};

// 1. Supabase helpers

async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < DB_PAGE_SIZE) return rows;
  }
}

function imageUrl(relativePath) {
  const base = window.APP_CONFIG.IMAGE_BASE_URL.replace(/\/+$/, '');
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${base}/${path}`;
}

function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// 2. Role gate (mirrors admin.js)

let lastRenderKey = null;

async function renderForUser(auth) {
  const key = auth.user ? `${auth.user.id}|${(auth.profile && auth.profile.role) || 'viewer'}` : 'signed-out';
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  hideMessage();

  if (!window.sb) {
    showSection('labeling-loading');
    document.getElementById('labeling-loading').textContent =
      "Can't reach the sign-in service (the Supabase library didn't load). Please reload the page.";
    return;
  }
  if (!auth.user) {
    showSection('labeling-signed-out');
    return;
  }
  const role = (auth.profile && auth.profile.role) || 'viewer';
  if (role !== 'admin' && role !== 'labeler') {
    document.getElementById('labeling-forbidden-email').textContent = auth.user.email;
    document.getElementById('labeling-forbidden-role').textContent =
      role.charAt(0).toUpperCase() + role.slice(1);
    showSection('labeling-forbidden');
    return;
  }
  showSection('labeling-panel');
  await loadProgress();
}

function showSection(id) {
  ['labeling-loading', 'labeling-signed-out', 'labeling-forbidden', 'labeling-panel'].forEach(sectionId => {
    document.getElementById(sectionId).hidden = sectionId !== id;
  });
}

// 3. Progress overview + folder picker

async function loadProgress() {
  try {
    const [statsRes, labelCountsRows, foldersRows, myCountRes] = await Promise.all([
      sb.from('labeling_stats').select('*').single(),
      fetchAllRows(() => sb.from('label_counts').select('label, image_count')),
      fetchAllRows(() => sb.from('folder_labeling_progress')
        .select('folder_name, site_normalized, image_count, labeled_count, unlabeled_count, pct_labeled')),
      sb.rpc('my_labeling_count'),
    ]);
    if (statsRes.error) throw statsRes.error;
    if (myCountRes.error) throw myCountRes.error;

    state.stats = statsRes.data;
    state.labelCounts = labelCountsRows;
    state.folders = foldersRows;
    state.myCount = myCountRes.data;

    renderProgress();
    populateFolderPicker();
    renderLabelToolbar();
  } catch (err) {
    console.error('Error loading labeling progress:', err);
    showMessage(`Couldn't load labeling data: ${describeError(err)}`, 'error');
  }
}

function renderProgress() {
  const s = state.stats;
  if (!s) return;
  document.getElementById('progress-bar-fill').style.width = `${s.pct_labeled}%`;
  document.getElementById('progress-pct').textContent = `${s.pct_labeled}%`;
  document.getElementById('progress-stats').textContent =
    `${Number(s.labeled_images).toLocaleString()} of ${Number(s.total_images).toLocaleString()} images labeled `
    + `by ${s.labeler_count} ${s.labeler_count === 1 ? 'person' : 'people'} · `
    + `you've labeled ${Number(state.myCount).toLocaleString()}`;

  const breakdown = document.getElementById('label-breakdown');
  breakdown.innerHTML = '';
  state.labelCounts.forEach(({ label, image_count }) => {
    const chip = document.createElement('span');
    chip.className = 'badge label-chip';
    chip.textContent = `${LABEL_TEXT[label] || label}: ${Number(image_count).toLocaleString()}`;
    breakdown.appendChild(chip);
  });
}

function populateFolderPicker() {
  const select = document.getElementById('folder-select');
  const hideComplete = document.getElementById('hide-complete-checkbox').checked;
  const leastFirst = document.getElementById('least-labeled-first-checkbox').checked;
  const previous = select.value;

  let rows = state.folders.slice();
  if (hideComplete) rows = rows.filter(f => f.unlabeled_count > 0);
  rows.sort((a, b) => leastFirst
    ? (a.pct_labeled - b.pct_labeled) || a.folder_name.localeCompare(b.folder_name)
    : a.folder_name.localeCompare(b.folder_name));

  select.innerHTML = '<option value="">Select a folder…</option>';
  rows.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.folder_name;
    opt.textContent = `${f.folder_name} (${f.labeled_count}/${f.image_count} labeled, ${f.pct_labeled}%)`;
    select.appendChild(opt);
  });
  if (previous && rows.some(f => f.folder_name === previous)) select.value = previous;
}

function renderLabelToolbar() {
  const toolbar = document.getElementById('label-toolbar');
  toolbar.innerHTML = '';
  LABEL_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn label-btn';
    btn.dataset.labelValue = opt.value;
    btn.innerHTML = `<span class="label-key">${opt.key}</span> ${escapeHTML(opt.text)}`;
    btn.addEventListener('click', () => applyLabel(opt.value));
    toolbar.appendChild(btn);
  });
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn label-btn label-btn-clear';
  clearBtn.textContent = 'Clear label';
  clearBtn.addEventListener('click', () => applyLabel(null));
  toolbar.appendChild(clearBtn);
}

// 4. Folder workspace

async function selectFolder(folderName) {
  state.currentFolder = folderName;
  state.selected.clear();
  state.page = 1;
  document.getElementById('workspace-card').hidden = !folderName;
  if (!folderName) return;

  document.getElementById('workspace-folder-name').textContent = folderName;
  document.getElementById('image-grid').innerHTML = '';
  document.getElementById('image-grid-loading').hidden = false;

  try {
    state.folderImages = await fetchAllRows(() => sb.from('images')
      .select('image_id, filename, relative_path, label, labeled_date')
      .eq('folder_name', folderName)
      .order('filename'));
  } catch (err) {
    console.error('Error loading folder images:', err);
    showMessage(`Couldn't load images for ${folderName}: ${describeError(err)}`, 'error');
    state.folderImages = [];
  }
  document.getElementById('image-grid-loading').hidden = true;
  renderWorkspace();
}

function getFilteredFolderImages() {
  if (state.filter === 'unlabeled') return state.folderImages.filter(img => !img.label);
  if (state.filter === 'labeled') return state.folderImages.filter(img => img.label);
  return state.folderImages;
}

function renderWorkspace() {
  const total = state.folderImages.length;
  const labeled = state.folderImages.filter(img => img.label).length;
  document.getElementById('workspace-folder-progress').textContent =
    `${labeled}/${total} labeled (${total ? Math.round(100 * labeled / total) : 0}%)`;

  const filtered = getFilteredFolderImages();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * state.pageSize;
  const pageImages = filtered.slice(start, start + state.pageSize);

  renderGrid(pageImages);
  renderPagination(filtered.length, pageCount);
  renderSelectionCount();
}

function renderGrid(images) {
  const grid = document.getElementById('image-grid');
  grid.innerHTML = '';
  images.forEach(img => {
    const cell = document.createElement('div');
    cell.className = 'image-cell' + (state.selected.has(img.image_id) ? ' selected' : '');
    cell.dataset.imageId = img.image_id;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'image-thumb-wrap';
    const thumb = document.createElement('img');
    thumb.className = 'image-thumb';
    thumb.loading = 'lazy';
    thumb.src = imageUrl(img.relative_path);
    thumb.alt = img.filename;
    thumb.addEventListener('error', () => { thumb.classList.add('image-thumb-error'); }, { once: true });
    thumbWrap.appendChild(thumb);

    const fallback = document.createElement('div');
    fallback.className = 'image-thumb-fallback';
    fallback.textContent = 'Preview unavailable';
    thumbWrap.appendChild(fallback);

    const check = document.createElement('div');
    check.className = 'image-check';
    thumbWrap.appendChild(check);

    cell.appendChild(thumbWrap);

    const caption = document.createElement('div');
    caption.className = 'image-caption';
    caption.title = img.filename + (img.labeled_date ? ` — labeled ${new Date(img.labeled_date).toLocaleString()}` : '');
    if (img.label) {
      const badge = document.createElement('span');
      badge.className = 'badge pp-badge';
      badge.textContent = LABEL_TEXT[img.label] || img.label;
      caption.appendChild(badge);
    } else {
      const span = document.createElement('span');
      span.className = 'text-muted';
      span.textContent = 'Unlabeled';
      caption.appendChild(span);
    }
    cell.appendChild(caption);

    cell.addEventListener('click', () => toggleSelection(img.image_id));
    grid.appendChild(cell);
  });
}

function toggleSelection(imageId) {
  if (state.selected.has(imageId)) state.selected.delete(imageId);
  else state.selected.add(imageId);
  const cell = document.querySelector(`.image-cell[data-image-id="${CSS.escape(imageId)}"]`);
  if (cell) cell.classList.toggle('selected', state.selected.has(imageId));
  renderSelectionCount();
}

function renderSelectionCount() {
  const n = state.selected.size;
  document.getElementById('selection-count').textContent = `${n} selected`;
  document.querySelectorAll('.label-btn').forEach(btn => { btn.disabled = n === 0 || state.saving; });
}

function renderPagination(totalFiltered, pageCount) {
  document.getElementById('workspace-pagination-info').textContent =
    totalFiltered === 0 ? 'No images match this filter' : `Showing page ${state.page} of ${pageCount} (${totalFiltered} images)`;

  const container = document.getElementById('workspace-pagination-container');
  container.innerHTML = '';
  const mkBtn = (label, page, disabled, active) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = disabled;
    if (active) b.className = 'active';
    b.addEventListener('click', () => { state.page = page; renderWorkspace(); });
    return b;
  };
  container.appendChild(mkBtn('‹ Prev', state.page - 1, state.page <= 1, false));
  const windowSize = 5;
  let startPage = Math.max(1, state.page - Math.floor(windowSize / 2));
  const endPage = Math.min(pageCount, startPage + windowSize - 1);
  startPage = Math.max(1, endPage - windowSize + 1);
  for (let p = startPage; p <= endPage; p++) container.appendChild(mkBtn(String(p), p, false, p === state.page));
  container.appendChild(mkBtn('Next ›', state.page + 1, state.page >= pageCount, false));
}

// 5. Applying labels

async function applyLabel(value) {
  if (state.saving || state.selected.size === 0) return;
  state.saving = true;
  renderSelectionCount();

  const ids = Array.from(state.selected);
  // Chunked so a large cross-page selection can't build one oversized request
  // (image_id is a 16-char hex string, so a few hundred per request is safe).
  const BATCH_SIZE = 200;
  try {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await sb.from('images').update({ label: value }).in('image_id', batch);
      if (error) throw error;
    }

    const now = new Date().toISOString();
    const byId = new Map(state.folderImages.map(img => [img.image_id, img]));
    ids.forEach(id => {
      const img = byId.get(id);
      if (img) { img.label = value; img.labeled_date = value ? now : null; }
    });

    const folderRow = state.folders.find(f => f.folder_name === state.currentFolder);
    if (folderRow) {
      const labeledNow = state.folderImages.filter(img => img.label).length;
      folderRow.labeled_count = labeledNow;
      folderRow.unlabeled_count = folderRow.image_count - labeledNow;
      folderRow.pct_labeled = folderRow.image_count
        ? Math.round(1000 * labeledNow / folderRow.image_count) / 10 : 0;
    }

    state.selected.clear();
    showMessage(
      `${value ? `Labeled ${ids.length} image(s) as "${LABEL_TEXT[value] || value}"` : `Cleared the label on ${ids.length} image(s)`}.`,
      'success');
    renderWorkspace();
    populateFolderPicker();
    // Refresh the global counters in the background; don't block the UI on it.
    loadProgress();
  } catch (err) {
    console.error('Error applying label:', err);
    showMessage(`Couldn't save the label: ${describeError(err)}`, 'error');
  } finally {
    state.saving = false;
    renderSelectionCount();
  }
}

// 6. Messages

function describeError(err) {
  const message = (err && err.message) || String(err);
  const hint = err && err.hint ? ` ${err.hint}` : '';
  return (window.Auth ? Auth.friendlyError(message.replace(/\.?$/, '.')) : message) + hint;
}

function showMessage(text, kind) {
  const box = document.getElementById('labeling-message');
  box.textContent = text;
  box.className = `alert alert-${kind}`;
  box.hidden = false;
}

function hideMessage() {
  document.getElementById('labeling-message').hidden = true;
}

// 7. Initialization

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('labeling-signin-btn').addEventListener('click', () => Auth.openSignIn('signin'));

  document.getElementById('folder-select').addEventListener('change', (e) => selectFolder(e.target.value));
  document.getElementById('hide-complete-checkbox').addEventListener('change', populateFolderPicker);
  document.getElementById('least-labeled-first-checkbox').addEventListener('change', populateFolderPicker);

  document.getElementById('image-filter-select').addEventListener('change', (e) => {
    state.filter = e.target.value;
    state.page = 1;
    renderWorkspace();
  });
  document.getElementById('workspace-page-size').addEventListener('change', (e) => {
    state.pageSize = parseInt(e.target.value, 10);
    state.page = 1;
    renderWorkspace();
  });
  document.getElementById('select-page-btn').addEventListener('click', () => {
    const filtered = getFilteredFolderImages();
    const start = (state.page - 1) * state.pageSize;
    filtered.slice(start, start + state.pageSize).forEach(img => state.selected.add(img.image_id));
    renderGrid(filtered.slice(start, start + state.pageSize));
    renderSelectionCount();
  });
  document.getElementById('clear-selection-btn').addEventListener('click', () => {
    state.selected.clear();
    renderGrid(getFilteredFolderImages().slice(
      (state.page - 1) * state.pageSize, (state.page - 1) * state.pageSize + state.pageSize));
    renderSelectionCount();
  });

  // Number-key shortcuts apply the matching label to the current selection,
  // unless the user is typing somewhere (a select, a future search box, etc).
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const opt = LABEL_OPTIONS.find(o => o.key === e.key);
    if (opt) applyLabel(opt.value);
  });

  Auth.ready.then(auth => {
    renderForUser(auth);
    Auth.onChange(renderForUser);
  });
});
