/**
 * renderer.js — Render loop desacoplado (requestAnimationFrame)
 * ──────────────────────────────────────────────────────────────
 * Gerencia o rendering do celular em camadas lógicas separadas.
 * Cada camada é um canvas independente — eraser nunca toca o fundo.
 *
 * CAMADAS (z-index crescente):
 *   bgCanvas    — fundo sólido ou xadrez
 *   thumbCanvas — miniatura do PDF (scroll com viewport)
 *   remCanvas   — traços recebidos do PC (layerPC)
 *   gridCanvas  — grade de referência
 *   drawCanvas  — traços do celular (layerMobile) + cursor
 *
 * STROKE FORMAT (normalizado — viaja pela rede):
 *   { id, tool, color, size, points: [{nx,ny},...] }
 *   nx,ny ∈ [0,1] relativo ao doc PDF
 */

import { Viewport } from './viewport.js';

export class MobileRenderer {
  /**
   * @param {{ bg, thumb, rem, grid, draw }} canvases — elementos canvas
   * @param {Viewport} vp — modelo de viewport
   */
  constructor(canvases, vp) {
    this.canvases = canvases;
    this.vp = vp;

    // Contextos
    this.ctx = {};
    for (const [k, c] of Object.entries(canvases)) {
      if (c) this.ctx[k] = c.getContext('2d');
    }

    // Estado de render
    this.bgMode      = 'pdf';   // 'pdf'|'dark'|'light'|'amoled'|'checkerboard'
    this.gridEnabled = false;
    this.pdfThumb    = null;    // HTMLImageElement

    // Histórico de strokes vetoriais
    this.layerPC     = [];  // strokes do PC, completos
    this.layerMobile = [];  // strokes do celular, completos
    this._activeStroke = null; // stroke local em andamento

    // Strokes remotos (PC) em andamento — keyed by id
    this._remoteActive = {};

    // rAF
    this._dirty = false;
    this._rafId = null;
    this._boundRender = this._render.bind(this);

    // TOOLS config
    this.TOOLS = {
      pen:         { opacity:1.0, widthMul:1,  blend:'source-over'    },
      marker:      { opacity:1.0, widthMul:2,  blend:'source-over'    },
      highlighter: { opacity:0.35,widthMul:6,  blend:'source-over'    },
      eraser:      { opacity:1.0, widthMul:5,  blend:'destination-out'},
    };
  }

  // ── Configuração ─────────────────────────────────────────────────────────

  setThumb(img)        { this.pdfThumb = img;       this.markDirty(); }
  setBgMode(mode)      { this.bgMode = mode;         this.markDirty(); }
  setGridEnabled(v)    { this.gridEnabled = v;       this.markDirty(); }
  markDirty()          { if (!this._dirty) { this._dirty = true; this._rafId = requestAnimationFrame(this._boundRender); } }

  // ── Resize ────────────────────────────────────────────────────────────────

