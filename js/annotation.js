/**
 * annotation.js v5 — Anotações por página + curvas suavizadas
 * ─────────────────────────────────────────────────────────────
 * NOVO: strokes são indexados por página (pageNum).
 *   undoStack[page] = [stroke, stroke, ...]
 *   Ao mudar de página → renderiza apenas os strokes daquela página.
 *   Ao exportar → exporta apenas a página atual.
 *
 * Curvas: usa quadraticCurveTo para suavizar (igual ao renderer mobile).
 * Borracha: destination-out somente no overlay (nunca no pdf-canvas).
 */

export const TOOLS = {
  pen:         { label:'Caneta',      opacity:1.0,  widthMul:1,   blend:'source-over'    },
  marker:      { label:'Marcador',    opacity:1.0,  widthMul:2.5, blend:'source-over'    },
  highlighter: { label:'Marca-texto', opacity:0.35, widthMul:7,   blend:'source-over'    },
  eraser:      { label:'Borracha',    opacity:1.0,  widthMul:4,   blend:'destination-out'},
  line:        { label:'Linha',       opacity:1.0,  widthMul:1,   blend:'source-over'    },
  rect:        { label:'Retângulo',   opacity:1.0,  widthMul:1,   blend:'source-over'    },
};

export class AnnotationEngine {
  /**
   * @param {HTMLCanvasElement} localCanvas
   * @param {HTMLCanvasElement} remoteCanvas
   * @param {()=>{w,h}} getPdfCssSize
   */
  constructor(localCanvas, remoteCanvas, getPdfCssSize) {
    this.lCanvas       = localCanvas;
    this.rCanvas       = remoteCanvas;
    this.lCtx          = localCanvas.getContext('2d');
    this.rCtx          = remoteCanvas.getContext('2d');
    this.getPdfCssSize = getPdfCssSize;

    this.tool   = 'pen';
    this.color  = '#e63946';
    this.size   = 3;
    this.active = true;

    this.drawing  = false;
    this._startNX = 0;
    this._startNY = 0;
    this._snapshot = null;

    // ── Por página: Map<pageNum, stroke[]> ────────────────────────────────
    // pageNum começa em 1 (igual ao PDF.js)
    this._localPages  = new Map();  // local (PC)
    this._remotePages = new Map();  // remoto (celular)

    // Undo/redo: pilha de {page, stroke} para desfazer entre páginas
    this._undoStack = [];  // [{page, stroke}]
    this._redoStack = [];
    this.MAX_HIST   = 80;

    this._currentPage = 1;  // página visível atualmente

    // Strokes remotos em andamento (keyed by id)
    this._remoteActive = {};

    this.showRemote = true;
    this.clearMode  = 'shared';

    // Callbacks
    this.onStrokeStart = null;
    this.onStrokeMove  = null;
    this.onStrokeEnd   = null;

    this._activeStroke = null;
    this._bindEvents();
  }

  // ── Página ────────────────────────────────────────────────────────────────

  /** Chama ao trocar de página no viewer */
  setPage(pageNum) {
    if (this._currentPage === pageNum) return;
    this._currentPage = pageNum;
    this._redrawLocal();
    this._redrawRemote();
  }

  _localStrokesForPage(page = this._currentPage) {
    if (!this._localPages.has(page)) this._localPages.set(page, []);
    return this._localPages.get(page);
  }

  _remoteStrokesForPage(page = this._currentPage) {
    if (!this._remotePages.has(page)) this._remotePages.set(page, []);
    return this._remotePages.get(page);
  }

  // ── Configuração ──────────────────────────────────────────────────────────

  setTool(t)   { this.tool  = t; }
  setColor(c)  { this.color = c; }
  setSize(s)   { this.size  = Math.max(0.5, Math.min(200, s)); }
  setActive(b) { this.active = b; }

