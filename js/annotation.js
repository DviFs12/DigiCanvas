/**
 * annotation.js — Motor de anotação vetorial
 *
 * COORDENADAS: tudo em normalized [0-1] relativo ao PDF.
 * PÁGINAS: cada página tem sua própria lista de strokes.
 * UNDO: pilha global com referência à página de cada stroke.
 *
 * Strokes enviados pela rede já chegam em normalized coords.
 * Strokes locais são capturados em px de canvas e normalizados.
 */

export const TOOLS = {
  pen:         { mul: 1.0, alpha: 1.0,  op: 'source-over'    },
  marker:      { mul: 2.5, alpha: 1.0,  op: 'source-over'    },
  highlighter: { mul: 8.0, alpha: 0.35, op: 'source-over'    },
  eraser:      { mul: 5.0, alpha: 1.0,  op: 'destination-out'},
};

export class Annotation {
  constructor(localCanvas, remoteCanvas) {
    this.lc = localCanvas;
    this.rc = remoteCanvas;
    this.lx = localCanvas.getContext('2d');
    this.rx = remoteCanvas.getContext('2d');

    // Tool state
    this.tool  = 'pen';
    this.color = '#e63946';
    this.size  = 3;

    // Per-page stroke storage: Map<pageNum, stroke[]>
    this._local  = new Map();
    this._remote = new Map();

    // Undo stack: [{page, stroke}]
    this._undo = [];
    this._redo = [];

    // Current page (1-indexed)
    this._page = 1;

    // Drawing state
    this._active = null;   // stroke being drawn now
    this._snap   = null;   // snapshot for line/rect preview
    this._sx     = 0; this._sy = 0; // start normalized for shapes

    // Remote active strokes: id → stroke
    this._remActive = {};

    this.enabled    = true;
    this.showRemote = true;

    // Callbacks
    this.onStart = null; // ({tool,color,size,nx,ny,page})
    this.onMove  = null; // ({nx,ny})
    this.onEnd   = null; // ()

    this._bindMouse();
  }

  // ── Config ──────────────────────────────────────────────────────────────

  setTool(t)    { this.tool  = t; }
  setColor(c)   { this.color = c; }
  setSize(s)    { this.size  = Math.max(0.5, Math.min(200, s)); }
  setPage(p)    {
    if (this._page === p) return;
    this._page = p;
    this._redrawLocal();
    this._redrawRemote();
  }
  setEnabled(b) { this.enabled = b; }

  // ── Mouse/Touch input ────────────────────────────────────────────────────

  _bindMouse() {
    const c = this.lc;
    c.addEventListener('mousedown',  e => { if (this.enabled) this._down(this._norm(e)); });
    c.addEventListener('mousemove',  e => { if (this.enabled && this._active) this._move(this._norm(e)); });
    c.addEventListener('mouseup',    ()  => { if (this.enabled) this._up(); });
    c.addEventListener('mouseleave', ()  => { if (this.enabled) this._up(); });
  }

  _norm(e) {
    const r = this.lc.getBoundingClientRect();
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  }

  _down({ nx, ny }) {
    this._redo = [];
    if (this.tool === 'line' || this.tool === 'rect') {
      this._sx = nx; this._sy = ny;
      this._snap = this.lx.getImageData(0, 0, this.lc.width, this.lc.height);
    }
    const s = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this._active = s;
    this._local.has(this._page) || this._local.set(this._page, []);
    this._local.get(this._page).push(s);
    this._undo.push({ page: this._page, stroke: s });
    if (this._undo.length > 80) this._undo.shift();
    this.onStart?.({ tool: this.tool, color: this.color, size: this.size, nx, ny, page: this._page });
  }

  _move({ nx, ny }) {
    if (!this._active) return;
    this._active.points.push({ nx, ny });
    this._drawSeg(this.lx, this._active, nx, ny);
    this.onMove?.({ nx, ny });
  }

