"""
vault_index.py — Scan an Obsidian vault and build a read-only note + link index.

Nothing here ever writes to the vault. Every public path is validated against the
vault root so a crafted request can't escape it.
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# Directories we never descend into. Beyond these, any folder whose name starts
# with "." or "_" is skipped too (covers _backend, _research, and future scaffolding).
# These are vault-management / naming-convention areas, not knowledge notes.
IGNORE_DIRS = {".git", ".obsidian", ".claude", ".trash", "node_modules",
               "scratch_preview", "Vault Changelog"}

# Individual meta files to hide (naming-convention / vault-organization docs).
IGNORE_FILES = {"CLAUDE.md", "README.md"}

# Obsidian markdown patterns.
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
# Embeds first (leading !), then plain links. [[Target#heading|alias]]
EMBED_RE = re.compile(r"!\[\[([^\]]+?)\]\]")
WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]]+?)\]\]")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)
# Fenced code blocks — stripped before scanning for links/headings so code samples
# containing [[ or # don't pollute the graph or outline.
FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def _slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_]+", "-", text)


@dataclass
class Note:
    # Vault-relative path, POSIX style, without leading slash. This is the note id.
    rel: str
    title: str
    folder: str
    name: str  # basename without extension
    mtime: float
    size: int
    tags: list[str] = field(default_factory=list)
    type: str = ""
    status: str = ""
    related: list[str] = field(default_factory=list)  # raw target strings from frontmatter
    headings: list[dict] = field(default_factory=list)  # {level, text, slug}
    out_targets: list[str] = field(default_factory=list)  # raw wikilink targets in body

    # Resolved after the whole vault is scanned.
    out_links: list[str] = field(default_factory=list)  # rel paths this note points to
    unresolved: list[str] = field(default_factory=list)  # link display names with no target
    backlinks: list[str] = field(default_factory=list)  # rel paths pointing at this note

    def public(self) -> dict:
        return {
            "rel": self.rel,
            "title": self.title,
            "folder": self.folder,
            "name": self.name,
            "mtime": self.mtime,
            "size": self.size,
            "tags": self.tags,
            "type": self.type,
            "status": self.status,
            "outLinks": self.out_links,
            "backlinks": self.backlinks,
        }


def _clean_target(raw: str) -> tuple[str, str]:
    """Split '[[Target#Heading|Alias]]' into (target_without_alias_or_heading, display)."""
    display = raw
    if "|" in raw:
        target, display = raw.split("|", 1)
    else:
        target = raw
    display = display.strip()
    # Drop heading/block anchors from the resolution target.
    target = target.split("#", 1)[0].split("^", 1)[0].strip()
    return target, display


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    try:
        data = yaml.safe_load(m.group(1)) or {}
        if not isinstance(data, dict):
            data = {}
    except yaml.YAMLError:
        data = {}
    return data, text[m.end():]


def _as_list(value) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        # Support comma-separated inline strings just in case.
        return [p.strip() for p in value.split(",") if p.strip()]
    return [str(value).strip()]


class VaultIndex:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self._lock = threading.Lock()
        self.notes: dict[str, Note] = {}          # rel -> Note
        self._by_name: dict[str, list[str]] = {}  # lowercased basename -> [rel, ...]
        self._by_rel_lower: dict[str, str] = {}   # lowercased rel (no ext) -> rel
        self._signature: tuple = ()               # cheap change-detection fingerprint

    # ---- filesystem helpers (path-traversal safe) -------------------------

    def safe_path(self, rel: str) -> Path | None:
        """Resolve a vault-relative path, returning None if it escapes the root."""
        if not rel:
            return None
        candidate = (self.root / rel).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError:
            return None
        return candidate

    def _iter_md_files(self):
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames
                           if d not in IGNORE_DIRS and not d.startswith(".") and not d.startswith("_")]
            for fn in filenames:
                if fn.endswith(".md") and fn not in IGNORE_FILES:
                    yield Path(dirpath) / fn

    def _fingerprint(self) -> tuple:
        """A quick signature (paths + mtimes) to decide whether a rescan is needed."""
        items = []
        for p in self._iter_md_files():
            try:
                items.append((str(p), p.stat().st_mtime))
            except OSError:
                continue
        items.sort()
        return tuple(items)

    # ---- scanning ---------------------------------------------------------

    def refresh_if_stale(self):
        sig = self._fingerprint()
        if sig != self._signature:
            with self._lock:
                if sig != self._signature:  # re-check inside lock
                    self._scan()
                    self._signature = sig

    def ensure_loaded(self):
        if not self.notes:
            self.refresh_if_stale()

    def _scan(self):
        notes: dict[str, Note] = {}
        by_name: dict[str, list[str]] = {}
        by_rel_lower: dict[str, str] = {}

        for path in self._iter_md_files():
            try:
                raw = path.read_text(encoding="utf-8", errors="replace")
                st = path.stat()
            except OSError:
                continue
            rel = path.relative_to(self.root).as_posix()
            fm, body = _parse_frontmatter(raw)

            name = path.stem
            folder = path.parent.relative_to(self.root).as_posix()
            folder = "" if folder == "." else folder

            # Strip code so it doesn't feed the graph/outline.
            scan_body = INLINE_CODE_RE.sub(" ", FENCE_RE.sub(" ", body))

            # Title: first H1, else filename.
            title = name
            for lvl, htext in HEADING_RE.findall(scan_body):
                if len(lvl) == 1:
                    title = htext.strip()
                    break

            headings = [
                {"level": len(lvl), "text": htext.strip(), "slug": _slugify(htext)}
                for lvl, htext in HEADING_RE.findall(scan_body)
            ]

            out_targets = []
            for raw_link in WIKILINK_RE.findall(scan_body):
                out_targets.append(raw_link)
            for raw_link in EMBED_RE.findall(scan_body):
                out_targets.append(raw_link)

            related_raw = _as_list(fm.get("related"))
            related = []
            for r in related_raw:
                m = re.match(r"\[\[([^\]]+)\]\]", r.strip())
                related.append(m.group(1) if m else r.strip())

            note = Note(
                rel=rel,
                title=title,
                folder=folder,
                name=name,
                mtime=st.st_mtime,
                size=st.st_size,
                tags=_as_list(fm.get("tags")),
                type=str(fm.get("type", "")).strip(),
                status=str(fm.get("status", "")).strip(),
                related=related,
                headings=headings,
                out_targets=out_targets,
            )
            notes[rel] = note
            by_name.setdefault(name.lower(), []).append(rel)
            by_rel_lower[rel.lower().removesuffix(".md")] = rel

        # Resolve links now that every note is known.
        self.notes = notes
        self._by_name = by_name
        self._by_rel_lower = by_rel_lower
        self._resolve_links()

    def _resolve_target(self, raw: str) -> str | None:
        """Obsidian-style resolution: try full relative path, then basename."""
        target, _ = _clean_target(raw)
        if not target:
            return None
        key = target.lower().removesuffix(".md")
        # Full/partial path match.
        if key in self._by_rel_lower:
            return self._by_rel_lower[key]
        # Basename match (shortest path wins for stability).
        base = key.split("/")[-1]
        candidates = self._by_name.get(base)
        if candidates:
            return sorted(candidates, key=lambda r: (r.count("/"), len(r)))[0]
        return None

    def _resolve_links(self):
        backlinks: dict[str, set[str]] = {rel: set() for rel in self.notes}
        for rel, note in self.notes.items():
            resolved: list[str] = []
            unresolved: list[str] = []
            seen = set()
            for raw in note.out_targets:
                tgt = self._resolve_target(raw)
                if tgt and tgt != rel:
                    if tgt not in seen:
                        seen.add(tgt)
                        resolved.append(tgt)
                        backlinks[tgt].add(rel)
                elif tgt is None:
                    _, display = _clean_target(raw)
                    name = display or raw
                    if name not in unresolved:
                        unresolved.append(name)
            note.out_links = resolved
            note.unresolved = unresolved
        for rel, note in self.notes.items():
            note.backlinks = sorted(backlinks[rel])

    # ---- API payload builders --------------------------------------------

    def index_payload(self) -> dict:
        self.ensure_loaded()
        notes = [n.public() for n in self.notes.values()]
        notes.sort(key=lambda n: n["rel"].lower())
        # Undirected edge list for the graph (dedup A-B / B-A).
        edges = set()
        for n in self.notes.values():
            for tgt in n.out_links:
                a, b = sorted((n.rel, tgt))
                edges.add((a, b))
        # Facet tallies for the filter UI.
        tag_counts: dict[str, int] = {}
        type_counts: dict[str, int] = {}
        status_counts: dict[str, int] = {}
        for n in self.notes.values():
            for t in n.tags:
                tag_counts[t] = tag_counts.get(t, 0) + 1
            if n.type:
                type_counts[n.type] = type_counts.get(n.type, 0) + 1
            if n.status:
                status_counts[n.status] = status_counts.get(n.status, 0) + 1
        return {
            "vaultName": self.root.name,
            "count": len(notes),
            "notes": notes,
            "edges": [list(e) for e in edges],
            "facets": {
                "tags": tag_counts,
                "types": type_counts,
                "statuses": status_counts,
            },
        }

    def note_payload(self, rel: str) -> dict | None:
        self.ensure_loaded()
        note = self.notes.get(rel)
        path = self.safe_path(rel)
        if note is None or path is None or not path.is_file():
            return None
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        _, body = _parse_frontmatter(raw)

        def brief(r: str) -> dict:
            m = self.notes.get(r)
            return {"rel": r, "title": m.title if m else r, "folder": m.folder if m else ""}

        related_resolved = []
        for r in note.related:
            tgt = self._resolve_target(r)
            related_resolved.append(brief(tgt) if tgt else {"rel": None, "title": r, "folder": ""})

        return {
            "rel": note.rel,
            "title": note.title,
            "folder": note.folder,
            "name": note.name,
            "mtime": note.mtime,
            "tags": note.tags,
            "type": note.type,
            "status": note.status,
            "markdown": body,
            "headings": note.headings,
            "backlinks": [brief(r) for r in note.backlinks],
            "related": related_resolved,
            "outLinks": [brief(r) for r in note.out_links],
            "unresolved": note.unresolved,
            # Map of link target -> resolved rel, so the client can turn [[x]] into links.
            "linkMap": self._link_map_for(note),
        }

    def _link_map_for(self, note: Note) -> dict:
        mapping = {}
        for raw in note.out_targets + note.related:
            target, _ = _clean_target(raw)
            if target and target not in mapping:
                tgt = self._resolve_target(raw)
                mapping[target] = tgt  # may be None (unresolved)
        return mapping

    def search(self, query: str, limit: int = 40) -> list[dict]:
        self.ensure_loaded()
        q = query.strip()
        if not q:
            return []
        ql = q.lower()
        results = []
        for note in self.notes.values():
            path = self.safe_path(note.rel)
            if path is None:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            _, body = _parse_frontmatter(text)
            body_l = body.lower()
            title_l = note.title.lower()
            score = 0
            if ql in title_l:
                score += 100 - title_l.index(ql)
            if note.name.lower().startswith(ql):
                score += 40
            hits = body_l.count(ql)
            score += hits
            for tag in note.tags:
                if ql in tag.lower():
                    score += 8
            if score <= 0:
                continue
            snippet = self._snippet(body, ql)
            results.append({
                "rel": note.rel,
                "title": note.title,
                "folder": note.folder,
                "type": note.type,
                "score": score,
                "hits": hits,
                "snippet": snippet,
            })
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:limit]

    @staticmethod
    def _snippet(body: str, ql: str, radius: int = 90) -> str:
        low = body.lower()
        idx = low.find(ql)
        if idx == -1:
            return body.strip()[:160]
        start = max(0, idx - radius)
        end = min(len(body), idx + len(ql) + radius)
        chunk = body[start:end].replace("\n", " ").strip()
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(body) else ""
        return f"{prefix}{chunk}{suffix}"
