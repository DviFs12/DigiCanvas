/**
 * annotation.js v4 — Motor de anotação com coordenadas normalizadas
 * ──────────────────────────────────────────────────────────────────
 * CORREÇÕES:
 *  - Bug #11: Borracha usa canvas de overlay separado (nunca apaga o fundo)
 *  - Bug #10: Modo "shared" e "separate" para limpar traços
 *  - Undo/redo robusto com pilha vetorial completa
 *  - applyRemoteMessage aceita 'redo' com redoStack
 *  - exportPNG aceita parâmetro { includeLocal, includeRemote }
 */

export const TOOLS = {
  pen:         { label:'Caneta',      opacity:1.0,  widthMul:1,  blend:'source-over'     },
  marker:      { label:'Marcador',    opacity:1.0,  widthMul:2,  blend:'source-over'     },
  highlighter: { label:'Marca-texto', opacity:0.35, widthMul:6,  blend:'source-over'     },
  eraser:      { label:'Borracha',    opacity:1.0,  widthMul:4,  blend:'destination-out' },
  line:        { label:'Linha',       opacity:1.0,  widthMul:1,  blend:'source-over'     },
  rect:        { label:'Retângulo',   opacity:1.0,  widthMul:1,  blend:'source-over'     },
};

// highlighter usa source-over com globalAlpha (multiply não funciona sobre canvas transparente)
// eraser usa destination-out APENAS no canvas de overlay — nunca atinge o pdf-canvas

export class AnnotationEngine {
  /**
   * @param {HTMLCanvasElement} localCanvas   – overlay do PC (sobre o PDF)
   * @param {HTMLCanvasElement} remoteCanvas  – overlay do celular
   * @param {()=>{w,h}} getPdfCssSize         – dimensões CSS do PDF renderizado
   */
  constructor(localCanvas, remoteCanvas, getPdfCssSize) {
    this.lCanvas      = localCanvas;
    this.rCanvas      = remoteCanvas;
    this.lCtx         = localCanvas.getContext('2d');
    this.rCtx         = remoteCanvas.getContext('2d');
    this.getPdfCssSize = getPdfCssSize;

    this.tool   = 'pen';
    this.color  = '#e63946';
    this.size   = 3;   // px CSS, independente do zoom do PDF
    this.active = true; // false = desabilita eventos (modo mover/resize no PC)

    this.drawing  = false;
    this._startNX = 0;
    this._startNY = 0;
    this._snapshot = null;

    // Histórico vetorial — undo/redo sem ImageData
    this.undoStack = [];  // strokes confirmados
    this.redoStack = [];
    this.MAX_HIST  = 60;

    // Strokes remotos em andamento
    this.showRemote     = true;
    this._remoteStrokes = {};
    this._remoteHistory = []; // para undo remoto correto

    // Modo de sincronia de limpeza: 'shared' | 'separate'
    this.clearMode = 'shared';

    // Callbacks
    this.onStrokeStart = null;
    this.onStrokeMove  = null;
    this.onStrokeEnd   = null;

    this._activeStroke = null;
    this._bindEvents();
  }

  // ── Configuração ─────────────────────────────────────────────────────────

  setTool(t)   { this.tool  = t; }
  setColor(c)  { this.color = c; }
  setSize(s)   { this.size  = Math.max(0.5, Math.min(200, s)); }
  setActive(b) { this.active = b; }

