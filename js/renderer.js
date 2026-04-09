/**
 * renderer.js — Render loop com rAF
 *
 * CAMADAS (z-index crescente):
 *   bg    — fundo sólido / xadrez
 *   thumb — miniatura do PDF (acompanha viewport)
 *   rem   — traços do PC
 *   grid  — grade
 *   draw  — traços do celular (captura eventos)
 *
 * BUG CURVAS: usa quadraticCurveTo para suavizar linhas
 * BUG CLAMP: ao redesenhar, usa clipping para não vazar fora do doc
 */
import { Viewport } from './viewport.js';

export class MobileRenderer {
  constructor(canvases, vp) {
    this.canvases = canvases;
    this.vp = vp;
    this.ctx = {};
    for (const [k, c] of Object.entries(canvases)) {
      if (c) this.ctx[k] = c.getContext('2d');
    }
    this.bgMode      = 'pdf';
    this.gridEnabled = false;
    this.pdfThumb    = null;
    this.layerPC     = [];
    this.layerMobile = [];
    this._activeStroke  = null;
    this._remoteActive  = {};
    this._dirty  = false;
    this._rafId  = null;
    this._dpr    = 1;
    this._bound  = this._render.bind(this);

    this.TOOLS = {
      pen:         { opacity:1.0,  widthMul:1,   blend:'source-over'    },
      marker:      { opacity:1.0,  widthMul:2.5, blend:'source-over'    },
      highlighter: { opacity:0.35, widthMul:7,   blend:'source-over'    },
      eraser:      { opacity:1.0,  widthMul:5,   blend:'destination-out'},
    };
  }

  // ── Config ──────────────────────────────────────────────────────────────
  setThumb(img)     { this.pdfThumb = img;   this.markDirty(); }
  setBgMode(m)      { this.bgMode   = m;     this.markDirty(); }
  setGridEnabled(v) { this.gridEnabled = v;  this.markDirty(); }

  markDirty() {
    if (!this._dirty) {
      this._dirty = true;
      this._rafId = requestAnimationFrame(this._bound);
    }
  }

  resize(w, h, dpr) {
    this._dpr = dpr;
    for (const c of Object.values(this.canvases)) {
      if (!c) continue;
      c.width  = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width  = w + 'px';
      c.style.height = h + 'px';
    }
    // Reconstrói contextos após resize (reset automático do canvas)
    for (const [k, c] of Object.entries(this.canvases)) {
      if (c) this.ctx[k] = c.getContext('2d');
    }
    // NÃO aplicar setTransform aqui — usa scale no _render
    this.markDirty();
  }

  // ── rAF ──────────────────────────────────────────────────────────────────
  _render() {
    this._dirty = false;
    this._rafId = null;
    const W = this.vp.scrW, H = this.vp.scrH;
    this._drawBg(W, H);
    this._drawThumb(W, H);
    this._drawLayer(this.ctx.rem,  this.layerPC,     'rem',  W, H);
    this._drawGrid(W, H);
    this._drawLayer(this.ctx.draw, this.layerMobile, 'draw', W, H);
  }

  // ── Background ──────────────────────────────────────────────────────────
  _drawBg(W, H) {
    const c = this.ctx.bg; if (!c) return;
    c.clearRect(0, 0, W * this._dpr, H * this._dpr);
    if (this.bgMode === 'checkerboard') {
      const sz = 14 * this._dpr;
      for (let y = 0; y < H * this._dpr; y += sz)
        for (let x = 0; x < W * this._dpr; x += sz) {
          c.fillStyle = ((x/sz + y/sz) % 2 === 0) ? '#c0c0c0' : '#f0f0f0';
          c.fillRect(x, y, sz, sz);
        }
    } else if (this.bgMode === 'light')  { c.fillStyle = '#f8f8f5'; c.fillRect(0,0,W*this._dpr,H*this._dpr); }
    else if (this.bgMode === 'amoled')   { c.fillStyle = '#000';    c.fillRect(0,0,W*this._dpr,H*this._dpr); }
    else                                  { c.fillStyle = '#1a1a2e'; c.fillRect(0,0,W*this._dpr,H*this._dpr); }
  }

