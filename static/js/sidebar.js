/* sidebar.js — folder tree + facet filters (type / status / tags). */

const collapsedDirs = new Set();     // folder paths currently collapsed
const collapsedFacets = new Set();   // facet groups collapsed
let seededCollapse = false;          // start with every folder collapsed on first render

function allDirPaths(notes) {
  const s = new Set();
  for (const n of notes) {
    const parts = n.folder ? n.folder.split('/') : [];
    let p = '';
    for (const part of parts) { p = p ? `${p}/${part}` : part; s.add(p); }
  }
  return s;
}

/* Inline SVG icons (24x24, currentColor stroke) — render reliably everywhere,
   unlike Unicode symbol glyphs which show as tofu when the font lacks them. */
const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

const FOLDER_ICON = svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');

const NOTE_ICONS = {
  moc: svg('<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 11l8-4M8 13l8 4"/>'),
  sop: svg('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5.6l1.1 1.1L7.4 4.4M4 11.6l1.1 1.1L7.4 10.4M4 17.6l1.1 1.1L7.4 16.4"/>'),
  technical: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13.5 15H17"/>'),
  course: svg('<path d="M12 6.5C10.4 5.4 8 5 6 5s-3 .5-3 .5v13s1-.5 3-.5 4.4.4 6 1.5c1.6-1.1 4-1.5 6-1.5s3 .5 3 .5v-13S20 5 18 5s-4.4.4-6 1.5z"/><path d="M12 6.5v13"/>'),
  daily: svg('<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>'),
  'platform-notes': svg('<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M6.5 7.5h.01M6.5 16.5h.01"/>'),
  changelog: svg('<path d="M3.2 12a8.8 8.8 0 1 0 2.8-6.4L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>'),
  task: svg('<rect x="4" y="4" width="16" height="16" rx="2.6"/><path d="M8.5 12.4l2.4 2.4 4.6-5"/>'),
  personal: svg('<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c0-3.4 2.9-5.8 6.5-5.8s6.5 2.4 6.5 5.8"/>'),
  default: svg('<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>'),
};

function noteIcon(type) { return NOTE_ICONS[type] || NOTE_ICONS.default; }

/* Build a nested tree object from flat note list. */
function buildTree(notes) {
  const root = { dirs: new Map(), files: [] };
  for (const n of notes) {
    const parts = n.folder ? n.folder.split('/') : [];
    let node = root;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(n);
  }
  return root;
}

function countNotes(node) {
  let c = node.files.length;
  for (const d of node.dirs.values()) c += countNotes(d);
  return c;
}

export function renderTree(container, notes, { activeRel, onOpen }) {
  container.innerHTML = '';
  if (!seededCollapse) { for (const p of allDirPaths(notes)) collapsedDirs.add(p); seededCollapse = true; }
  const root = buildTree(notes);

  const makeDir = (node, depth) => {
    const wrap = document.createElement('div');
    const isCollapsed = collapsedDirs.has(node.path);

    const row = document.createElement('div');
    row.className = 'tree-row dir' + (isCollapsed ? ' collapsed' : '');
    row.dataset.path = node.path;
    row.innerHTML =
      `<span class="tree-twist">▾</span><span class="tree-ico">${FOLDER_ICON}</span>` +
      `<span class="tree-label">${node.name}</span><span class="rail-count">${countNotes(node)}</span>`;
    const children = document.createElement('div');
    children.className = 'tree-children' + (isCollapsed ? ' hidden' : '');

    row.addEventListener('click', () => {
      const nowCollapsed = !collapsedDirs.has(node.path);
      if (nowCollapsed) collapsedDirs.add(node.path); else collapsedDirs.delete(node.path);
      row.classList.toggle('collapsed', nowCollapsed);
      children.classList.toggle('hidden', nowCollapsed);
    });

    // dirs first (sorted), then files (sorted)
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) children.appendChild(makeDir(d, depth + 1));
    const files = [...node.files].sort((a, b) => a.title.localeCompare(b.title));
    for (const f of files) children.appendChild(makeFile(f));

    wrap.appendChild(row);
    wrap.appendChild(children);
    return wrap;
  };

  const makeFile = (n) => {
    const row = document.createElement('div');
    row.className = 'tree-row file' + (n.rel === activeRel ? ' active' : '');
    row.dataset.rel = n.rel;
    row.innerHTML =
      `<span class="tree-twist"></span><span class="tree-ico">${noteIcon(n.type)}</span>` +
      `<span class="tree-label" title="${n.title}">${n.title}</span>`;
    row.addEventListener('click', () => onOpen(n.rel));
    return row;
  };

  const rootDirs = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of rootDirs) container.appendChild(makeDir(d, 0));
  const rootFiles = [...root.files].sort((a, b) => a.title.localeCompare(b.title));
  for (const f of rootFiles) container.appendChild(makeFile(f));

  if (!notes.length) {
    container.innerHTML = '<div class="empty-note">No notes match these filters.</div>';
  }
}

export function markActive(container, rel) {
  container.querySelectorAll('.tree-row.file.active').forEach((el) => el.classList.remove('active'));
  const el = container.querySelector(`.tree-row.file[data-rel="${CSS.escape(rel)}"]`);
  if (el) {
    el.classList.add('active');
    // expand ancestors
    let node = el.closest('.tree-children');
    while (node) {
      node.classList.remove('hidden');
      const dirRow = node.previousElementSibling;
      if (dirRow) {
        dirRow.classList.remove('collapsed');
        if (dirRow.dataset.path) collapsedDirs.delete(dirRow.dataset.path); // keep state in sync
      }
      node = node.parentElement.closest('.tree-children');
    }
    el.scrollIntoView({ block: 'nearest' });
  }
}

/* ---- Facets -------------------------------------------------------------- */

function renderFacet(container, entries, active, onToggle) {
  container.innerHTML = '';
  for (const [value, count] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (active.has(value) ? ' on' : '');
    chip.innerHTML = `${value}<span class="n">${count}</span>`;
    chip.addEventListener('click', () => onToggle(value));
    container.appendChild(chip);
  }
}

export function renderFacets(facets, filters, onToggle) {
  const sortByCount = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  renderFacet(document.getElementById('facet-type'), sortByCount(facets.types), filters.type, (v) => onToggle('type', v));
  renderFacet(document.getElementById('facet-status'), sortByCount(facets.statuses), filters.status, (v) => onToggle('status', v));
  renderFacet(document.getElementById('facet-tag'), sortByCount(facets.tags), filters.tag, (v) => onToggle('tag', v));
}

export function refreshFacetSelection(filters) {
  const apply = (id, active) => {
    document.getElementById(id).querySelectorAll('.chip').forEach((chip) => {
      const val = chip.firstChild.textContent;
      chip.classList.toggle('on', active.has(val));
    });
  };
  apply('facet-type', filters.type);
  apply('facet-status', filters.status);
  apply('facet-tag', filters.tag);
}

export function initFacetCollapse() {
  document.querySelectorAll('[data-facet-toggle]').forEach((head) => {
    const key = head.dataset.facetToggle;
    const facet = document.getElementById(`facet-${key}`);
    head.addEventListener('click', () => {
      const collapsed = !collapsedFacets.has(key);
      if (collapsed) collapsedFacets.add(key); else collapsedFacets.delete(key);
      head.classList.toggle('collapsed', collapsed);
      facet.classList.toggle('hidden', collapsed);
    });
  });
}
