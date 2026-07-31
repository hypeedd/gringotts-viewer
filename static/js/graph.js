/* graph.js — lightweight force-directed graph on <canvas>.
   Used for the full-screen vault graph and the per-note local graph. */

// Categorical palette — modern cool set, indigo accent leads.
const PALETTE = [
  '#8B7DFF', '#5FA8FF', '#54D19A', '#F0A64E', '#F07A8C',
  '#5FC7DE', '#B6A6FF', '#7ED957', '#E7B75C', '#FF9BC4',
  '#6C8BFF', '#4FD1C5', '#C77DFF', '#9AE66E', '#FF8A65',
];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

class ForceGraph {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = opts.onSelect || (() => {});
    this.interactive = opts.interactive !== false;
    this.showLabels = opts.showLabels !== false;
    this.colorGroups = new Map();       // group -> color
    this.hiddenGroups = opts.hiddenGroups || new Set();
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.userMoved = false;
    this.hover = null; this.dragNode = null; this.panning = false;
    this.centerRel = opts.centerRel || null;
    this.raf = null;
    this.alpha = 1;
    this._bind();
    this.setData(opts.nodes, opts.edges, opts.colorFn);
  }

  colorFor(group) {
    if (!this.colorGroups.has(group)) {
      this.colorGroups.set(group, PALETTE[this.colorGroups.size % PALETTE.length]);
    }
    return this.colorGroups.get(group);
  }

  setData(nodes, edges, colorFn) {
    const W = this.canvas.clientWidth || 800;
    const H = this.canvas.clientHeight || 600;
    this.nodes = nodes.map((n, i) => ({
      ...n,
      x: W / 2 + Math.cos(i) * (40 + i % 120),
      y: H / 2 + Math.sin(i * 1.3) * (40 + i % 120),
      vx: 0, vy: 0, deg: 0,
      group: colorFn ? colorFn(n) : '',
    }));
    this.index = new Map(this.nodes.map((n) => [n.rel, n]));
    this.edges = [];
    for (const [a, b] of edges) {
      const na = this.index.get(a), nb = this.index.get(b);
      if (na && nb) { this.edges.push([na, nb]); na.deg++; nb.deg++; }
    }
    for (const n of this.nodes) { n.r = Math.min(3 + Math.sqrt(n.deg) * 2.2, 12); this.colorFor(n.group); }
    this.alpha = 1;
    this.resize();
    if (this.centerRel) this.frameOnCenter();
    else this.fit();
    this.start();
  }

  frameOnCenter() {
    const c = this.index.get(this.centerRel);
    if (!c) return;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    c.x = W / 2; c.y = H / 2; c.fixed = true;
  }

  fit() {
    // Run a few synchronous ticks so first paint isn't a hairball, then center.
    for (let i = 0; i < 60; i++) this.tick(0.9);
    this._centerView();
  }

  _centerView() {
    if (!this.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const gw = maxX - minX || 1, gh = maxY - minY || 1;
    this.scale = Math.min(W / (gw + 120), H / (gh + 120), 2);
    this.tx = W / 2 - ((minX + maxX) / 2) * this.scale;
    this.ty = H / 2 - ((minY + maxY) / 2) * this.scale;
  }

  tick(strength = 1) {
    const nodes = this.nodes, edges = this.edges;
    const k = 0.02 * strength;
    // Repulsion (naive O(n^2); fine at a few hundred nodes).
    const rep = this.centerRel ? 1400 : 2600;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = Math.random(); }
        const f = rep / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    // Springs.
    const rest = this.centerRel ? 70 : 46;
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - rest) * 0.06;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    // Gravity toward center + integrate. Stronger for the full graph so
    // edge-less notes cluster near the middle instead of drifting off-frame.
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const grav = this.centerRel ? 0.09 : 0.32;
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * k * grav;
      n.vy += (H / 2 - n.y) * k * grav;
      if (n.fixed || n === this.dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += Math.max(-30, Math.min(30, n.vx));
      n.y += Math.max(-30, Math.min(30, n.vy));
    }
  }

  start() {
    if (this.raf) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { for (let i = 0; i < 80; i++) this.tick(); this.alpha = 0; this.draw(); return; }
    const loop = () => {
      if (this.alpha > 0.02 || this.dragNode) {
        this.tick(this.alpha);
        this.alpha *= 0.985;
        if (!this.userMoved && !this.centerRel) this._centerView(); // keep it framed while settling
      }
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
  reheat() { this.alpha = Math.max(this.alpha, 0.6); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toWorld(sx, sy) { return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale }; }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const lineColor = cssVar('--line-2');
    const inkColor = cssVar('--text');
    const hoverSet = this.neighborsOf(this.hover);

    // Edges.
    ctx.lineWidth = 1 / this.scale;
    for (const [a, b] of this.edges) {
      if (this.isHidden(a) || this.isHidden(b)) continue;
      const active = this.hover && (hoverSet.has(a) && hoverSet.has(b));
      ctx.strokeStyle = active ? cssVar('--accent') : lineColor;
      ctx.globalAlpha = this.hover ? (active ? 0.9 : 0.15) : 0.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes.
    for (const n of this.nodes) {
      if (this.isHidden(n)) continue;
      const dim = this.hover && !hoverSet.has(n);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + (n.rel === this.centerRel ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = n.rel === this.centerRel ? cssVar('--accent') : this.colorFor(n.group);
      ctx.fill();
      if (n === this.hover || n.rel === this.centerRel) {
        ctx.lineWidth = 2 / this.scale; ctx.strokeStyle = inkColor; ctx.stroke();
      }
    }

    // Labels (when zoomed in enough, or hovered, or local graph).
    ctx.globalAlpha = 1;
    ctx.fillStyle = inkColor;
    ctx.font = `${12 / this.scale}px 'Geist', system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const labelAll = this.showLabels && (this.scale > 1.1 || this.centerRel);
    for (const n of this.nodes) {
      if (this.isHidden(n)) continue;
      const show = labelAll || n === this.hover || (this.hover && hoverSet.has(n)) || n.rel === this.centerRel;
      if (!show) continue;
      ctx.globalAlpha = (this.hover && !hoverSet.has(n)) ? 0.25 : 0.92;
      const label = n.title.length > 26 ? n.title.slice(0, 25) + '…' : n.title;
      ctx.fillText(label, n.x, n.y + n.r + 3 / this.scale);
    }
    ctx.restore();
  }

  neighborsOf(node) {
    const set = new Set();
    if (!node) return set;
    set.add(node);
    for (const [a, b] of this.edges) {
      if (a === node) set.add(b);
      if (b === node) set.add(a);
    }
    return set;
  }
  isHidden(n) { return this.hiddenGroups.has(n.group); }

  nodeAt(sx, sy) {
    const p = this.toWorld(sx, sy);
    let best = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (this.isHidden(n)) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const hit = (n.r + 6) / 1;
      if (d < hit && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  _bind() {
    if (!this.interactive) return;
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      if (this.dragNode) {
        const p = this.toWorld(x, y);
        this.dragNode.x = p.x; this.dragNode.y = p.y; this.reheat();
      } else if (this.panning) {
        this.tx += x - this._px; this.ty += y - this._py; this._px = x; this._py = y;
      } else {
        const n = this.nodeAt(x, y);
        if (n !== this.hover) { this.hover = n; c.style.cursor = n ? 'pointer' : 'grab'; if (this.alpha < 0.02) this.draw(); }
      }
    });
    c.addEventListener('mousedown', (e) => {
      const [x, y] = pos(e);
      const n = this.nodeAt(x, y);
      if (n) { this.dragNode = n; this._moved = false; }
      else { this.panning = true; this._px = x; this._py = y; this.userMoved = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (this.dragNode) {
        const [x, y] = pos(e);
        const n = this.nodeAt(x, y);
        if (n === this.dragNode && !this._movedFar) this.onSelect(n.rel);
      }
      this.dragNode = null; this.panning = false;
    });
    c.addEventListener('mousemove', () => { if (this.dragNode) this._movedFar = true; });
    c.addEventListener('mousedown', () => { this._movedFar = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userMoved = true;
      const [x, y] = pos(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const before = this.toWorld(x, y);
      this.scale = Math.max(0.15, Math.min(6, this.scale * factor));
      this.tx = x - before.x * this.scale;
      this.ty = y - before.y * this.scale;
      if (this.alpha < 0.02) this.draw();
    }, { passive: false });
    c.addEventListener('click', (e) => {
      // click handled via mouseup for nodes; plain click on empty does nothing
    });
  }

  setHiddenGroups(set) { this.hiddenGroups = set; this.draw(); }
  recolor(colorFn) {
    this.colorGroups.clear();
    for (const n of this.nodes) { n.group = colorFn(n); this.colorFor(n.group); }
    this.draw();
  }
}

export function createGraph(canvas, opts) { return new ForceGraph(canvas, opts); }