  // ── Thumb ────────────────────────────────────────────────────────────────
  _drawThumb(W, H) {
    const c = this.ctx.thumb; if (!c) return;
    const dpr = this._dpr;
    c.clearRect(0, 0, W * dpr, H * dpr);
    if (this.bgMode !== 'pdf' || !this.pdfThumb) return;
    const vp = this.vp;
    const dx = -vp.x * vp.z * dpr;
    const dy = -vp.y * vp.z * dpr;
    const dw =  vp.docW * vp.z * dpr;
    const dh =  vp.docH * vp.z * dpr;
    c.drawImage(this.pdfThumb, dx, dy, dw, dh);
  }

  // ── Grid ─────────────────────────────────────────────────────────────────
  _drawGrid(W, H) {
    const c = this.ctx.grid; if (!c) return;
    const dpr = this._dpr;
    c.clearRect(0, 0, W * dpr, H * dpr);
    if (!this.gridEnabled) return;
    const step = 40 * this.vp.z * dpr;
    const offX = ((-this.vp.x * this.vp.z * dpr) % step + step) % step;
    const offY = ((-this.vp.y * this.vp.z * dpr) % step + step) % step;
    c.strokeStyle = 'rgba(124,106,247,0.22)';
    c.lineWidth = 0.5 * dpr;
    for (let x = offX; x < W * dpr; x += step) { c.beginPath(); c.moveTo(x,0); c.lineTo(x,H*dpr); c.stroke(); }
    for (let y = offY; y < H * dpr; y += step) { c.beginPath(); c.moveTo(0,y); c.lineTo(W*dpr,y); c.stroke(); }
  }

  // ── Layer ────────────────────────────────────────────────────────────────
  _drawLayer(ctx, strokes, layer, W, H) {
    if (!ctx) return;
    const dpr = this._dpr;
    ctx.clearRect(0, 0, W * dpr, H * dpr);

    // Clipping: limita o desenho à área do documento para evitar vazar
    const vp = this.vp;
    const clipX = Math.max(0, -vp.x * vp.z * dpr);
    const clipY = Math.max(0, -vp.y * vp.z * dpr);
    const clipW = Math.min(W * dpr, vp.docW * vp.z * dpr - Math.max(0, vp.x * vp.z) * dpr);
    const clipH = Math.min(H * dpr, vp.docH * vp.z * dpr - Math.max(0, vp.y * vp.z) * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, clipY, clipW, clipH);
    ctx.clip();

    for (const s of strokes) this._stroke(ctx, s);
    if (layer === 'draw' && this._activeStroke) this._stroke(ctx, this._activeStroke);
    if (layer === 'rem') {
      for (const s of Object.values(this._remoteActive)) this._stroke(ctx, s);
    }
    ctx.restore();
  }