  _up() {
    if (!this._active) return;
    this._active = null;
    this._snap   = null;
    this.onEnd?.();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  _n2p(ctx, nx, ny) {
    return { x: nx * ctx.canvas.width, y: ny * ctx.canvas.height };
  }

  _style(ctx, s) {
    const t = TOOLS[s.tool] ?? TOOLS.pen;
    ctx.save();
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = t.op;
    ctx.globalAlpha  = t.alpha;
    ctx.strokeStyle  = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
    ctx.fillStyle    = ctx.strokeStyle;
    ctx.lineWidth    = s.size * t.mul * (window.devicePixelRatio || 1);
  }

  _drawSeg(ctx, s, nx, ny) {
    const pts = s.points;
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;

    if (s.tool === 'line' && prev) {
      if (this._snap) ctx.putImageData(this._snap, 0, 0);
      const a = this._n2p(ctx, this._sx, this._sy);
      const b = this._n2p(ctx, nx, ny);
      this._style(ctx, s);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore(); return;
    }
    if (s.tool === 'rect') {
      if (this._snap) ctx.putImageData(this._snap, 0, 0);
      const a = this._n2p(ctx, this._sx, this._sy);
      const b = this._n2p(ctx, nx, ny);
      this._style(ctx, s);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore(); return;
    }
    if (prev) {
      const a = this._n2p(ctx, prev.nx, prev.ny);
      const b = this._n2p(ctx, nx, ny);
      this._style(ctx, s);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
  }

  _drawFull(ctx, s) {
    if (!s?.points?.length) return;
    const pts = s.points;
    ctx.save();
    this._style(ctx, s);
    if (pts.length === 1) {
      const p = this._n2p(ctx, pts[0].nx, pts[0].ny);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill();
    } else if (s.tool === 'line') {
      const a = this._n2p(ctx, pts[0].nx, pts[0].ny);
      const b = this._n2p(ctx, pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = this._n2p(ctx, pts[0].nx, pts[0].ny);
      const b = this._n2p(ctx, pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      ctx.beginPath();
      const p0 = this._n2p(ctx, pts[0].nx, pts[0].ny);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length - 1; i++) {
        const cur  = this._n2p(ctx, pts[i].nx,   pts[i].ny);
        const next = this._n2p(ctx, pts[i+1].nx, pts[i+1].ny);
        ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
      }
      const last = this._n2p(ctx, pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Redraw ───────────────────────────────────────────────────────────────

  _redrawLocal() {
    this.lx.clearRect(0, 0, this.lc.width, this.lc.height);
    (this._local.get(this._page) ?? []).forEach(s => this._drawFull(this.lx, s));
  }

  _redrawRemote() {
    this.rx.clearRect(0, 0, this.rc.width, this.rc.height);
    (this._remote.get(this._page) ?? []).forEach(s => this._drawFull(this.rx, s));
  }

  // Called after PDF re-renders (page change or zoom)
  onResize() {
    this._redrawLocal();
    this._redrawRemote();
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────

  undo() {
    if (!this._undo.length) return false;
    const e = this._undo.pop();
    this._redo.push(e);
    const arr = this._local.get(e.page) ?? [];
    const idx = arr.lastIndexOf(e.stroke);
    if (idx >= 0) arr.splice(idx, 1);
    this._redrawLocal();
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    const e = this._redo.pop();
    this._undo.push(e);
    this._local.has(e.page) || this._local.set(e.page, []);
    this._local.get(e.page).push(e.stroke);
    this._redrawLocal();
    return true;
  }

  clearLocal() {
    this._local.clear(); this._undo = []; this._redo = [];
    this.lx.clearRect(0, 0, this.lc.width, this.lc.height);
  }

  clearRemote() {
    this._remote.clear(); this._remActive = {};
    this.rx.clearRect(0, 0, this.rc.width, this.rc.height);
  }

  clearAll() { this.clearLocal(); this.clearRemote(); }

  // ── Remote strokes ───────────────────────────────────────────────────────

  applyMsg(msg) {
    switch (msg.type) {
      case 'stroke:start': {
        const page = msg.page ?? this._page;
        const s = { tool: msg.tool, color: msg.color, size: msg.size, points: [{ nx: msg.nx, ny: msg.ny }] };
        this._remActive[msg.id] = { s, page };
        if (page === this._page) {
          this.rx.save(); this._style(this.rx, s);
          const p = this._n2p(this.rx, msg.nx, msg.ny);
          this.rx.beginPath(); this.rx.arc(p.x, p.y, Math.max(1, this.rx.lineWidth/2), 0, Math.PI*2); this.rx.fill();
          this.rx.restore();
        }
        break;
      }
      case 'stroke:move': {
        const entry = this._remActive[msg.id]; if (!entry) break;
        const prev = entry.s.points[entry.s.points.length - 1];
        entry.s.points.push({ nx: msg.nx, ny: msg.ny });
        if (entry.page === this._page) {
          const a = this._n2p(this.rx, prev.nx, prev.ny);
          const b = this._n2p(this.rx, msg.nx, msg.ny);
          this.rx.save(); this._style(this.rx, entry.s);
          this.rx.beginPath(); this.rx.moveTo(a.x, a.y); this.rx.lineTo(b.x, b.y); this.rx.stroke();
          this.rx.restore();
        }
        break;
      }
      case 'stroke:end': {
        const entry = this._remActive[msg.id];
        if (entry) {
          this._remote.has(entry.page) || this._remote.set(entry.page, []);
          this._remote.get(entry.page).push(entry.s);
        }
        delete this._remActive[msg.id];
        break;
      }
      case 'undo': {
        const arr = this._remote.get(this._page) ?? [];
        if (arr.length) { arr.pop(); this._redrawRemote(); }
        break;
      }
      case 'clear:all':    this.clearAll();    break;
      case 'clear:local':  this.clearLocal();  break;
      case 'clear:remote': this.clearRemote(); break;
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────

  exportPNG() {
    const w = this.lc.width, h = this.lc.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const pdf = document.getElementById('pdf-canvas');
    if (pdf) ctx.drawImage(pdf, 0, 0, w, h);
    ctx.drawImage(this.lc, 0, 0, w, h);
    if (this.showRemote) ctx.drawImage(this.rc, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }
}
