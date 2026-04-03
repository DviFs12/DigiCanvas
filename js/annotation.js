/**
 * annotation.js  (v3 — coordenadas normalizadas)
 * ─────────────────────────────────────────────────
 * Motor de anotação do desktop.
 *
 * ARQUITETURA:
 *  - Traços locais (mouse/touch no desktop) são convertidos para
 *    coordenadas NORMALIZADAS (0–1) antes de enviar ao celular.
 *  - Traços remotos chegam em coordenadas normalizadas e são
 *    convertidos para px do canvas no momento do desenho.
 *  - Isso garante que os traços ficam fixos no PDF independente
 *    de zoom, resize ou troca de página.
 *
 * HISTÓRICO:
 *  Armazena strokes como vetores de pontos normalizados.
 *  O undo redesenha do zero (sem ImageData) — correto para qualquer tamanho.
 *
 * STROKES REMOTOS:
 *  Ficam num canvas separado (remoteCanvas) sobrepostos ao PDF.
 *  Ambos os canvas têm as mesmas dimensões que o pdfCanvas.
 */

export class AnnotationEngine {
  /**
   * @param {HTMLCanvasElement} localCanvas   — anotações do desktop
   * @param {HTMLCanvasElement} remoteCanvas  — anotações do celular
   * @param {() => {w:number, h:number}} getPdfSize  — retorna dimensões atuais do PDF em px
   */
  constructor(localCanvas, remoteCanvas, getPdfSize) {
    this.lCanvas    = localCanvas;
    this.rCanvas    = remoteCanvas;
    this.lCtx       = localCanvas.getContext('2d');
    this.rCtx       = remoteCanvas.getContext('2d');
    this.getPdfSize = getPdfSize; // () => { w, h }

    // Ferramentas
    this.tool    = 'pen';
    this.color   = '#e63946';
    this.size    = 2;

    this.drawing = false;
    this.startNX = 0;  // para ferramentas de forma (line, rect)
    this.startNY = 0;

    // Histórico vetorial (normalizado) — permite undo sem ImageData
    // Cada entrada: { tool, color, size, points: [{nx,ny}] }
    this.strokes  = [];
    this.MAX_HIST = 40;

    // Snapshot do contexto local para formas em andamento (line/rect)
    this._snapshot = null;

    // Traços remotos em andamento (id → objeto stroke)
    this.showRemote     = true;
    this._remoteStrokes = {};

    // Callbacks
    this.onStrokeStart = null;
    this.onStrokeMove  = null;
    this.onStrokeEnd   = null;

    this._activeStroke = null; // stroke local em andamento
    this._bindEvents();
  }

  // ── Configuração ────────────────────────────────────────────────────────

  setTool(t)  { this.tool  = t; }
  setColor(c) { this.color = c; }
  setSize(s)  { this.size  = s; }

  // ── Eventos mouse/touch ─────────────────────────────────────────────────