  // ── Eventos ──────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.lCanvas;
    c.addEventListener('mousedown',  e => { if (this.active) this._onDown(this._evNorm(e)); });
    c.addEventListener('mousemove',  e => { if (this.active && this.drawing) this._onMove(this._evNorm(e)); });
    c.addEventListener('mouseup',    () => { if (this.active) this._onUp(); });
    c.addEventListener('mouseleave', () => { if (this.active) this._onUp(); });
    c.addEventListener('touchstart', e => {
      if (!this.active) return;
      e.preventDefault();
      if (e.touches.length === 1) this._onDown(this._touchNorm(e.touches[0]));
    }, { passive: false });
    c.addEventListener('touchmove', e => {
      if (!this.active) return;
      e.preventDefault();
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

  // ── Handlers ─────────────────────────────────────────────────────────────

  _onDown({ nx, ny }) {
    this.drawing   = true;
    this._startNX  = nx;
    this._startNY  = ny;
    this.redoStack = [];

    if (this.tool === 'line' || this.tool === 'rect') this._saveSnapshot();

    this._activeStroke = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this.undoStack.push(this._activeStroke);
    if (this.undoStack.length > this.MAX_HIST) this.undoStack.shift();

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

  // ── Renderização incremental ──────────────────────────────────────────────

  _drawSegment(nx, ny) {
    const ctx  = this.lCtx;
    const pts  = this._activeStroke?.points ?? [];
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
    const dpr  = window.devicePixelRatio || 1;

    if (this.tool === 'line' && prev) {
      this._restoreSnapshot();
      const s = this._n2c(this._startNX, this._startNY, dpr);
      const ep = this._n2c(nx, ny, dpr);
      this._applyStyle(ctx, this.tool, this.color, this.size, dpr);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(ep.x, ep.y); ctx.stroke();
      this._resetCtx(ctx); return;
    }
    if (this.tool === 'rect') {
      this._restoreSnapshot();
      const s = this._n2c(this._startNX, this._startNY, dpr);
      const ep = this._n2c(nx, ny, dpr);
      this._applyStyle(ctx, this.tool, this.color, this.size, dpr);
      ctx.strokeRect(s.x, s.y, ep.x - s.x, ep.y - s.y);
      this._resetCtx(ctx); return;
    }
    if (prev) {
      const a = this._n2c(prev.nx, prev.ny, dpr);
      const b = this._n2c(nx, ny, dpr);
      this._applyStyle(ctx, this.tool, this.color, this.size, dpr);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      this._resetCtx(ctx);
    }
  }

  // Converte normalizado → px físico do canvas (inclui DPR)
  _n2c(nx, ny, dpr) {
    return { x: nx * this.lCanvas.width, y: ny * this.lCanvas.height };
  }

  _applyStyle(ctx, tool, color, size, dpr = 1) {
    const t = TOOLS[tool] ?? TOOLS.pen;
    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    // Bug #11: eraser usa destination-out SOMENTE no overlay (lCanvas/rCanvas)
    // O pdf-canvas está ABAIXO e não é afetado pelo composite operation do overlay
    ctx.globalCompositeOperation = t.blend;
    ctx.globalAlpha  = t.opacity;
    ctx.strokeStyle  = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    ctx.fillStyle    = ctx.strokeStyle;
    ctx.lineWidth    = size * t.widthMul * dpr;
  }

  _resetCtx(ctx) {
    ctx.restore();
  }

  _saveSnapshot() {
    this._snapshot = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
  }
  _restoreSnapshot() {
    if (this._snapshot) this.lCtx.putImageData(this._snapshot, 0, 0);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.undoStack.pop());
    this._redrawLocal();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.redoStack.pop());
    this._redrawLocal();
    return true;
  }

  /** Limpa apenas traços locais (PC) */
  clearLocal() {
    this.undoStack = []; this.redoStack = [];
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  /** Limpa apenas traços remotos (celular) */
  clearRemote() {
    this._remoteHistory = []; this._remoteStrokes = {};
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
  }

  /** Limpa tudo */
  clear() { this.clearLocal(); this.clearRemote(); }

  _redrawLocal() {
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    const dpr = window.devicePixelRatio || 1;
    for (const s of this.undoStack) this._drawFullStroke(this.lCtx, s, dpr);
  }

  _drawFullStroke(ctx, s, dpr = 1) {
    if (!s.points.length) return;
    ctx.save();
    this._applyStyle(ctx, s.tool, s.color, s.size, dpr);

    if (s.points.length === 1) {
      const p = this._n2c(s.points[0].nx, s.points[0].ny, dpr);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill();
    } else if (s.tool === 'line') {
      const a = this._n2c(s.points[0].nx, s.points[0].ny, dpr);
      const b = this._n2c(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny, dpr);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = this._n2c(s.points[0].nx, s.points[0].ny, dpr);
      const b = this._n2c(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny, dpr);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      ctx.beginPath();
      const p0 = this._n2c(s.points[0].nx, s.points[0].ny, dpr);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = this._n2c(s.points[i].nx, s.points[i].ny, dpr);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Traços remotos ────────────────────────────────────────────────────────

  applyRemoteMessage(msg) {
    const ctx = this.rCtx;
    const dpr = window.devicePixelRatio || 1;

    switch (msg.type) {
      case 'stroke:start': {
        const s = { tool: msg.tool, color: msg.color, size: msg.size, lastNX: msg.nx, lastNY: msg.ny, points: [{ nx: msg.nx, ny: msg.ny }] };
        this._remoteStrokes[msg.id] = s;
        this._remoteHistory.push(s);
        if (this._remoteHistory.length > this.MAX_HIST) this._remoteHistory.shift();
        const p = this._n2c(msg.nx, msg.ny, dpr);
        ctx.save();
        this._applyStyle(ctx, msg.tool, msg.color, msg.size, dpr);
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        break;
      }
      case 'stroke:move': {
        const s = this._remoteStrokes[msg.id]; if (!s) break;
        s.points.push({ nx: msg.nx, ny: msg.ny });
        const a = this._n2c(s.lastNX, s.lastNY, dpr);
        const b = this._n2c(msg.nx,   msg.ny,   dpr);
        ctx.save();
        this._applyStyle(ctx, s.tool, s.color, s.size, dpr);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
        s.lastNX = msg.nx; s.lastNY = msg.ny;
        break;
      }
      case 'stroke:end':
        delete this._remoteStrokes[msg.id];
        break;

      // Limpar remoto: respeita clearMode
      case 'clear:remote':
        this.clearRemote(); break;
      case 'clear:all':
        this.clear(); break;
      case 'clear':
        // legado: comportamento depende do clearMode
        if (this.clearMode === 'shared') this.clear();
        else this.clearRemote();
        break;

      // Undo remoto: remove o último stroke do histórico remoto e redesenha
      case 'undo': {
        if (!this._remoteHistory.length) break;
        this._remoteHistory.pop();
        this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        const dpr2 = window.devicePixelRatio || 1;
        for (const s of this._remoteHistory) this._drawFullStroke(this.rCtx, s, dpr2);
        this._remoteStrokes = {};
        break;
      }
      // Redo remoto: recebe o stroke inteiro para redesenhar
      case 'redo:stroke':
        if (msg.stroke) {
          this._remoteHistory.push(msg.stroke);
          this._drawFullStroke(this.rCtx, msg.stroke, window.devicePixelRatio || 1);
        }
        break;
    }
  }

  // Chamado quando o canvas é redimensionado (zoom PDF no desktop)
  onCanvasResize() {
    this._redrawLocal();
    // Redesenha remoto também
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
    const dpr = window.devicePixelRatio || 1;
    for (const s of this._remoteHistory) this._drawFullStroke(this.rCtx, s, dpr);
    this._remoteStrokes = {};
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * @param {{ includeLocal?: boolean, includeRemote?: boolean }} opts
   */
  exportPNG(opts = {}) {
    const { includeLocal = true, includeRemote = true } = opts;
    const w = this.lCanvas.width, h = this.lCanvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc  = tmp.getContext('2d');
    // Fundo branco
    tc.fillStyle = '#fff'; tc.fillRect(0, 0, w, h);
    // PDF
    const pdf = document.getElementById('pdf-canvas');
    if (pdf) tc.drawImage(pdf, 0, 0, w, h);
    // Anotações
    if (includeLocal)  tc.drawImage(this.lCanvas, 0, 0, w, h);
    if (includeRemote && this.showRemote) tc.drawImage(this.rCanvas, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }
}
