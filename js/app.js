import * as gh from './github.js';
import * as store from './storage.js';
import { createEpubReader, createPdfReader } from './reader.js';

const $ = (id) => document.getElementById(id);
const CATALOG_PATH = 'catalog.json';
const PROGRESS_PATH = 'progress.json';

const state = {
  books: [],
  progress: {},
  progressSha: null,
  filter: 'all',
  query: '',
  reader: null,
  current: null,
  theme: localStorage.getItem('bookshelf.theme') || 'auto',
  fontSize: Number(localStorage.getItem('bookshelf.fontSize')) || 100,
  chromeHidden: false,
  saveTimer: null,
};

/* ---------------------------- toast ---------------------------- */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('status');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------------------- library ---------------------------- */

function progressFor(id) {
  return state.progress[id] || null;
}

function matchesFilter(book) {
  const p = progressFor(book.id);
  const pct = p?.pct || 0;
  switch (state.filter) {
    case 'reading': return pct > 0.01 && pct < 0.97;
    case 'unread': return pct <= 0.01;
    case 'finished': return pct >= 0.97;
    case 'epub': return book.format === 'epub';
    case 'pdf': return book.format === 'pdf';
    default: return true;
  }
}

function matchesQuery(book) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (book.title + ' ' + (book.author || '') + ' ' + (book.category || '')).toLowerCase().includes(q);
}

function renderLibrary() {
  const grid = $('grid');
  const visible = state.books.filter((b) => matchesFilter(b) && matchesQuery(b));

  if (!state.books.length) {
    grid.innerHTML = '';
    $('empty').classList.remove('hidden');
    return;
  }
  $('empty').classList.add('hidden');

  if (!visible.length) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:14px;grid-column:1/-1;padding:32px 0;text-align:center">Nothing matches.</p>';
    return;
  }

  grid.innerHTML = visible.map((b) => {
    const p = progressFor(b.id);
    const pct = Math.round((p?.pct || 0) * 100);
    const cover = b.cover
      ? `<img src="${b.cover}" alt="" loading="lazy">`
      : `<div class="cover-fallback">${escapeHtml(b.title)}</div>`;
    return `
      <article class="card" data-id="${b.id}">
        <div class="cover">
          ${cover}
          <span class="badge">${b.format}</span>
          ${pct > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        </div>
        <div class="meta">
          <div class="title">${escapeHtml(b.title)}</div>
          <div class="author">${escapeHtml(b.author || b.category || '')}</div>
        </div>
      </article>`;
  }).join('');

  grid.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => openBook(card.dataset.id));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------------------- sync ---------------------------- */

async function sync({ quiet = false } = {}) {
  if (!gh.isConfigured()) {
    if (!quiet) openSettings();
    return;
  }
  try {
    if (!quiet) toast('Syncing…');

    const catalog = await gh.readJson(CATALOG_PATH);
    if (catalog) {
      state.books = catalog.data.books || [];
      await store.meta.put('catalog', state.books);
    }

    const remote = await gh.readJson(PROGRESS_PATH);
    const local = await store.allProgress();
    const merged = store.mergeProgress(local, remote?.data || {});
    state.progress = merged;
    state.progressSha = remote?.sha || null;
    await store.replaceProgress(merged);

    // Only write back when we actually have something the remote lacks.
    if (JSON.stringify(merged) !== JSON.stringify(remote?.data || {})) {
      state.progressSha = await gh.writeJson(PROGRESS_PATH, merged, state.progressSha, 'Sync reading progress');
    }

    renderLibrary();
    if (!quiet) toast(`${state.books.length} books, synced`);
  } catch (err) {
    toast(err.message, 4200);
  }
}

// Debounced so flipping pages doesn't spam commits.
function queueProgressPush() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    if (!gh.isConfigured()) return;
    try {
      const remote = await gh.readJson(PROGRESS_PATH);
      const merged = store.mergeProgress(await store.allProgress(), remote?.data || {});
      state.progressSha = await gh.writeJson(PROGRESS_PATH, merged, remote?.sha || null, 'Sync reading progress');
      state.progress = merged;
    } catch { /* offline is fine, it'll go up on the next sync */ }
  }, 8000);
}

/* ---------------------------- reader ---------------------------- */

async function openBook(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;

  state.current = book;
  $('view-library').classList.remove('active');
  $('view-reader').classList.add('active');
  $('reader-title').textContent = book.title;
  $('reader-loading').classList.remove('hidden');
  $('reader-loading-text').textContent = 'Loading';
  $('epub-host').classList.add('hidden');
  $('pdf-host').classList.add('hidden');

  try {
    let buffer = await store.files.get(book.id);
    if (!buffer) {
      buffer = await gh.fetchFile(book.path, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        $('reader-loading-text').textContent = total
          ? `Downloading ${pct}%`
          : `Downloading ${store.formatBytes(got)}`;
      });
      if (gh.getConfig().cache !== false) {
        try { await store.files.put(book.id, buffer); } catch { toast('Downloaded, but too big to keep offline'); }
      }
    }

    const host = book.format === 'epub' ? $('epub-host') : $('pdf-host');
    host.classList.remove('hidden');
    state.reader = book.format === 'epub' ? createEpubReader(host) : createPdfReader(host);

    const saved = progressFor(book.id);
    await state.reader.open(buffer, saved?.pos, {
      theme: effectiveTheme(),
      fontSize: state.fontSize,
      onTapCenter: toggleChrome,
      onChange: ({ pos, pct, label }) => {
        $('seek').value = String(Math.round((pct || 0) * 1000));
        $('pageinfo').textContent = label || `${Math.round((pct || 0) * 100)}%`;
        store.setProgress(book.id, { pos, pct }).then((all) => { state.progress = all; });
        queueProgressPush();
      },
    });

    $('reader-loading').classList.add('hidden');
  } catch (err) {
    $('reader-loading').classList.add('hidden');
    toast(err.message, 5000);
    closeBook();
  }
}