  // ── Desenho de um stroke ─────────────────────────────────────────────────
  _stroke(ctx, s) {
    if (!s?.points?.length) return;
    const dpr = this._dpr;
    const t   = this.TOOLS[s.tool] ?? this.TOOLS.pen;
    const vp  = this.vp;

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = t.blend;
    ctx.globalAlpha = t.opacity;
    ctx.strokeStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
    ctx.fillStyle   = ctx.strokeStyle;
    // Espessura em px de tela, independente do zoom do PDF no desktop
    ctx.lineWidth   = s.size * t.widthMul * dpr;

    const pts = s.points;

    if (pts.length === 1) {
      const sc = vp.normToScreen(pts[0].nx, pts[0].ny);
      ctx.beginPath();
      ctx.arc(sc.x * dpr, sc.y * dpr, Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore(); return;
    }

    if (s.tool === 'line') {
      const a = vp.normToScreen(pts[0].nx, pts[0].ny);
      const b = vp.normToScreen(pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.beginPath();
      ctx.moveTo(a.x * dpr, a.y * dpr);
      ctx.lineTo(b.x * dpr, b.y * dpr);
      ctx.stroke();
      ctx.restore(); return;
    }

    if (s.tool === 'rect') {
      const a = vp.normToScreen(pts[0].nx, pts[0].ny);
      const b = vp.normToScreen(pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.strokeRect(a.x*dpr, a.y*dpr, (b.x-a.x)*dpr, (b.y-a.y)*dpr);
      ctx.restore(); return;
    }

    // pen / marker / highlighter / eraser
    // FIX CURVAS: usa quadraticCurveTo com ponto médio para suavizar
    ctx.beginPath();
    const p0 = vp.normToScreen(pts[0].nx, pts[0].ny);
    ctx.moveTo(p0.x * dpr, p0.y * dpr);

    if (pts.length === 2) {
      const p1 = vp.normToScreen(pts[1].nx, pts[1].ny);
      ctx.lineTo(p1.x * dpr, p1.y * dpr);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const cur  = vp.normToScreen(pts[i].nx,   pts[i].ny);
        const next = vp.normToScreen(pts[i+1].nx, pts[i+1].ny);
        // Ponto médio entre cur e next = ponto de controle do arco
        const midX = (cur.x + next.x) / 2 * dpr;
        const midY = (cur.y + next.y) / 2 * dpr;
        ctx.quadraticCurveTo(cur.x * dpr, cur.y * dpr, midX, midY);
      }
      // Fecha no último ponto
      const last = vp.normToScreen(pts[pts.length-1].nx, pts[pts.length-1].ny);
      ctx.lineTo(last.x * dpr, last.y * dpr);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── API Strokes Locais ───────────────────────────────────────────────────
  startStroke(tool, color, size, scrX, scrY) {
    const { nx, ny } = this.vp.screenToNorm(scrX, scrY);
    this._activeStroke = { tool, color, size, points: [{ nx, ny }] };
    this.markDirty();
    return { nx, ny };
  }

  continueStroke(scrX, scrY) {
    if (!this._activeStroke) return null;
    const { nx, ny } = this.vp.screenToNorm(scrX, scrY);
    // Evita pontos duplicados muito próximos (reduz quadratura)
    const pts = this._activeStroke.points;
    const last = pts[pts.length - 1];
    // Distância mínima em espaço normalizado: ~0.5px na resolução do doc
    const minDist = 0.5 / Math.max(this.vp.docW, this.vp.docH);
    const dist = Math.hypot(nx - last.nx, ny - last.ny);
    if (dist < minDist) return { nx: last.nx, ny: last.ny }; // descarta ponto duplicado
    pts.push({ nx, ny });
    this.markDirty();
    return { nx, ny };
  }

  commitStroke() {
    if (!this._activeStroke) return;
    if (this._activeStroke.points.length > 0) {
      this.layerMobile.push(this._activeStroke);
      if (this.layerMobile.length > 300) this.layerMobile.shift();
    }
    this._activeStroke = null;
    this.markDirty();
  }

  cancelStroke() {
    this._activeStroke = null;
    this.markDirty();
  }

  undoMobile() {
    if (!this.layerMobile.length) return false;
    this.layerMobile.pop();
    this.markDirty();
    return true;
  }

  clearMobile() {
    this.layerMobile = [];
    this._activeStroke = null;
    this.markDirty();
  }

  // ── API Strokes Remotos ──────────────────────────────────────────────────
  remoteStart(id, tool, color, size, nx, ny) {
    this._remoteActive[id] = { tool, color, size, points: [{ nx, ny }] };
    this.markDirty();
  }

  remoteMove(id, nx, ny) {
    const s = this._remoteActive[id]; if (!s) return;
    s.points.push({ nx, ny });
    this.markDirty();
  }

  remoteEnd(id) {
    const s = this._remoteActive[id]; if (!s) return;
    this.layerPC.push(s);
    if (this.layerPC.length > 300) this.layerPC.shift();
    delete this._remoteActive[id];
    this.markDirty();
  }

  undoPC() {
    if (!this.layerPC.length) return false;
    this.layerPC.pop();
    this.markDirty();
    return true;
  }

  clearPC() {
    this.layerPC = [];
    this._remoteActive = {};
    this.markDirty();
  }

  clearAll() {
    this.clearMobile();
    this.clearPC();
  }

  rebake() { this.markDirty(); }
}
