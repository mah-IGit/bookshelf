#!/usr/bin/env python3
"""
Build catalog.json for the Bookshelf library repo.

Walks the library folder, parses the Kindle-style filenames
("[Genre] Title - Author.pdf"), and writes a catalog the app can read.
Also flags anything GitHub will refuse to accept.

Usage:
    python3 build_catalog.py ~/Desktop/bookshelf-library
"""

import hashlib
import json
import os
import re
import sys

GITHUB_HARD_LIMIT = 100 * 1024 * 1024   # push is rejected outright
GITHUB_WARN_LIMIT = 50 * 1024 * 1024    # push succeeds with a warning
EXTS = {".pdf": "pdf", ".epub": "epub"}

# "[Genre] Title - Author"  /  "[Genre · Sub] Title"  /  "Title - Author"
BRACKET = re.compile(r"^\[(?P<tag>[^\]]+)\]\s*(?P<rest>.+)$")


def clean(text):
    text = re.sub(r"\s*\(\s*(z-library|z-lib\.org|pdfdrive|oceanofpdf(\.com)?)\s*\)", "", text, flags=re.I)
    text = re.sub(r"_?(text|images?)-?\d*$", "", text, flags=re.I)
    text = re.sub(r"\s*\(\d+\)$", "", text)          # "(1)" duplicate suffix
    text = re.sub(r"[_\-]{2,}", " ", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip(" -_.")


def parse(stem, folder):
    tag = folder
    rest = stem

    m = BRACKET.match(stem)
    if m:
        tag = m.group("tag").strip()
        rest = m.group("rest").strip()

    author = ""
    # Split on the LAST " - " so titles containing a dash survive.
    if " - " in rest:
        head, tail = rest.rsplit(" - ", 1)
        # An "author" with too many words is probably part of the title.
        if 1 <= len(tail.split()) <= 5:
            rest, author = head, tail

    title = clean(rest)
    if not title:
        title = clean(stem) or stem

    return title, clean(author), tag


def main():
    root = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Desktop/bookshelf-library")
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        sys.exit(f"Not a directory: {root}")

    books, oversized, large, seen = [], [], [], {}

    for dirpath, dirnames, filenames in os.walk(root):
        # Skip Kindle sidecar folders and anything hidden or git-internal.
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not d.endswith(".sdr")]
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            stem, ext = os.path.splitext(name)
            fmt = EXTS.get(ext.lower())
            if not fmt:
                continue

            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            size = os.path.getsize(full)

            if size >= GITHUB_HARD_LIMIT:
                oversized.append((rel, size))
                continue                      # cannot be pushed, leave it out
            if size >= GITHUB_WARN_LIMIT:
                large.append((rel, size))

            folder = os.path.basename(dirpath) if dirpath != root else ""
            title, author, category = parse(stem, folder)

            # Same title+author twice? Keep the bigger file, it's usually the better scan.
            key = (title.lower(), author.lower())
            if key in seen:
                prev = seen[key]
                if size <= prev["bytes"]:
                    continue
                books.remove(prev)

            entry = {
                "id": hashlib.sha1(rel.encode("utf-8")).hexdigest()[:12],
                "title": title,
                "author": author,
                "category": category,
                "format": fmt,
                "path": rel,
                "bytes": size,
            }
            books.append(entry)
            seen[key] = entry

    books.sort(key=lambda b: (b["category"].lower(), b["title"].lower()))

    out = os.path.join(root, "catalog.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "books": books}, fh, indent=2, ensure_ascii=False)

    total = sum(b["bytes"] for b in books)
    print(f"catalog.json written: {len(books)} books, {total / 1048576:.0f} MB")

    by_cat = {}
    for b in books:
        by_cat[b["category"]] = by_cat.get(b["category"], 0) + 1
    for cat, n in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"  {cat or '(none)':<22} {n}")

    if large:
        print(f"\n{len(large)} file(s) over 50MB — these push fine but slowly:")
        for rel, size in large:
            print(f"  {size / 1048576:6.0f} MB  {rel}")

    if oversized:
        print(f"\nEXCLUDED — over GitHub's 100MB hard limit, these cannot be pushed:")
        for rel, size in oversized:
            print(f"  {size / 1048576:6.0f} MB  {rel}")
        print("  Shrink them or keep them on the device only.")


if __name__ == "__main__":
    main()
