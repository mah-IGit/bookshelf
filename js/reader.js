// Two readers behind one interface: open(), goto(), next(), prev(), destroy().
// ePub is reflowable and paginated; PDF is fixed-layout and scrolls.

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

let pdfjsLib = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(PDFJS_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return pdfjsLib;
}

/* ============================ ePub ============================ */

export function createEpubReader(host) {
  let book = null;
  let rendition = null;
  let onChange = null;

  return {
    kind: 'epub',

    async open(buffer, startPos, handlers = {}) {
      onChange = handlers.onChange;
      book = window.ePub(buffer);
      rendition = book.renderTo(host, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
        allowScriptedContent: false,
      });

      applyTheme(rendition, handlers.theme, handlers.fontSize);
      await rendition.display(startPos || undefined);
      await book.locations.generate(1600);

      rendition.on('relocated', (loc) => {
        onChange?.({
          pos: loc.start.cfi,
          pct: book.locations.percentageFromCfi(loc.start.cfi) || 0,
          label: loc.start.displayed ? `${loc.start.displayed.page}/${loc.start.displayed.total}` : '',
        });
      });

      // Tapping the page edges turns pages; the middle toggles the chrome.
      rendition.on('click', (e) => {
        const w = host.clientWidth;
        if (e.clientX < w * 0.25) rendition.prev();
        else if (e.clientX > w * 0.75) rendition.next();
        else handlers.onTapCenter?.();
      });

      return { total: book.locations.total || 0 };
    },

    next() { rendition?.next(); },
    prev() { rendition?.prev(); },

    gotoPercent(p) {
      if (!book?.locations) return;
      const cfi = book.locations.cfiFromPercentage(Math.max(0, Math.min(1, p)));
      if (cfi) rendition.display(cfi);
    },

    setTheme(theme, fontSize) { applyTheme(rendition, theme, fontSize); },

    destroy() {
      try { rendition?.destroy(); book?.destroy(); } catch { /* already gone */ }
      book = null; rendition = null; host.innerHTML = '';
    },
  };
}

function applyTheme(rendition, theme, fontSize) {
  if (!rendition) return;
  const dark = theme === 'dark';
  rendition.themes.register('active', {
    body: {
      background: dark ? '#111318' : '#f6f5f3',
      color: dark ? '#e8e9ec' : '#16181d',
      'font-size': `${fontSize || 100}%`,
      'line-height': '1.65',
      padding: '0 6px',
    },
    a: { color: dark ? '#a78bfa' : '#7c3aed' },
    'img, image, svg': { 'max-width': '100%', height: 'auto' },
  });
  rendition.themes.select('active');
}

/* ============================ PDF ============================ */

export function createPdfReader(host) {
  let doc = null;
  let page = 1;
  let scale = 1;
  let onChange = null;
  let rendering = false;
  let canvases = [];

  async function renderAll() {
    if (!doc || rendering) return;
    rendering = true;
    host.innerHTML = '';
    canvases = [];

    // Fit width, capped so a desktop page doesn't render absurdly large.
    const first = await doc.getPage(1);
    const natural = first.getViewport({ scale: 1 });
    const avail = Math.min(host.clientWidth - 20, 900);
    const base = avail / natural.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (let n = 1; n <= doc.numPages; n++) {
      const canvas = document.createElement('canvas');
      canvas.dataset.page = String(n);
      host.appendChild(canvas);
      canvases.push(canvas);
    }
    rendering = false;
    scale = base * scale === 0 ? base : base;
    await renderVisible(base, dpr);
  }

  // Render lazily: only pages near the viewport, so a 600-page PDF still opens fast.
  async function renderVisible(base, dpr) {
    const tasks = canvases.map(async (canvas) => {
      const n = Number(canvas.dataset.page);
      const rect = canvas.getBoundingClientRect();
      const near = rect.top < window.innerHeight * 3 && rect.bottom > -window.innerHeight * 2;
      if (!near || canvas.dataset.done === '1') return;

      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: base });
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      canvas.dataset.done = '1';
    });
    await Promise.all(tasks);
  }

  let baseScale = 1;
  let dprCached = 1;

  function currentPageFromScroll() {
    const mid = host.scrollTop + host.clientHeight / 2;
    let acc = 0;
    for (let i = 0; i < canvases.length; i++) {
      const h = canvases[i].offsetHeight + 20;
      if (acc + h > mid) return i + 1;
      acc += h;
    }
    return canvases.length || 1;
  }

  const onScroll = () => {
    renderVisible(baseScale, dprCached);
    const p = currentPageFromScroll();
    if (p !== page) {
      page = p;
      onChange?.({ pos: String(page), pct: doc ? page / doc.numPages : 0, label: `${page}/${doc?.numPages || 0}` });
    }
  };

  return {
    kind: 'pdf',

    async open(buffer, startPos, handlers = {}) {
      onChange = handlers.onChange;
      const lib = await loadPdfJs();
      doc = await lib.getDocument({ data: buffer }).promise;

      const firstPage = await doc.getPage(1);
      const natural = firstPage.getViewport({ scale: 1 });
      baseScale = Math.min(host.clientWidth - 20, 900) / natural.width;
      dprCached = Math.min(window.devicePixelRatio || 1, 2);

      await renderAll();
      host.addEventListener('scroll', onScroll, { passive: true });

      page = Math.max(1, Math.min(doc.numPages, parseInt(startPos, 10) || 1));
      if (page > 1) this.gotoPage(page);
      onChange?.({ pos: String(page), pct: page / doc.numPages, label: `${page}/${doc.numPages}` });

      host.addEventListener('click', (e) => {
        const r = host.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x > r.width * 0.25 && x < r.width * 0.75) handlers.onTapCenter?.();
      });

      return { total: doc.numPages };
    },

    gotoPage(n) {
      const target = canvases[Math.max(0, Math.min(canvases.length - 1, n - 1))];
      if (target) host.scrollTo({ top: target.offsetTop - 10, behavior: 'auto' });
    },

    next() { this.gotoPage(page + 1); },
    prev() { this.gotoPage(page - 1); },
    gotoPercent(p) { if (doc) this.gotoPage(Math.max(1, Math.round(p * doc.numPages))); },
    setTheme() { /* PDFs are fixed-layout; the page keeps its own colors */ },

    destroy() {
      host.removeEventListener('scroll', onScroll);
      try { doc?.destroy(); } catch { /* already gone */ }
      doc = null; canvases = []; host.innerHTML = '';
    },
  };
}
