// Thin wrapper over the GitHub Contents API.
// The private library repo is both the file store and the sync store.

const CFG_KEY = 'bookshelf.config';
const API = 'https://api.github.com';

export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch {
    return {};
  }
}

export function setConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function isConfigured() {
  const c = getConfig();
  return Boolean(c.owner && c.repo && c.token);
}

function headers(accept = 'application/vnd.github+json') {
  const { token } = getConfig();
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function base() {
  const { owner, repo } = getConfig();
  return `${API}/repos/${owner}/${repo}/contents`;
}

async function fail(res) {
  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch { /* body wasn't json */ }

  if (res.status === 401) throw new Error('Token rejected. Check it hasn’t expired.');
  if (res.status === 403) throw new Error(detail.includes('rate limit') ? 'Rate limited by GitHub. Wait a minute.' : 'Token lacks permission on this repo.');
  if (res.status === 404) throw new Error('Repo or file not found. Check the username and repo name.');
  throw new Error(detail || `GitHub error ${res.status}`);
}

/** Verify credentials and repo access in one call. */
export async function testConnection() {
  const { owner, repo } = getConfig();
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers() });
  if (!res.ok) await fail(res);
  const info = await res.json();
  return { private: info.private, full_name: info.full_name };
}

/** Read and parse a JSON file from the repo. Returns { data, sha } or null when absent. */
export async function readJson(path) {
  const res = await fetch(`${base()}/${encodeURI(path)}?ref=HEAD`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) await fail(res);
  const meta = await res.json();
  // Content is base64 with newlines; decode as UTF-8, not latin-1.
  const bytes = Uint8Array.from(atob(meta.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0));
  const text = new TextDecoder('utf-8').decode(bytes);
  return { data: JSON.parse(text), sha: meta.sha };
}

/** Create or update a JSON file. Pass the sha from readJson to update in place. */
export async function writeJson(path, data, sha, message) {
  const text = JSON.stringify(data, null, 2);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const res = await fetch(`${base()}/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || `Update ${path}`,
      content: b64,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) await fail(res);
  const out = await res.json();
  return out.content.sha;
}

/**
 * Download a book file as an ArrayBuffer.
 * The raw media type streams the file directly and handles up to 100MB,
 * where the default JSON response caps out at 1MB.
 */
export async function fetchFile(path, onProgress) {
  const res = await fetch(`${base()}/${encodeURI(path)}`, {
    headers: headers('application/vnd.github.raw'),
  });
  if (!res.ok) await fail(res);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

/** List files under a directory in the repo. */
export async function listDir(path) {
  const res = await fetch(`${base()}/${encodeURI(path)}?ref=HEAD`, { headers: headers() });
  if (res.status === 404) return [];
  if (!res.ok) await fail(res);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}
