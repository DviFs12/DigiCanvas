/**
 * annotation.js — Motor de anotação vetorial
 *
 * COORDENADAS: normalized [0-1] relativo ao PDF em todas as páginas.
 *
 * FIXES:
 * 1. _drawFull tinha ctx.save() duplicado (outer + _style) mas só 1 restore → stack vaza.
 *    Removido o ctx.save() externo; _style já salva/restaura via o caller.
 * 2. Semântica clear corrigida: clearPC() / clearMobile() em vez de clearLocal() / clearRemote().
 *    applyMsg agora aceita 'clear:pc' e 'clear:mobile' (perspectiva-independente).
 * 3. Adicionado getStrokes() e getAnnotatedPages() para exportação com pdf-lib.
 */

export const TOOLS = {
  pen:         { mul: 1.0, alpha: 1.0,  op: 'source-over'     },
  marker:      { mul: 2.5, alpha: 1.0,  op: 'source-over'     },
  highlighter: { mul: 8.0, alpha: 0.35, op: 'source-over'     },
  eraser:      { mul: 5.0, alpha: 1.0,  op: 'destination-out' },
  line:        { mul: 1.5, alpha: 1.0,  op: 'source-over'     },
  rect:        { mul: 1.5, alpha: 1.0,  op: 'source-over'     },
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
    this._active = null;   // stroke em andamento
    this._snap   = null;   // snapshot para preview de linha/rect
    this._sx     = 0;
    this._sy     = 0;

    // Remote active strokes (in-progress): id → { s, page }
    this._remActive = {};

    this.enabled    = true;
    this.showRemote = true;

    // Callbacks para envio via WebRTC
    this.onStart = null; // ({tool,color,size,nx,ny,page})
    this.onMove  = null; // ({nx,ny})
    this.onEnd   = null; // ()

    this._bindMouse();
  }

  // ── Config ────────────────────────────────────────────────────────────────

  setTool(t)    { this.tool  = t; }
  setColor(c)   { this.color = c; }
  setSize(s)    { this.size  = Math.max(0.5, Math.min(200, s)); }
  setEnabled(b) { this.enabled = b; }

  setPage(p) {
    if (this._page === p) return;
    this._page = p;
    this._redrawLocal();
    this._redrawRemote();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  _bindMouse() {
    const c = this.lc;
    c.addEventListener('mousedown',  e => { if (this.enabled) this._down(this._norm(e)); });
    c.addEventListener('mousemove',  e => { if (this.enabled && this._active) this._move(this._norm(e)); });
    c.addEventListener('mouseup',    ()  => { if (this.enabled) this._up(); });
    c.addEventListener('mouseleave', ()  => { if (this.enabled) this._up(); });
    // Suporte touch no desktop (stylus, tablet)
    c.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' && this.enabled) {
        e.preventDefault();
        this._down(this._norm(e));
        c.setPointerCapture(e.pointerId);
      }
    }, { passive: false });
    c.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' && this.enabled && this._active) {
        e.preventDefault();
        this._move(this._norm(e));
      }
    }, { passive: false });
    c.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse' && this.enabled) this._up();
    });
  }

  _norm(e) {
    const r = this.lc.getBoundingClientRect();
    return {
      nx: (e.clientX - r.left) / r.width,
      ny: (e.clientY - r.top)  / r.height,
    };
  }

  _down({ nx, ny }) {
    this._redo = [];
    if (this.tool === 'line' || this.tool === 'rect') {
      this._sx   = nx;
      this._sy   = ny;
      this._snap = this.lx.getImageData(0, 0, this.lc.width, this.lc.height);
    }
    const s = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this._active = s;
    this._local.has(this._page) || this._local.set(this._page, []);
    this._local.get(this._page).push(s);
    this._undo.push({ page: this._page, stroke: s });
    if (this._undo.length > 100) this._undo.shift();
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

  // ── Drawing ───────────────────────────────────────────────────────────────

  _n2p(canvas, nx, ny) {
    return { x: nx * canvas.width, y: ny * canvas.height };
  }

  /** Aplica estilo ao ctx. Salva contexto — quem chama deve chamar ctx.restore(). */
  _applyStyle(ctx, s) {
    const t   = TOOLS[s.tool] ?? TOOLS.pen;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = t.op;
    ctx.globalAlpha  = t.alpha;
    ctx.strokeStyle  = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
    ctx.fillStyle    = ctx.strokeStyle;
    ctx.lineWidth    = s.size * t.mul * dpr;
  }

  _drawSeg(ctx, s, nx, ny) {
    const pts  = s.points;
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;

    if (s.tool === 'line') {
      if (this._snap) ctx.putImageData(this._snap, 0, 0);
      this._applyStyle(ctx, s);
      const a = this._n2p(ctx.canvas, this._sx, this._sy);
      const b = this._n2p(ctx.canvas, nx, ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
      return;
    }
    if (s.tool === 'rect') {
      if (this._snap) ctx.putImageData(this._snap, 0, 0);
      this._applyStyle(ctx, s);
      const a = this._n2p(ctx.canvas, this._sx, this._sy);
      const b = this._n2p(ctx.canvas, nx, ny);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
      return;
    }
    if (prev) {
      this._applyStyle(ctx, s);
      const a = this._n2p(ctx.canvas, prev.nx, prev.ny);
      const b = this._n2p(ctx.canvas, nx, ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * FIX: Removido o ctx.save() externo. _applyStyle já chama ctx.save(),
   * portanto ter dois saves e um único restore vazava o stack de contexto.
   */
  _drawFull(ctx, s) {
    if (!s?.points?.length) return;
    const pts = s.points;

    // _applyStyle salva o contexto; o ctx.restore() ao final desfaz
    this._applyStyle(ctx, s);

    if (pts.length === 1) {
      const p = this._n2p(ctx.canvas, pts[0].nx, pts[0].ny);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === 'line') {
      const a = this._n2p(ctx.canvas, pts[0].nx,             pts[0].ny);
      const b = this._n2p(ctx.canvas, pts[pts.length-1].nx,  pts[pts.length-1].ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = this._n2p(ctx.canvas, pts[0].nx,             pts[0].ny);
      const b = this._n2p(ctx.canvas, pts[pts.length-1].nx,  pts[pts.length-1].ny);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      ctx.beginPath();
      const p0 = this._n2p(ctx.canvas, pts[0].nx, pts[0].ny);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length - 1; i++) {
        const cur  = this._n2p(ctx.canvas, pts[i].nx,     pts[i].ny);
        const next = this._n2p(ctx.canvas, pts[i+1].nx,   pts[i+1].ny);
        ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
      }
      const last = this._n2p(ctx.canvas, pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    ctx.restore(); // desfaz o save de _applyStyle
  }

  // ── Redraw ────────────────────────────────────────────────────────────────

  _redrawLocal() {
    this.lx.clearRect(0, 0, this.lc.width, this.lc.height);
    (this._local.get(this._page) ?? []).forEach(s => this._drawFull(this.lx, s));
  }

  _redrawRemote() {
    this.rx.clearRect(0, 0, this.rc.width, this.rc.height);
    (this._remote.get(this._page) ?? []).forEach(s => this._drawFull(this.rx, s));
  }

  /** Chamado após PDF re-renderizar (mudança de página ou zoom). */
  onResize() {
    this._redrawLocal();
    this._redrawRemote();
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    if (!this._undo.length) return false;
    const e   = this._undo.pop();
    this._redo.push(e);
    const arr = this._local.get(e.page) ?? [];
    const idx = arr.lastIndexOf(e.stroke);
    if (idx >= 0) arr.splice(idx, 1);
    if (e.page === this._page) this._redrawLocal();
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    const e = this._redo.pop();
    this._undo.push(e);
    this._local.has(e.page) || this._local.set(e.page, []);
    this._local.get(e.page).push(e.stroke);
    if (e.page === this._page) this._redrawLocal();
    return true;
  }

  // ── Clear ─────────────────────────────────────────────────────────────────
  // FIX: renomeados de clearLocal/clearRemote para clearPC/clearMobile
  // para evitar confusão semântica nas mensagens de rede.

  /** Limpa traços do PC (locais) em todas as páginas. */
  clearPC() {
    this._local.clear();
    this._undo = [];
    this._redo = [];
    this.lx.clearRect(0, 0, this.lc.width, this.lc.height);
  }

  /** Limpa traços do celular (remotos) em todas as páginas. */
  clearMobile() {
    this._remote.clear();
    this._remActive = {};
    this.rx.clearRect(0, 0, this.rc.width, this.rc.height);
  }

  /** Limpa traços do PC apenas na página especificada. */
  clearPCPage(page) {
    const arr = this._local.get(page);
    if (arr) arr.splice(0);
    this._undo = this._undo.filter(e => e.page !== page);
    if (page === this._page) this._redrawLocal();
  }

  /** Limpa traços do celular apenas na página especificada. */
  clearMobilePage(page) {
    const arr = this._remote.get(page);
    if (arr) arr.splice(0);
    if (page === this._page) this._redrawRemote();
  }

  clearAll() {
    this.clearPC();
    this.clearMobile();
  }

  // ── Remote strokes (mensagens do celular) ─────────────────────────────────

  applyMsg(msg) {
    switch (msg.type) {

      case 'stroke:start': {
        const page = msg.page ?? this._page;
        const s    = { tool: msg.tool, color: msg.color, size: msg.size, points: [{ nx: msg.nx, ny: msg.ny }] };
        this._remActive[msg.id] = { s, page };
        if (page === this._page) {
          this._applyStyle(this.rx, s);
          const p = this._n2p(this.rc, msg.nx, msg.ny);
          this.rx.beginPath();
          this.rx.arc(p.x, p.y, Math.max(1, this.rx.lineWidth / 2), 0, Math.PI * 2);
          this.rx.fill();
          this.rx.restore();
        }
        break;
      }

      case 'stroke:move': {
        const entry = this._remActive[msg.id];
        if (!entry) break;
        const prev = entry.s.points[entry.s.points.length - 1];
        entry.s.points.push({ nx: msg.nx, ny: msg.ny });
        if (entry.page === this._page) {
          this._applyStyle(this.rx, entry.s);
          const a = this._n2p(this.rc, prev.nx, prev.ny);
          const b = this._n2p(this.rc, msg.nx, msg.ny);
          this.rx.beginPath();
          this.rx.moveTo(a.x, a.y);
          this.rx.lineTo(b.x, b.y);
          this.rx.stroke();
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

      // FIX: semântica corrigida — clear:pc limpa traços do PC,
      // clear:mobile limpa traços do celular (independente de quem recebe)
      case 'clear:pc':
        if (msg.page != null) this.clearPCPage(msg.page);
        else                   this.clearPC();
        break;

      case 'clear:mobile':
        if (msg.page != null) this.clearMobilePage(msg.page);
        else                   this.clearMobile();
        break;

      case 'clear:all':
        this.clearAll();
        break;
    }
  }

  // ── Export helpers ────────────────────────────────────────────────────────

  /**
   * Retorna os strokes de uma página.
   * @param {number} page  Número da página (1-indexed)
   * @param {'local'|'remote'|'all'} source
   */
  getStrokes(page, source = 'all') {
    const local  = this._local.get(page)  ?? [];
    const remote = this._remote.get(page) ?? [];
    if (source === 'local')  return [...local];
    if (source === 'remote') return [...remote];
    return [...local, ...remote];
  }

  /** Lista de páginas que têm algum traço anotado. */
  getAnnotatedPages() {
    const pages = new Set();
    for (const [p, arr] of this._local)  if (arr.length) pages.add(p);
    for (const [p, arr] of this._remote) if (arr.length) pages.add(p);
    return [...pages].sort((a, b) => a - b);
  }

  /** Exporta página atual como PNG (PDF + traços locais + remotos). */
  exportCurrentPagePNG(pdfCanvas) {
    const w = this.lc.width, h = this.lc.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    if (pdfCanvas) ctx.drawImage(pdfCanvas, 0, 0, w, h);
    ctx.drawImage(this.lc, 0, 0, w, h);
    if (this.showRemote) ctx.drawImage(this.rc, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }
}
