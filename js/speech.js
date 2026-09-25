// Read-aloud using the browser's built-in speech engine.
// No API key, no network, no cost. Works on any book with a real text layer;
// a scanned book is just photographs of pages, so there is nothing to read.

const synth = window.speechSynthesis;

export function isSupported() {
  return typeof synth !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

/**
 * Split into sentence-sized chunks.
 * Two reasons: Chrome silently cuts off utterances after ~15s, and short
 * chunks make stopping feel immediate instead of waiting out a paragraph.
 */
function toChunks(text) {
  const clean = String(text || '')
    .replace(/\s*\n\s*/g, ' ')      // PDFs break lines mid-sentence
    .replace(/([a-z])-\s+([a-z])/g, '$1$2')  // rejoin hyphenated line breaks
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [clean];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    // Batch very short fragments together; split anything oversized.
    if (buf.length + s.length < 220) {
      buf += s;
    } else {
      if (buf.trim()) out.push(buf.trim());
      buf = s.length > 400 ? '' : s;
      if (s.length > 400) {
        for (let i = 0; i < s.length; i += 400) out.push(s.slice(i, i + 400).trim());
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

export function createReaderVoice() {
  let chunks = [];
  let index = 0;
  let playing = false;
  let rate = 1;
  let voice = null;
  let handlers = {};
  let stopping = false;

  // Voices load asynchronously in most browsers.
  function pickVoice() {
    const all = synth.getVoices();
    if (!all.length) return null;
    const lang = (navigator.language || 'en-US').toLowerCase();
    return (
      all.find((v) => v.lang.toLowerCase() === lang && v.localService) ||
      all.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)) && v.localService) ||
      all.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2))) ||
      all[0]
    );
  }
  if (isSupported()) {
    voice = pickVoice();
    synth.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
  }

  function speakNext() {
    if (!playing || stopping) return;

    if (index >= chunks.length) {
      // Page exhausted: ask the reader for the next one.
      handlers.onNeedMore?.().then((more) => {
        if (!playing) return;
        const next = toChunks(more);
        if (!next.length) {
          stop();
          handlers.onEnd?.();
          return;
        }
        chunks = next;
        index = 0;
        speakNext();
      }).catch(() => { stop(); handlers.onEnd?.(); });
      return;
    }

    const u = new SpeechSynthesisUtterance(chunks[index]);
    u.rate = rate;
    u.pitch = 1;
    if (voice) u.voice = voice;

    u.onend = () => {
      if (!playing || stopping) return;
      index += 1;
      handlers.onProgress?.(index, chunks.length);
      speakNext();
    };
    u.onerror = (e) => {
      // 'interrupted' and 'canceled' are what our own stop() produces.
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      index += 1;
      speakNext();
    };

    synth.speak(u);
  }

  function start(text, h = {}) {
    handlers = h;
    stop();
    stopping = false;
    chunks = toChunks(text);
    if (!chunks.length) {
      handlers.onNoText?.();
      return false;
    }
    index = 0;
    playing = true;
    speakNext();
    return true;
  }

  function stop() {
    stopping = true;
    playing = false;
    try { synth.cancel(); } catch { /* nothing queued */ }
    stopping = false;
  }

  return {
    start,
    stop,
    isPlaying: () => playing,
    setRate(r) {
      rate = r;
      if (playing) {
        // Rate only applies to new utterances, so restart from the current chunk.
        const resumeAt = index;
        const text = chunks.slice(resumeAt).join(' ');
        const h = handlers;
        stop();
        chunks = toChunks(text);
        index = 0;
        playing = true;
        handlers = h;
        speakNext();
      }
    },
    getRate: () => rate,
  };
}
