/**
 * viewport.js — Modelo matemático do viewport do celular
 *
 * SISTEMA: doc coords (px CSS do PDF) ↔ screen coords (px CSS do canvas)
 * INVARIANTE: viewport nunca sai do documento.
 */
export class Viewport {
  constructor(docW = 794, docH = 1123, scrW = 400, scrH = 600) {
    this.docW = docW; this.docH = docH;
    this.scrW = scrW; this.scrH = scrH;
    this.x = 0; this.y = 0; this.z = 1;
    this._fit();
  }

  setDoc(w, h) {
    this.docW = w; this.docH = h;
    this.x = 0; this.y = 0;
    this._fit();
  }

  setScr(w, h) {
    this.scrW = w; this.scrH = h;
    this._fit();
    this._clamp();
  }

  get minZ() {
    if (!this.docW || !this.docH) return 0.1;
    return Math.min(this.scrW / this.docW, this.scrH / this.docH);
  }

  _fit() { this.z = this.minZ; this._clamp(); }

  _clamp() {
    this.z = Math.max(this.minZ, Math.min(20, this.z));
    const vw = this.scrW / this.z, vh = this.scrH / this.z;
    this.x = vw >= this.docW ? 0 : Math.max(0, Math.min(this.x, this.docW - vw));
    this.y = vh >= this.docH ? 0 : Math.max(0, Math.min(this.y, this.docH - vh));
  }

  // Zoom centrado em ponto da tela (sx, sy)
  zoomAt(newZ, sx, sy) {
    const cz = Math.max(this.minZ, Math.min(20, newZ));
    if (Math.abs(cz - this.z) < 1e-6) return;
    const fx = sx ?? this.scrW / 2;
    const fy = sy ?? this.scrH / 2;
    this.x += fx / this.z - fx / cz;
    this.y += fy / this.z - fy / cz;
    this.z = cz;
    this._clamp();
  }

  // Pan em pixels de tela
  pan(dx, dy) {
    this.x -= dx / this.z;
    this.y -= dy / this.z;
    this._clamp();
  }

  moveTo(docX, docY) { this.x = docX; this.y = docY; this._clamp(); }

  // Converte px de tela para coordenadas normalizadas [0-1]
  screenToNorm(sx, sy) {
    return {
      nx: (this.x + sx / this.z) / this.docW,
      ny: (this.y + sy / this.z) / this.docH,
    };
  }

  // Converte normalizado para px de tela
  normToScreen(nx, ny) {
    return {
      x: (nx * this.docW - this.x) * this.z,
      y: (ny * this.docH - this.y) * this.z,
    };
  }

  // Estado para enviar ao desktop
  toMsg() {
    const vw = this.scrW / this.z, vh = this.scrH / this.z;
    return {
      nx: this.x / this.docW,
      ny: this.y / this.docH,
      nw: Math.min(1, vw / this.docW),
      nh: Math.min(1, vh / this.docH),
      zoom: this.z,
    };
  }
}
