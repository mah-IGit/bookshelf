# Bookshelf

A colour ePub and PDF reader for phone and laptop. No build step, no server, no monthly bill.

The app is static files on GitHub Pages. The library lives in a **separate private repo**, which doubles as the file store and the sync store: books are fetched through the GitHub API, and reading position is a `progress.json` the app commits to as you read.

## Why two repos

GitHub Pages only publishes from a **public** repo on the free plan. Your books are not going in a public repo, so:

| Repo | Visibility | Holds |
|---|---|---|
| `mah-IGit/bookshelf` | public | this code, nothing personal |
| `mah-IGit/Kindle2.0` | private | `catalog.json`, `progress.json`, the book files |

## Setup

1. Push this folder to the public `bookshelf` repo.
2. In that repo: **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.
3. Push your library folder to the private `Kindle2.0` repo.
4. Create a fine-grained personal access token at **github.com → Settings → Developer settings → Personal access tokens → Fine-grained**:
   - Repository access: **only** `Kindle2.0`
   - Permissions: **Contents: Read and write**
5. Open the Pages URL, hit the gear, enter your username, repo name, and token, then **Test connection**.
6. On iPhone: open the URL in Safari → Share → Add to Home Screen.

The token is stored in that browser's `localStorage` and is only ever sent to `api.github.com`. Enter it once per device.

## Rebuilding the catalog

After adding or removing books:

```bash
python3 tools/build_catalog.py ~/Desktop/bookshelf-library
```

It parses `[Genre] Title - Author.pdf` filenames, drops duplicates (keeping the larger file), skips Kindle `.sdr` sidecar folders, and refuses to list anything over GitHub's 100MB hard limit. Commit the regenerated `catalog.json` to the library repo.

## Limits worth knowing

- **100MB per file, hard.** GitHub rejects the push outright. The catalog builder excludes these and tells you which they are.
- **50MB per file** triggers a warning but still pushes.
- **Don't enable Git LFS.** Its free tier is 1GB and it bills after that. Avoiding LFS is the whole reason this stack costs nothing.
- Keep the library repo under roughly 1GB.

## Reading

| | |
|---|---|
| Tap left / right edge | Previous / next page |
| Tap centre | Hide the toolbars |
| Arrow keys, space | Turn pages |
| `Esc` | Back to library |
| `A` | Cycle text size (ePub) |
| ◐ | Cycle theme: auto → light → dark |

Books are cached in IndexedDB on first open, so re-reading works offline. Clear them under **Settings → Storage**.

## Stack

No npm, no bundler, no framework. Plain ES modules, `epub.js` and `pdf.js` pinned from jsDelivr. Edit a file, push, it's live.