  resize(w, h, dpr) {
    this._dpr = dpr;
    for (const c of Object.values(this.canvases)) {
      if (!c) continue;
      c.width  = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width  = w + 'px';
      c.style.height = h + 'px';
    }
    // Re-aplica transform DPR em todos os contextos
    for (const ctx of Object.values(this.ctx)) {
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.markDirty();
  }

  // ── rAF loop ──────────────────────────────────────────────────────────────

  _render() {
    this._dirty = false;
    this._rafId = null;
    const W = this.vp.scrW, H = this.vp.scrH;

    this._drawBg(W, H);
    this._drawThumb(W, H);
    this._drawLayer(this.ctx.rem,  this.layerPC,     'rem');
    this._drawGrid(W, H);
    this._drawLayer(this.ctx.draw, this.layerMobile, 'draw');
  }

  // ── Fundo ─────────────────────────────────────────────────────────────────

  _drawBg(W, H) {
    const c = this.ctx.bg; if (!c) return;
    c.clearRect(0, 0, W, H);
    if (this.bgMode === 'checkerboard') {
      const sz = 14;
      for (let y = 0; y < H; y += sz) for (let x = 0; x < W; x += sz) {
        c.fillStyle = ((x/sz + y/sz) % 2 === 0) ? '#c8c8c8' : '#f8f8f8';
        c.fillRect(x, y, sz, sz);
      }
    } else if (this.bgMode === 'light')  { c.fillStyle='#f8f8f5'; c.fillRect(0,0,W,H); }
    else if (this.bgMode === 'amoled')   { c.fillStyle='#000';    c.fillRect(0,0,W,H); }
    else { /* dark */ c.fillStyle='#1a1a2e'; c.fillRect(0,0,W,H); }
  }

  // ── Miniatura do PDF ──────────────────────────────────────────────────────

  _drawThumb(W, H) {
    const c = this.ctx.thumb; if (!c) return;
    c.clearRect(0, 0, W, H);
    if (this.bgMode !== 'pdf' || !this.pdfThumb) return;
    const vp = this.vp;
    // Posição e tamanho do doc inteiro na tela
    const dx = -vp.x * vp.z;
    const dy = -vp.y * vp.z;
    const dw =  vp.docW * vp.z;
    const dh =  vp.docH * vp.z;
    c.drawImage(this.pdfThumb, dx, dy, dw, dh);
  }

  // ── Grade ─────────────────────────────────────────────────────────────────

  _drawGrid(W, H) {
    const c = this.ctx.grid; if (!c) return;
    c.clearRect(0, 0, W, H);
    if (!this.gridEnabled) return;
    const step = 40 * this.vp.z;
    const offX = (-this.vp.x * this.vp.z) % step;
    const offY = (-this.vp.y * this.vp.z) % step;
    c.strokeStyle = 'rgba(124,106,247,0.22)';
    c.lineWidth   = 0.5;
    for (let x = ((offX % step) + step) % step; x < W; x += step) { c.beginPath(); c.moveTo(x,0); c.lineTo(x,H); c.stroke(); }
    for (let y = ((offY % step) + step) % step; y < H; y += step) { c.beginPath(); c.moveTo(0,y); c.lineTo(W,y); c.stroke(); }
  }

  // ── Desenho de uma camada ─────────────────────────────────────────────────

  _drawLayer(ctx, strokes, layer) {
    if (!ctx) return;
    ctx.clearRect(0, 0, this.vp.scrW, this.vp.scrH);
    for (const s of strokes) this._drawStroke(ctx, s);
    // Stroke em andamento
    if (layer === 'draw' && this._activeStroke) this._drawStroke(ctx, this._activeStroke);
    if (layer === 'rem') {
      for (const s of Object.values(this._remoteActive)) this._drawStroke(ctx, s);
    }
  }

  _drawStroke(ctx, s) {
    if (!s.points || s.points.length === 0) return;
    const t = this.TOOLS[s.tool] ?? this.TOOLS.pen;
    ctx.save();
    ctx.lineCap              = 'round';
    ctx.lineJoin             = 'round';
    ctx.globalCompositeOperation = t.blend;
    ctx.globalAlpha          = t.opacity;
    ctx.strokeStyle          = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
    ctx.fillStyle            = ctx.strokeStyle;
    ctx.lineWidth            = s.size * t.widthMul;

    const vp = this.vp;

    if (s.points.length === 1) {
      const sc = vp.normToScreen(s.points[0].nx, s.points[0].ny);
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === 'line') {
      const a = vp.normToScreen(s.points[0].nx, s.points[0].ny);
      const b = vp.normToScreen(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (s.tool === 'rect') {
      const a = vp.normToScreen(s.points[0].nx, s.points[0].ny);
      const b = vp.normToScreen(s.points[s.points.length-1].nx, s.points[s.points.length-1].ny);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      ctx.beginPath();
      const p0 = vp.normToScreen(s.points[0].nx, s.points[0].ny);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = vp.normToScreen(s.points[i].nx, s.points[i].ny);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── API de strokes locais (celular) ───────────────────────────────────────

  startStroke(tool, color, size, scrX, scrY) {
    const { nx, ny } = this.vp.screenToNorm(scrX, scrY);
    this._activeStroke = { tool, color, size, points: [{ nx, ny }] };
    this.markDirty();
    return { nx, ny };
  }

  continueStroke(scrX, scrY) {
    if (!this._activeStroke) return null;
    const { nx, ny } = this.vp.screenToNorm(scrX, scrY);
    this._activeStroke.points.push({ nx, ny });
    this.markDirty();
    return { nx, ny };
  }

  commitStroke() {
    if (!this._activeStroke) return;
    this.layerMobile.push(this._activeStroke);
    if (this.layerMobile.length > 200) this.layerMobile.shift();
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

  // ── API de strokes remotos (PC) ───────────────────────────────────────────

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
    if (this.layerPC.length > 200) this.layerPC.shift();
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
    this.layerPC = {};
    this._remoteActive = {};
    this.markDirty();
  }

  clearAll() {
    this.clearMobile();
    this.layerPC = [];
    this._remoteActive = {};
    this.markDirty();
  }

  // Rebake (ex: ao mudar viewport — relayout automático pelo rAF)
  rebake() { this.markDirty(); }
}
