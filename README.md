# Gringotts Vault Viewer

A calm, good-looking web reader for the Obsidian notes in your vault
(`/home/jbarbosa/gringotts-vault`). View-only — it **never writes to your vault** —
and reads the folder **live**, so new and edited notes show up on refresh.

Built with the Python standard library (no `pip install`) and a no-build frontend.
The only third-party pieces are a few files vendored locally under `static/vendor/`
and `static/fonts/` (Space Grotesk + Geist + Geist Mono, self-hosted).

**Design:** a modern, cool-neutral system with a single indigo-violet accent,
light and dark themes. **What's shown:** only your knowledge notes — vault-management
areas are hidden (the `_backend/` templates & index, `Vault Changelog/`, `_research/`,
`scratch_preview/`, any folder starting with `_` or `.`, and `CLAUDE.md`).

## Run

```bash
./run.sh
```

Then open <http://127.0.0.1:8765>. Stop with `Ctrl-C`.

Point it at a different vault or port with environment variables:

```bash
VAULT_PATH=/path/to/vault PORT=9000 ./run.sh
```

## Features

- **Folder tree** mirroring the vault, with note counts.
- **Full-text search + command palette** — press <kbd>⌘K</kbd> (or <kbd>/</kbd>) to jump
  to any note by name or search across all content.
- **Wikilinks & backlinks** — `[[links]]` are clickable; each note shows what links back
  to it, plus its `related` frontmatter. Unresolved links are marked.
- **Graph view** — press <kbd>g</kbd> for an interactive force-directed map of the whole
  vault; every note also gets a small local graph of its neighbours.
- **Filters** — narrow the tree and graph by `type`, `status`, or `tag` from the frontmatter.
- **Obsidian rendering** — callouts (`> [!warning]` …), tables, task lists, code with syntax
  highlighting and copy buttons, and image/PDF embeds.
- **Light & dark themes** (press <kbd>t</kbd>), responsive down to mobile.

## Keyboard shortcuts

| Key | Action |
| --- | ------ |
| <kbd>⌘K</kbd> / <kbd>/</kbd> | Open search / command palette |
| <kbd>g</kbd> | Open the vault graph |
| <kbd>h</kbd> | Home |
| <kbd>t</kbd> | Toggle theme |
| <kbd>Esc</kbd> | Close palette / graph / mobile nav |

## How it works

- `server.py` — Python `http.server` on `127.0.0.1`. Serves the API, the static frontend,
  and vault assets (images/PDFs). Every path is confined to the vault root.
- `vault_index.py` — scans the vault, parses YAML frontmatter, resolves wikilinks
  Obsidian-style, and computes backlinks. Re-scans automatically when files change.
- `static/` — the frontend: `render.js` (markdown + Obsidian extensions), `sidebar.js`
  (tree + filters), `search.js` (palette), `graph.js` (canvas force graph), `app.js` (glue).

## Requirements

- Python 3.9+ (standard library only — no `pip install`).
- That's it. No Node.js, no build step.

## Autostart (optional)

A systemd **user** service is provided in `contrib/`:

```bash
mkdir -p ~/.config/systemd/user
cp contrib/gringotts-viewer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gringotts-viewer.service
```

It starts the viewer on login and restarts it on failure. Manage with
`systemctl --user {status,restart,stop,disable} gringotts-viewer`.

## Third-party assets

Vendored locally so the app runs offline with no build step:

- [marked](https://github.com/markedjs/marked) — MIT
- [highlight.js](https://github.com/highlightjs/highlight.js) — BSD-3-Clause
- Fonts: [Space Grotesk](https://github.com/floriankarsten/space-grotesk) & [Geist](https://github.com/vercel/geist-font) — SIL Open Font License 1.1