  // ── Eventos ───────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.lCanvas;
    c.addEventListener('mousedown',  e => { if (this.active) this._onDown(this._evNorm(e)); });
    c.addEventListener('mousemove',  e => { if (this.active && this.drawing) this._onMove(this._evNorm(e)); });
    c.addEventListener('mouseup',    () => { if (this.active) this._onUp(); });
    c.addEventListener('mouseleave', () => { if (this.active) this._onUp(); });
    c.addEventListener('touchstart', e => {
      if (!this.active) return; e.preventDefault();
      if (e.touches.length === 1) this._onDown(this._touchNorm(e.touches[0]));
    }, { passive: false });
    c.addEventListener('touchmove', e => {
      if (!this.active) return; e.preventDefault();
      if (e.touches.length === 1 && this.drawing) this._onMove(this._touchNorm(e.touches[0]));
    }, { passive: false });
    c.addEventListener('touchend', () => { if (this.active) this._onUp(); });
  }

  _evNorm(e) {
    const r = this.lCanvas.getBoundingClientRect();
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  }
  _touchNorm(t) {
    const r = this.lCanvas.getBoundingClientRect();
    return { nx: (t.clientX - r.left) / r.width, ny: (t.clientY - r.top) / r.height };
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  _onDown({ nx, ny }) {
    this.drawing   = true;
    this._startNX  = nx;
    this._startNY  = ny;
    this._redoStack = [];

    if (this.tool === 'line' || this.tool === 'rect') this._saveSnapshot();

    const stroke = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this._activeStroke = stroke;

    // Adiciona à página atual
    this._localStrokesForPage().push(stroke);

    // Undo stack
    this._undoStack.push({ page: this._currentPage, stroke });
    if (this._undoStack.length > this.MAX_HIST) this._undoStack.shift();

    this.onStrokeStart?.({ tool: this.tool, color: this.color, size: this.size, nx, ny });
  }

  _onMove({ nx, ny }) {
    if (!this._activeStroke) return;
    this._activeStroke.points.push({ nx, ny });
    this._drawSegment(nx, ny);
    this.onStrokeMove?.({ nx, ny });
  }

  _onUp() {
    if (!this.drawing) return;
    this.drawing       = false;
    this._activeStroke = null;
    this._snapshot     = null;
    this.onStrokeEnd?.();
  }

  // ── Rendering incremental ─────────────────────────────────────────────────

  _drawSegment(nx, ny) {
    const ctx  = this.lCtx;
    const pts  = this._activeStroke?.points ?? [];
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
    const dpr  = window.devicePixelRatio || 1;

    if (this.tool === 'line' && prev) {
      this._restoreSnapshot();
      const s = this._n2c(this._startNX, this._startNY);
      const ep = this._n2c(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ep.x, ep.y); ctx.stroke();
      this._resetCtx(ctx); return;
    }
    if (this.tool === 'rect') {
      this._restoreSnapshot();
      const s = this._n2c(this._startNX, this._startNY);
      const ep = this._n2c(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.strokeRect(s.x, s.y, ep.x - s.x, ep.y - s.y);
      this._resetCtx(ctx); return;
    }
    if (prev) {
      const a = this._n2c(prev.nx, prev.ny);
      const b = this._n2c(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      this._resetCtx(ctx);
    }
  }

  // nx,ny [0,1] → px físicos no canvas (inclui DPR automaticamente via canvas.width)
  _n2c(nx, ny) {
    return { x: nx * this.lCanvas.width, y: ny * this.lCanvas.height };
  }

  _applyStyle(ctx, tool, color, size) {
    const t   = TOOLS[tool] ?? TOOLS.pen;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
    ctx.globalCompositeOperation = t.blend;
    ctx.globalAlpha  = t.opacity;
    ctx.strokeStyle  = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    ctx.fillStyle    = ctx.strokeStyle;
    ctx.lineWidth    = size * t.widthMul * dpr;
  }

  _resetCtx(ctx) { ctx.restore(); }

  _saveSnapshot() {
    this._snapshot = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
  }
  _restoreSnapshot() {
    if (this._snapshot) this.lCtx.putImageData(this._snapshot, 0, 0);
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    if (!this._undoStack.length) return false;
    const entry = this._undoStack.pop();
    this._redoStack.push(entry);

    // Remove o stroke da página correspondente
    const pageStrokes = this._localPages.get(entry.page) ?? [];
    const idx = pageStrokes.lastIndexOf(entry.stroke);
    if (idx >= 0) pageStrokes.splice(idx, 1);

    this._redrawLocal();
    return true;
  }

  redo() {
    if (!this._redoStack.length) return false;
    const entry = this._redoStack.pop();
    this._undoStack.push(entry);
    this._localStrokesForPage(entry.page).push(entry.stroke);
    this._redrawLocal();
    return true;
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  /** Limpa traços locais (PC) da página atual */
  clearLocalPage() {
    this._localPages.set(this._currentPage, []);
    // Remove do undo stack também
    this._undoStack = this._undoStack.filter(e => e.page !== this._currentPage);
    this._redoStack = this._redoStack.filter(e => e.page !== this._currentPage);
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  /** Limpa traços locais de TODAS as páginas */
  clearLocal() {
    this._localPages.clear();
    this._undoStack = [];
    this._redoStack = [];
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  /** Limpa traços remotos (celular) da página atual */
  clearRemotePage() {
    this._remotePages.set(this._currentPage, []);
    this._remoteActive = {};
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
  }

  /** Limpa traços remotos de TODAS as páginas */
  clearRemote() {
    this._remotePages.clear();
    this._remoteActive = {};
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
  }

  clear()     { this.clearLocal();     this.clearRemote(); }
  clearPage() { this.clearLocalPage(); this.clearRemotePage(); }

  // ── Redraw ────────────────────────────────────────────────────────────────

  _redrawLocal() {
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    const strokes = this._localStrokesForPage();
    for (const s of strokes) this._drawFullStroke(this.lCtx, s);
  }

  _redrawRemote() {
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
    const strokes = this._remoteStrokesForPage();
    for (const s of strokes) this._drawFullStroke(this.rCtx, s);
  }

  _drawFullStroke(ctx, s) {
    if (!s?.points?.length) return;
    ctx.save();
    this._applyStyle(ctx, s.tool, s.color, s.size);
    const pts = s.points;

    if (pts.length === 1) {
      const p = this._n2c(pts[0].nx, pts[0].ny);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === 'line') {
      const a = this._n2c(pts[0].nx, pts[0].ny);
      const b = this._n2c(pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = this._n2c(pts[0].nx, pts[0].ny);
      const b = this._n2c(pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      // Curva suavizada com quadraticCurveTo
      ctx.beginPath();
      const p0 = this._n2c(pts[0].nx, pts[0].ny);
      ctx.moveTo(p0.x, p0.y);
      if (pts.length === 2) {
        const p1 = this._n2c(pts[1].nx, pts[1].ny);
        ctx.lineTo(p1.x, p1.y);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const cur  = this._n2c(pts[i].nx, pts[i].ny);
          const next = this._n2c(pts[i+1].nx, pts[i+1].ny);
          ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
        }
        const last = this._n2c(pts[pts.length-1].nx, pts[pts.length-1].ny);
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Chamado após resize do canvas (zoom PDF, troca de página)
  onCanvasResize() {
    this._redrawLocal();
    this._redrawRemote();
  }

  // ── Traços remotos (mensagens do celular) ─────────────────────────────────

  applyRemoteMessage(msg) {
    const ctx = this.rCtx;

    switch (msg.type) {
      case 'stroke:start': {
        const page = msg.page ?? this._currentPage;
        const s = { tool:msg.tool, color:msg.color, size:msg.size,
                    points:[{nx:msg.nx, ny:msg.ny}], page };
        this._remoteActive[msg.id] = s;

        // Só desenha se for a página atual
        if (page === this._currentPage) {
          ctx.save();
          this._applyStyle(ctx, msg.tool, msg.color, msg.size);
          const p = this._n2c(msg.nx, msg.ny);
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth/2), 0, Math.PI*2); ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'stroke:move': {
        const s = this._remoteActive[msg.id]; if (!s) break;
        const prevPt = s.points[s.points.length - 1];
        s.points.push({ nx: msg.nx, ny: msg.ny });

        if ((s.page ?? this._currentPage) === this._currentPage) {
          const a = this._n2c(prevPt.nx, prevPt.ny);
          const b = this._n2c(msg.nx, msg.ny);
          ctx.save();
          this._applyStyle(ctx, s.tool, s.color, s.size);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'stroke:end': {
        const s = this._remoteActive[msg.id];
        if (s) {
          const page = s.page ?? this._currentPage;
          this._remoteStrokesForPage(page).push(s);
        }
        delete this._remoteActive[msg.id];
        break;
      }

      case 'clear:remote':  this.clearRemote();     break;
      case 'clear:all':     this.clear();           break;
      case 'clear':
        this.clearMode === 'shared' ? this.clear() : this.clearRemote();
        break;

      case 'undo': {
        // Undo remoto: remove o último stroke da página atual
        const strokes = this._remoteStrokesForPage();
        if (strokes.length) {
          strokes.pop();
          this._redrawRemote();
          this._remoteActive = {};
        }
        break;
      }
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  exportPNG(opts = {}) {
    const { includeLocal = true, includeRemote = true } = opts;
    const w = this.lCanvas.width, h = this.lCanvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    tc.fillStyle = '#fff'; tc.fillRect(0, 0, w, h);
    const pdf = document.getElementById('pdf-canvas');
    if (pdf) tc.drawImage(pdf, 0, 0, w, h);
    if (includeLocal)  tc.drawImage(this.lCanvas, 0, 0, w, h);
    if (includeRemote && this.showRemote) tc.drawImage(this.rCanvas, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }

  /** Retorna um resumo das páginas com anotações (para UI) */
  getAnnotatedPages() {
    const pages = new Set();
    for (const [p, strokes] of this._localPages)  if (strokes.length) pages.add(p);
    for (const [p, strokes] of this._remotePages) if (strokes.length) pages.add(p);
    return [...pages].sort((a, b) => a - b);
  }
}