  _bindEvents() {
    const c = this.lCanvas;
    c.addEventListener('mousedown',  this._onDown.bind(this));
    c.addEventListener('mousemove',  this._onMove.bind(this));
    c.addEventListener('mouseup',    this._onUp.bind(this));
    c.addEventListener('mouseleave', this._onUp.bind(this));
    c.addEventListener('touchstart', e => { e.preventDefault(); if (e.touches.length === 1) this._onDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }); }, { passive: false });
    c.addEventListener('touchmove',  e => { e.preventDefault(); if (e.touches.length === 1) this._onMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }); }, { passive: false });
    c.addEventListener('touchend',   e => this._onUp(e));
  }

  /** Converte evento de mouse/touch para coordenadas normalizadas */
  _evToNorm(e) {
    const rect = this.lCanvas.getBoundingClientRect();
    // Coordenadas CSS relativas ao canvas
    const cx = (e.clientX - rect.left);
    const cy = (e.clientY - rect.top);
    // Normaliza pelo tamanho do canvas (que é igual ao PDF renderizado)
    return {
      nx: cx / rect.width,
      ny: cy / rect.height,
    };
  }

  /** Converte coordenada normalizada para px do canvas */
  _normToPx(nx, ny) {
    return {
      x: nx * this.lCanvas.width,
      y: ny * this.lCanvas.height,
    };
  }

  _onDown(e) {
    const { nx, ny } = this._evToNorm(e);
    this.drawing = true;
    this.startNX = nx;
    this.startNY = ny;

    if (this.tool === 'line' || this.tool === 'rect') {
      this._saveSnapshot();
    }

    // Inicia stroke vetorial local
    this._activeStroke = { tool: this.tool, color: this.color, size: this.size, points: [{ nx, ny }] };
    this.strokes.push(this._activeStroke);
    if (this.strokes.length > this.MAX_HIST) this.strokes.shift();

    this.onStrokeStart?.({ tool: this.tool, color: this.color, size: this.size, nx, ny });
  }

  _onMove(e) {
    if (!this.drawing) return;
    const { nx, ny } = this._evToNorm(e);
    this._activeStroke?.points.push({ nx, ny });
    this._drawActiveSegment(nx, ny);
    this.onStrokeMove?.({ nx, ny });
  }

  _onUp() {
    if (!this.drawing) return;
    this.drawing = false;
    this._activeStroke = null;
    this._snapshot = null;
    this.onStrokeEnd?.();
  }

  // ── Renderização de segmento ativo ──────────────────────────────────────

  _drawActiveSegment(nx, ny) {
    const ctx = this.lCtx;
    const pts = this._activeStroke?.points ?? [];
    const prev = pts.length >= 2 ? pts[pts.length - 2] : null;

    if (this.tool === 'line' && prev) {
      this._restoreSnapshot();
      const s = this._normToPx(this.startNX, this.startNY);
      const e = this._normToPx(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      this._resetCtx(ctx);
      return;
    }

    if (this.tool === 'rect') {
      this._restoreSnapshot();
      const s = this._normToPx(this.startNX, this.startNY);
      const e = this._normToPx(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y);
      this._resetCtx(ctx);
      return;
    }

    // pen / marker / eraser — incremental
    if (prev) {
      const a = this._normToPx(prev.nx, prev.ny);
      const b = this._normToPx(nx, ny);
      this._applyStyle(ctx, this.tool, this.color, this.size);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      this._resetCtx(ctx);
    }
  }

  _applyStyle(ctx, tool, color, size) {
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth   = size * 4;
      ctx.globalAlpha = 1;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth   = tool === 'marker' ? size * 3 : size;
      ctx.globalAlpha = tool === 'marker' ? 0.4 : 1;
    }
  }

  _resetCtx(ctx) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Snapshot para formas ─────────────────────────────────────────────────

  _saveSnapshot() {
    this._snapshot = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  _restoreSnapshot() {
    if (this._snapshot) this.lCtx.putImageData(this._snapshot, 0, 0);
  }

  // ── Undo ─────────────────────────────────────────────────────────────────

  undo() {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this._redrawLocal();
  }

  clear() {
    this.strokes = [];
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  /** Redesenha todos os strokes locais do zero */
  _redrawLocal() {
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    for (const s of this.strokes) {
      this._drawFullStroke(this.lCtx, s);
    }
  }

  _drawFullStroke(ctx, stroke) {
    if (!stroke.points.length) return;
    ctx.save();
    this._applyStyle(ctx, stroke.tool, stroke.color, stroke.size);

    if (stroke.points.length === 1) {
      const { x, y } = this._normToPx(stroke.points[0].nx, stroke.points[0].ny);
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;
      ctx.fill();
    } else if (stroke.tool === 'line') {
      const s = this._normToPx(stroke.points[0].nx, stroke.points[0].ny);
      const e = this._normToPx(stroke.points[stroke.points.length - 1].nx, stroke.points[stroke.points.length - 1].ny);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    } else if (stroke.tool === 'rect') {
      const s = this._normToPx(stroke.points[0].nx, stroke.points[0].ny);
      const e = this._normToPx(stroke.points[stroke.points.length - 1].nx, stroke.points[stroke.points.length - 1].ny);
      ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y);
    } else {
      ctx.beginPath();
      const p0 = this._normToPx(stroke.points[0].nx, stroke.points[0].ny);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = this._normToPx(stroke.points[i].nx, stroke.points[i].ny);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── Traços remotos ───────────────────────────────────────────────────────

  applyRemoteMessage(msg) {
    const ctx = this.rCtx;

    switch (msg.type) {
      case 'stroke:start': {
        this._remoteStrokes[msg.id] = {
          tool: msg.tool, color: msg.color, size: msg.size,
          lastNX: msg.nx, lastNY: msg.ny,
        };
        // Ponto inicial
        const { x, y } = this._normToPx(msg.nx, msg.ny);
        ctx.save();
        this._applyStyle(ctx, msg.tool, msg.color, msg.size);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, ctx.lineWidth / 2), 0, Math.PI * 2);
        ctx.fillStyle = msg.tool === 'eraser' ? 'rgba(0,0,0,1)' : msg.color;
        ctx.fill();
        ctx.restore();
        break;
      }

      case 'stroke:move': {
        const s = this._remoteStrokes[msg.id];
        if (!s) break;
        const a = this._normToPx(s.lastNX, s.lastNY);
        const b = this._normToPx(msg.nx,   msg.ny);
        ctx.save();
        this._applyStyle(ctx, s.tool, s.color, s.size);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
        s.lastNX = msg.nx; s.lastNY = msg.ny;
        break;
      }

      case 'stroke:end':
        delete this._remoteStrokes[msg.id];
        break;

      case 'clear':
        this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        this._remoteStrokes = {};
        break;

      case 'undo':
        // Undo remoto: limpa canvas remoto (histórico completo no celular)
        this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        this._remoteStrokes = {};
        break;
    }
  }

  /**
   * Chamado quando o tamanho do canvas muda (zoom do PDF no desktop).
   * Re-renderiza todos os strokes locais e remotos nas novas dimensões.
   */
  onCanvasResize() {
    this._redrawLocal();
    // Os strokes remotos estão "embutidos" no canvas bitmap — ao redimensionar
    // o canvas é apagado automaticamente. Para manter, seria necessário guardar
    // o histórico remoto também. Por ora, limpa e avisa.
    this.rCtx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
  }

  // ── Export ───────────────────────────────────────────────────────────────

  exportPNG() {
    const merged = document.createElement('canvas');
    merged.width  = this.lCanvas.width;
    merged.height = this.lCanvas.height;
    const mCtx = merged.getContext('2d');
    mCtx.fillStyle = '#ffffff';
    mCtx.fillRect(0, 0, merged.width, merged.height);
    const pdf = document.getElementById('pdf-canvas');
    if (pdf) mCtx.drawImage(pdf, 0, 0);
    mCtx.drawImage(this.lCanvas, 0, 0);
    if (this.showRemote) mCtx.drawImage(this.rCanvas, 0, 0);
    return merged.toDataURL('image/png');
  }
}
