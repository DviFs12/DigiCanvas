/**
 * annotation.js
 * ─────────────
 * Motor de anotação vetorial para o canvas do desktop.
 * Gerencia traços locais e remotos.
 * Exporta strokes como PNG.
 */

export class AnnotationEngine {
  constructor(localCanvas, remoteCanvas) {
    this.lCanvas = localCanvas;
    this.rCanvas = remoteCanvas;
    this.lCtx    = localCanvas.getContext('2d');
    this.rCtx    = remoteCanvas.getContext('2d');

    // Estado do desenho
    this.tool    = 'pen';
    this.color   = '#e63946';
    this.size    = 2;
    this.opacity = 1;

    this.drawing   = false;
    this.startX    = 0;
    this.startY    = 0;

    // Histórico para undo (máx 30 estados)
    this.history   = [];
    this.MAX_HIST  = 30;

    // Snapshot para formas em andamento
    this._snapshot = null;

    // Remoto
    this.showRemote = true;
    this._remoteStrokes = {}; // id -> pontos em andamento

    this._bindEvents();
  }

  // ── Configuração ──────────────────────────────────────────────────────────

  setTool(tool)  { this.tool  = tool; }
  setColor(c)    { this.color = c; }
  setSize(s)     { this.size  = s; }

  // ── Eventos do Mouse ──────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.lCanvas;
    c.addEventListener('mousedown',  this._onDown.bind(this));
    c.addEventListener('mousemove',  this._onMove.bind(this));
    c.addEventListener('mouseup',    this._onUp.bind(this));
    c.addEventListener('mouseleave', this._onUp.bind(this));

    c.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: false });
    c.addEventListener('touchmove',  this._onTouchMove.bind(this),  { passive: false });
    c.addEventListener('touchend',   this._onTouchEnd.bind(this));
  }

  _getPos(e) {
    const rect = this.lCanvas.getBoundingClientRect();
    const scaleX = this.lCanvas.width  / rect.width;
    const scaleY = this.lCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }

  _onDown(e) {
    const { x, y } = this._getPos(e);
    this.drawing = true;
    this.startX  = x;
    this.startY  = y;
    this._lastX  = x;
    this._lastY  = y;

    this._saveSnapshot();

    if (this.tool === 'pen' || this.tool === 'marker' || this.tool === 'eraser') {
      this.lCtx.beginPath();
      this.lCtx.moveTo(x, y);
    }

    this.onStrokeStart?.({ tool: this.tool, color: this.color, size: this.size, x, y });
  }

  _onMove(e) {
    if (!this.drawing) return;
    const { x, y } = this._getPos(e);
    this._drawSegment(x, y);
    this._lastX = x;
    this._lastY = y;
    this.onStrokeMove?.({ x, y });
  }

  _onUp(e) {
    if (!this.drawing) return;
    this.drawing = false;
    this._pushHistory();
    this.onStrokeEnd?.();
  }

  // Touch
  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this._onDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this._onMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }
  }

  _onTouchEnd(e) { this._onUp(e); }

  // ── Desenho ────────────────────────────────────────────────────────────────

  _drawSegment(x, y) {
    const ctx = this.lCtx;

    if (this.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = this.size * 4;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = this.tool === 'marker' ? this.size * 3 : this.size;
      ctx.globalAlpha = this.tool === 'marker' ? 0.4 : 1;
    }

    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    if (this.tool === 'pen' || this.tool === 'marker' || this.tool === 'eraser') {
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
    } else if (this.tool === 'line') {
      this._restoreSnapshot();
      ctx.beginPath();
      ctx.moveTo(this.startX, this.startY);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else if (this.tool === 'rect') {
      this._restoreSnapshot();
      ctx.strokeRect(this.startX, this.startY, x - this.startX, y - this.startY);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Histórico ─────────────────────────────────────────────────────────────

  _saveSnapshot() {
    this._snapshot = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
  }

  _restoreSnapshot() {
    if (this._snapshot) {
      this.lCtx.putImageData(this._snapshot, 0, 0);
    }
  }

  _pushHistory() {
    const snap = this.lCtx.getImageData(0, 0, this.lCanvas.width, this.lCanvas.height);
    this.history.push(snap);
    if (this.history.length > this.MAX_HIST) this.history.shift();
  }

  undo() {
    if (this.history.length === 0) return;
    this.history.pop();
    if (this.history.length > 0) {
      this.lCtx.putImageData(this.history[this.history.length - 1], 0, 0);
    } else {
      this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    }
  }

  clear() {
    this.lCtx.clearRect(0, 0, this.lCanvas.width, this.lCanvas.height);
    this.history = [];
  }

  // ── Traços Remotos ────────────────────────────────────────────────────────

  applyRemoteMessage(msg) {
    if (!this.showRemote && msg.type !== 'clear' && msg.type !== 'undo') return;

    const ctx = this.rCtx;

    switch (msg.type) {
      case 'stroke:start':
        this._remoteStrokes[msg.id] = {
          tool:  msg.tool,
          color: msg.color,
          size:  msg.size,
          lastX: msg.x,
          lastY: msg.y,
        };
        // Ponto inicial (dot, para quando o usuário apenas toca)
        this._applyRemoteSegment(ctx, msg.id, msg.x, msg.y, true);
        break;

      case 'stroke:move': {
        const s = this._remoteStrokes[msg.id];
        if (!s) break;
        this._applyRemoteSegment(ctx, msg.id, msg.x, msg.y, false);
        s.lastX = msg.x;
        s.lastY = msg.y;
        break;
      }

      case 'stroke:end':
        delete this._remoteStrokes[msg.id];
        break;

      case 'clear':
        ctx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        this._remoteStrokes = {};
        break;

      case 'undo':
        // Undo remoto: limpa o canvas remoto (undo completo seria necessário
        // histórico completo do estado — por simplicidade limpamos)
        ctx.clearRect(0, 0, this.rCanvas.width, this.rCanvas.height);
        this._remoteStrokes = {};
        break;
    }
  }

  _applyRemoteSegment(ctx, id, x, y, isStart) {
    const s = this._remoteStrokes[id];
    if (!s) return;

    const prevOp    = ctx.globalCompositeOperation;
    const prevAlpha = ctx.globalAlpha;

    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth   = s.size * 4;
      ctx.globalAlpha = 1;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
      ctx.lineWidth   = s.tool === 'marker' ? s.size * 3 : s.size;
      ctx.globalAlpha = s.tool === 'marker' ? 0.4 : 1;
    }

    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    if (isStart) {
      // Ponto inicial: círculo pequeno
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(s.lastX, s.lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevOp;
  }

  // ── Exportar ──────────────────────────────────────────────────────────────

  exportPNG() {
    const merged = document.createElement('canvas');
    merged.width  = this.lCanvas.width;
    merged.height = this.lCanvas.height;
    const mCtx = merged.getContext('2d');

    // Fundo branco
    mCtx.fillStyle = '#ffffff';
    mCtx.fillRect(0, 0, merged.width, merged.height);

    // PDF
    const pdfCanvas = document.getElementById('pdf-canvas');
    if (pdfCanvas) mCtx.drawImage(pdfCanvas, 0, 0);

    // Anotações locais
    mCtx.drawImage(this.lCanvas, 0, 0);

    // Anotações remotas
    if (this.showRemote) mCtx.drawImage(this.rCanvas, 0, 0);

    return merged.toDataURL('image/png');
  }
}
