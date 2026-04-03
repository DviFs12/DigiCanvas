/**
 * annotation.js — Motor de anotação com coordenadas normalizadas
 * ────────────────────────────────────────────────────────────────
 * FERRAMENTAS: pen, marker, highlighter, eraser, line, rect
 * COORDENADAS: normalizadas (0–1) relativas ao tamanho do PDF
 * HISTÓRICO: vetorial, suporta undo/redo sem ImageData
 */

export const TOOLS = {
  pen:         { label: 'Caneta',      opacity: 1.0,  widthMul: 1,   blendMode: 'source-over'  },
  marker:      { label: 'Marcador',    opacity: 1.0,  widthMul: 2,   blendMode: 'source-over'  },
  highlighter: { label: 'Marca-texto', opacity: 0.35, widthMul: 6,   blendMode: 'multiply'     },
  eraser:      { label: 'Borracha',    opacity: 1.0,  widthMul: 4,   blendMode: 'destination-out' },
  line:        { label: 'Linha',       opacity: 1.0,  widthMul: 1,   blendMode: 'source-over'  },
  rect:        { label: 'Retângulo',   opacity: 1.0,  widthMul: 1,   blendMode: 'source-over'  },
};

export class AnnotationEngine {
  constructor(localCanvas, remoteCanvas, getPdfCssSize) {
    this.lCanvas      = localCanvas;
    this.rCanvas      = remoteCanvas;
    this.lCtx         = localCanvas.getContext('2d');
    this.rCtx         = remoteCanvas.getContext('2d');
    this.getPdfCssSize = getPdfCssSize; // () => {w, h} em CSS px

    this.tool    = 'pen';
    this.color   = '#e63946';
    this.size    = 3;  // base em CSS px (independente do zoom do PDF)

    this.drawing   = false;
    this._startNX  = 0;
    this._startNY  = 0;
    this._snapshot = null;

    // Histórico vetorial local
    this.undoStack = [];
    this.redoStack = [];
    this.MAX_HIST  = 50;

    // Strokes remotos em andamento
    this.showRemote     = true;
    this._remoteStrokes = {};

    // Callbacks para sincronização
    this.onStrokeStart = null;
    this.onStrokeMove  = null;
    this.onStrokeEnd   = null;

    this._activeStroke = null;
    this._bindEvents();
  }

  // ── Configuração ────────────────────────────────────────────────────────

  setTool(t)  { this.tool  = t; }
  setColor(c) { this.color = c; }
  setSize(s)  { this.size  = s; }

  // ── Eventos mouse/touch ─────────────────────────────────────────────────

  _bindEvents() {
    const c = this.lCanvas;
    const on = (ev, fn, opt) => c.addEventListener(ev, fn, opt);
    on('mousedown',  e => this._onDown(this._evToNorm(e)));
    on('mousemove',  e => { if (this.drawing) this._onMove(this._evToNorm(e)); });
    on('mouseup',    () => this._onUp());
    on('mouseleave', () => this._onUp());
    on('touchstart', e => { e.preventDefault(); if (e.touches.length === 1) this._onDown(this._touchNorm(e.touches[0])); }, { passive: false });
    on('touchmove',  e => { e.preventDefault(); if (e.touches.length === 1 && this.drawing) this._onMove(this._touchNorm(e.touches[0])); }, { passive: false });
    on('touchend',   () => this._onUp());
  }

  _evToNorm(e) {
    const r = this.lCanvas.getBoundingClientRect();
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  }

  _touchNorm(t) {
    const r = this.lCanvas.getBoundingClientRect();
    return { nx: (t.clientX - r.left) / r.width, ny: (t.clientY - r.top) / r.height };
  }