function closeBook() {
  state.reader?.destroy();
  state.reader = null;
  state.current = null;
  $('view-reader').classList.remove('active');
  $('view-library').classList.add('active');
  showChrome();
  renderLibrary();
  // Push immediately on close rather than waiting out the debounce.
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {}, 0);
  queueProgressPush();
}

function toggleChrome() {
  state.chromeHidden = !state.chromeHidden;
  $('reader-top').classList.toggle('faded', state.chromeHidden);
  $('reader-bottom').classList.toggle('faded', state.chromeHidden);
}
function showChrome() {
  state.chromeHidden = false;
  $('reader-top').classList.remove('faded');
  $('reader-bottom').classList.remove('faded');
}

/* ---------------------------- theme ---------------------------- */

function effectiveTheme() {
  if (state.theme !== 'auto') return state.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('bookshelf.theme', state.theme);
  state.reader?.setTheme(effectiveTheme(), state.fontSize);
}

/* ---------------------------- settings ---------------------------- */

function openSettings() {
  const c = gh.getConfig();
  $('cfg-owner').value = c.owner || '';
  $('cfg-repo').value = c.repo || 'bookshelf-library';
  $('cfg-token').value = c.token || '';
  $('cfg-cache').checked = c.cache !== false;
  $('cfg-msg').textContent = '';
  $('cfg-msg').className = 'msg';
  store.cacheSize().then((n) => {
    $('cache-info').textContent = `${store.formatBytes(n)} of books kept on this device.`;
  });
  $('modal-settings').classList.remove('hidden');
}

function readSettingsForm() {
  return {
    owner: $('cfg-owner').value.trim(),
    repo: $('cfg-repo').value.trim(),
    token: $('cfg-token').value.trim(),
    cache: $('cfg-cache').checked,
  };
}

function setMsg(text, kind) {
  const el = $('cfg-msg');
  el.textContent = text;
  el.className = `msg ${kind || ''}`;
}

/* ---------------------------- wiring ---------------------------- */

function init() {
  applyTheme();

  $('btn-settings').addEventListener('click', openSettings);
  $('empty-settings').addEventListener('click', openSettings);
  $('cfg-close').addEventListener('click', () => $('modal-settings').classList.add('hidden'));

  $('cfg-save').addEventListener('click', async () => {
    gh.setConfig(readSettingsForm());
    setMsg('Saved.', 'ok');
    $('modal-settings').classList.add('hidden');
    await sync();
  });

  $('cfg-test').addEventListener('click', async () => {
    gh.setConfig(readSettingsForm());
    setMsg('Checking…');
    try {
      const info = await gh.testConnection();
      setMsg(`Connected to ${info.full_name}${info.private ? ' (private)' : ' — warning: this repo is public'}.`, 'ok');
    } catch (err) {
      setMsg(err.message, 'err');
    }
  });

  $('cfg-clear').addEventListener('click', async () => {
    await store.files.clear();
    $('cache-info').textContent = '0 MB of books kept on this device.';
    toast('Offline copies cleared');
  });

  $('btn-sync').addEventListener('click', () => sync());

  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderLibrary();
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderLibrary();
    });
  });

  $('btn-back').addEventListener('click', closeBook);
  $('btn-next').addEventListener('click', () => state.reader?.next());
  $('btn-prev').addEventListener('click', () => state.reader?.prev());
  $('seek').addEventListener('change', (e) => state.reader?.gotoPercent(Number(e.target.value) / 1000));

  $('btn-theme').addEventListener('click', () => {
    state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme];
    applyTheme();
    toast(`Theme: ${state.theme}`, 1400);
  });

  $('btn-font').addEventListener('click', () => {
    state.fontSize = state.fontSize >= 160 ? 80 : state.fontSize + 20;
    localStorage.setItem('bookshelf.fontSize', String(state.fontSize));
    state.reader?.setTheme(effectiveTheme(), state.fontSize);
    toast(`Text ${state.fontSize}%`, 1400);
  });

  document.addEventListener('keydown', (e) => {
    if (!$('view-reader').classList.contains('active')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); state.reader?.next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); state.reader?.prev(); }
    if (e.key === 'Escape') closeBook();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  // Paint from cache first so the library is instant, then reconcile with GitHub.
  (async () => {
    state.books = (await store.meta.get('catalog')) || [];
    state.progress = await store.allProgress();
    renderLibrary();
    if (gh.isConfigured()) sync({ quiet: true });
    else if (!state.books.length) openSettings();
  })();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
  }
}

init();
