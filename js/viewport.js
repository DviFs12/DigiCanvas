/**
 * viewport.js — Modelo matemático do viewport
 *
 * SISTEMA DE COORDENADAS:
 *   doc space:    px CSS do PDF (origem no canto sup-esq)
 *   norm space:   [0,1] relativo ao doc (nx = docX/docW)
 *   screen space: px CSS do canvas do celular
 *
 * INVARIANTE: o viewport NUNCA sai do documento.
 * ZOOM MÍNIMO: viewport não pode ficar maior que o documento.
 * ZOOM MÁXIMO: 20×
 */
export class Viewport {
  constructor(docW, docH, scrW, scrH) {
    this.docW = docW; this.docH = docH;
    this.scrW = scrW; this.scrH = scrH;
    this.x = 0; this.y = 0; this.z = 1.0;
  }

  setDocSize(w, h) {
    this.docW = w; this.docH = h;
    // Reseta viewport ao trocar de PDF
    this.x = 0; this.y = 0;
    // Zoom "fit": encaixa o doc inteiro na tela
    this.z = Math.min(this.scrW / this.docW, this.scrH / this.docH);
    this.clamp();
  }

  setScrSize(w, h) {
    this.scrW = w; this.scrH = h;
    this.clamp();
  }

  // Zoom mínimo = encaixa o doc inteiro na tela (não pode ver "além" do doc)
  get minZoom() {
    if (this.docW <= 0 || this.docH <= 0) return 0.01;
    return Math.min(this.scrW / this.docW, this.scrH / this.docH);
  }

  get maxZoom() { return 20; }

  /** Zoom centrado em (focusX, focusY) em screen space */
  zoomAt(newZ, focusX, focusY) {
    const clamped = Math.max(this.minZoom, Math.min(this.maxZoom, newZ));
    if (Math.abs(clamped - this.z) < 1e-9) return;
    const fx = focusX ?? this.scrW / 2;
    const fy = focusY ?? this.scrH / 2;
    // Mantém o ponto de foco fixo na tela
    this.x += fx / this.z - fx / clamped;
    this.y += fy / this.z - fy / clamped;
    this.z = clamped;
    this.clamp();
  }

  /** Pan em screen space */
  panBy(dx, dy) {
    this.x -= dx / this.z;
    this.y -= dy / this.z;
    this.clamp();
  }

  moveTo(docX, docY) {
    this.x = docX; this.y = docY;
    this.clamp();
  }

  /** INVARIANTE CENTRAL — chamado após toda operação */
  clamp() {
    this.z = Math.max(this.minZoom, Math.min(this.maxZoom, this.z));
    const visW = this.scrW / this.z;
    const visH = this.scrH / this.z;

    // Se o documento cabe todo na tela, ancora em 0
    if (visW >= this.docW) {
      this.x = 0;
    } else {
      this.x = Math.max(0, Math.min(this.x, this.docW - visW));
    }
    if (visH >= this.docH) {
      this.y = 0;
    } else {
      this.y = Math.max(0, Math.min(this.y, this.docH - visH));
    }
  }

  // ── Conversões ────────────────────────────────────────────────────────

  docToScreen(docX, docY) {
    return { x: (docX - this.x) * this.z, y: (docY - this.y) * this.z };
  }
  screenToDoc(scrX, scrY) {
    return { x: this.x + scrX / this.z, y: this.y + scrY / this.z };
  }
  normToDoc(nx, ny)   { return { x: nx * this.docW, y: ny * this.docH }; }
  docToNorm(docX, docY) { return { nx: docX / this.docW, ny: docY / this.docH }; }

  screenToNorm(scrX, scrY) {
    const d = this.screenToDoc(scrX, scrY);
    return this.docToNorm(d.x, d.y);
  }
  normToScreen(nx, ny) {
    const d = this.normToDoc(nx, ny);
    return this.docToScreen(d.x, d.y);
  }

  toNormState() {
    const visW = this.scrW / this.z;
    const visH = this.scrH / this.z;
    return {
      nx: this.x / this.docW,
      ny: this.y / this.docH,
      nw: Math.min(1, visW / this.docW),
      nh: Math.min(1, visH / this.docH),
      zoom: this.z,
    };
  }
}