  _normToPx(nx, ny) {
    // Usa dimensões CSS do canvas (sem DPR) para calcular px de desenho
    const dpr = window.devicePixelRatio || 1;
    return { x: nx * this.lCanvas.width / dpr, y: ny * this.lCanvas.height / dpr };
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  _onDown({ nx, ny }) {
    this.drawing   = true;
    this._startNX  = nx;
    this._startNY  = ny;
    this.redoStack = []; // nova ação limpa redo

    if (this.tool === 'line' || this.tool === 'rect') {
      this._saveSnapshot();
    }

    this._activeStroke = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this.undoStack.push(this._activeStroke);
    if (this.undoStack.length > this.MAX_HIST) this.undoStack.shift();

    this.onStrokeStart?.({ tool: this.tool, color: this.color, size: this.size, nx, ny });
  }

  _onMove({ nx, ny }) {
    this._activeStroke?.points.push({ nx, ny });
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

  // ── Desenho incremental ──────────────────────────────────────────────────

  _drawSegment(nx, ny) {
    const ctx  = this.lCtx;
    const dpr  = window.devicePixelRatio || 1;
    const pts  = this._activeStroke?.points ?? [];
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;

    if (this.tool === 'line' && prev) {
      this._restoreSnapshot();
      const s = this._normToPx(this._startNX, this._startNY);
      const e = this._normToPx(nx, ny);
      this._styleCtx(ctx, this.tool, this.color, this.size, dpr);
      ctx.beginPath(); ctx.moveTo(s.x * dpr, s.y * dpr); ctx.lineTo(e.x * dpr, e.y * dpr); ctx.stroke();
      this._resetCtx(ctx);
      return;
    }
    if (this.tool === 'rect') {
      this._restoreSnapshot();
      const s = this._normToPx(this._startNX, this._startNY);
      const e = this._normToPx(nx, ny);
      this._styleCtx(ctx, this.tool, this.color, this.size, dpr);
      ctx.strokeRect(s.x * dpr, s.y * dpr, (e.x - s.x) * dpr, (e.y - s.y) * dpr);
      this._resetCtx(ctx);
      return;
    }
    if (prev) {
      const a = this._normToPx(prev.nx, prev.ny);
      const b = this._normToPx(nx, ny);
      this._styleCtx(ctx, this.tool, this.color, this.size, dpr);
      ctx.beginPath(); ctx.moveTo(a.x * dpr, a.y * dpr); ctx.lineTo(b.x * dpr, b.y * dpr); ctx.stroke();
      this._resetCtx(ctx);
    }
  }

  _styleCtx(ctx, tool, color, size, dpr = 1) {
    const t = TOOLS[tool] ?? TOOLS.pen;
    ctx.lineCap              = 'round';
    ctx.lineJoin             = 'round';
    ctx.globalCompositeOperation = t.blendMode;
    ctx.globalAlpha          = t.opacity;
    ctx.strokeStyle          = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    ctx.fillStyle            = ctx.strokeStyle;
    ctx.lineWidth            = size * t.widthMul * dpr;
  }

  _resetCtx(ctx) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _saveSnapshot() {
    this._snapshot = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
  }
  _restoreSnapshot() {
    if (this._snapshot) this.lCtx.putImageData(this._snapshot, 0, 0);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────

  undo() {
    if (!this.undoStack.length) return;
    const stroke = this.undoStack.pop();
    this.redoStack.push(stroke);
    this._redrawLocal();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return;
    const stroke = this.redoStack.pop();
    this.undoStack.push(stroke);
    this._redrawLocal();
    return true;
  }

  clear() {
    this.undoStack = []; this.redoStack = [];
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  _redrawLocal() {
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    for (const s of this.undoStack) this._drawFullStroke(this.lCtx, s);
  }

  _drawFullStroke(ctx, s) {
    if (!s.points.length) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    this._styleCtx(ctx, s.tool, s.color, s.size, dpr);

    if (s.points.length === 1) {
      const p = this._normToPxCtx(s.points[0].nx, s.points[0].ny, dpr);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === 'line') {
      const a = this._normToPxCtx(s.points[0].nx, s.points[0].ny, dpr);
      const b = this._normToPxCtx(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny, dpr);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = this._normToPxCtx(s.points[0].nx, s.points[0].ny, dpr);
      const b = this._normToPxCtx(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny, dpr);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      ctx.beginPath();
      const p0 = this._normToPxCtx(s.points[0].nx, s.points[0].ny, dpr);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = this._normToPxCtx(s.points[i].nx, s.points[i].ny, dpr);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _normToPxCtx(nx, ny, dpr) {
    return { x: nx * this.lCanvas.width, y: ny * this.lCanvas.height };
  }

  // ── Remoto ───────────────────────────────────────────────────────────────

  applyRemoteMessage(msg) {
    const ctx = this.rCtx;
    const dpr = window.devicePixelRatio || 1;

    switch (msg.type) {
      case 'stroke:start': {
        this._remoteStrokes[msg.id] = { tool: msg.tool, color: msg.color, size: msg.size, lastNX: msg.nx, lastNY: msg.ny };
        const { x, y } = this._normToPxCtx(msg.nx, msg.ny, dpr);
        ctx.save();
        this._styleCtx(ctx, msg.tool, msg.color, msg.size, dpr);
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, ctx.lineWidth/2), 0, Math.PI*2); ctx.fill();
        ctx.restore();
        break;
      }
      case 'stroke:move': {
        const s = this._remoteStrokes[msg.id]; if (!s) break;
        const a = this._normToPxCtx(s.lastNX, s.lastNY, dpr);
        const b = this._normToPxCtx(msg.nx,   msg.ny,   dpr);
        ctx.save();
        this._styleCtx(ctx, s.tool, s.color, s.size, dpr);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
        s.lastNX = msg.nx; s.lastNY = msg.ny;
        break;
      }
      case 'stroke:end':   delete this._remoteStrokes[msg.id]; break;
      case 'clear':
      case 'undo':
        this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        this._remoteStrokes = {};
        break;
    }
  }

  onCanvasResize() {
    this._redrawLocal();
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
    this._remoteStrokes = {};
  }

  exportPNG() {
    const dpr = window.devicePixelRatio || 1;
    const w   = this.lCanvas.width, h = this.lCanvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc  = tmp.getContext('2d');
    tc.fillStyle = '#fff'; tc.fillRect(0, 0, w, h);
    const pdf = document.getElementById('pdf-canvas');
    if (pdf) tc.drawImage(pdf, 0, 0, w, h);
    tc.drawImage(this.lCanvas, 0, 0, w, h);
    if (this.showRemote) tc.drawImage(this.rCanvas, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }
}
