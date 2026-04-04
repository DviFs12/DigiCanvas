/**
 * viewport.js — Modelo matemático do viewport
 * ─────────────────────────────────────────────
 * SISTEMA DE COORDENADAS:
 *
 *   Espaço do documento (doc space):
 *     Origem no canto superior esquerdo do PDF.
 *     Unidade: px CSS a 1× (independe do DPR e do zoom do viewer).
 *     pdfDocW × pdfDocH (recebido via pdf:size do desktop).
 *
 *   Espaço normalizado (norm space):
 *     nx = docX / pdfDocW  ∈ [0, 1]
 *     ny = docY / pdfDocH  ∈ [0, 1]
 *
 *   Espaço de tela / canvas CSS (screen space):
 *     Pixels CSS do canvas do celular.
 *     screenX = (docX - vpX) * vpZ
 *
 * PROPRIEDADES DO VIEWPORT:
 *   vpX, vpY  — posição do canto superior esquerdo em doc space
 *   vpZ       — fator de zoom (1 = 1 doc-px = 1 screen-px)
 *
 * INVARIANTE DO CLAMP:
 *   Para qualquer zoom z e tela W×H:
 *     visW = W / z   (largura visível em doc space)
 *     visH = H / z
 *     if (visW >= docW) → vpX = 0   (viewport maior que o doc: ancora)
 *     else              → vpX ∈ [0, docW - visW]
 *     (idem para Y)
 *
 * ZOOM MÍNIMO:
 *   Nunca permite zoom tão baixo que o viewport fique menor que 1% do doc.
 *   zpMin = max(0.01, screenW/(docW*100), screenH/(docH*100))
 */

export class Viewport {
  /**
   * @param {number} docW  – largura do documento em px CSS
   * @param {number} docH  – altura do documento em px CSS
   * @param {number} scrW  – largura da tela/canvas em px CSS
   * @param {number} scrH  – altura da tela/canvas em px CSS
   */
  constructor(docW, docH, scrW, scrH) {
    this.docW = docW;
    this.docH = docH;
    this.scrW = scrW;
    this.scrH = scrH;

    this.x = 0;   // doc space
    this.y = 0;
    this.z = 1.0; // zoom
  }

  /** Atualiza dimensões do documento (ex: ao trocar PDF) */
  setDocSize(w, h) {
    this.docW = w; this.docH = h;
    this.x = 0; this.y = 0; this.z = 1;
    this.clamp();
  }

  /** Atualiza dimensões da tela (ex: resize do canvas) */
  setScrSize(w, h) {
    this.scrW = w; this.scrH = h;
    this.clamp();
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  get minZoom() {
    // Garante que a visão nunca ultrapassa 100× o tamanho do doc
    return Math.max(0.01, this.scrW / (this.docW * 100), this.scrH / (this.docH * 100));
  }

  get maxZoom() { return 20; }

  /** Aplica zoom centrado em (focusX, focusY) em screen space */
  zoomAt(newZ, focusX, focusY) {
    newZ = Math.max(this.minZoom, Math.min(this.maxZoom, newZ));
    if (newZ === this.z) return;
    // Converte o ponto de foco para doc space antes e depois do zoom
    // doc_before = vp.x + focus / vp.z
    // doc_after  = vp.x' + focus / newZ
    // Para que o ponto de foco não se mova: doc_before = doc_after
    // → vp.x' = vp.x + focus/vp.z - focus/newZ
    const fx = focusX ?? this.scrW / 2;
    const fy = focusY ?? this.scrH / 2;
    this.x += fx / this.z - fx / newZ;
    this.y += fy / this.z - fy / newZ;
    this.z  = newZ;
    this.clamp();
  }

  // ── Pan ───────────────────────────────────────────────────────────────────

  /** Move em screen space (dx, dy em px CSS) */
  panBy(dx, dy) {
    this.x -= dx / this.z;
    this.y -= dy / this.z;
    this.clamp();
  }

  /** Move para uma posição absoluta em doc space */
  moveTo(docX, docY) {
    this.x = docX; this.y = docY;
    this.clamp();
  }

  // ── Clamp — INVARIANTE CENTRAL ────────────────────────────────────────────

  clamp() {
    // Garante zoom dentro dos limites
    this.z = Math.max(this.minZoom, Math.min(this.maxZoom, this.z));

    const visW = this.scrW / this.z;
    const visH = this.scrH / this.z;

    // Eixo X
    if (visW >= this.docW) {
      this.x = 0; // viewport maior que o doc: ancora na origem
    } else {
      this.x = Math.max(0, Math.min(this.x, this.docW - visW));
    }

    // Eixo Y
    if (visH >= this.docH) {
      this.y = 0;
    } else {
      this.y = Math.max(0, Math.min(this.y, this.docH - visH));
    }
  }

  // ── Conversões de coordenadas ─────────────────────────────────────────────

  /** doc → screen */
  docToScreen(docX, docY) {
    return { x: (docX - this.x) * this.z, y: (docY - this.y) * this.z };
  }

  /** screen → doc */
  screenToDoc(scrX, scrY) {
    return { x: this.x + scrX / this.z, y: this.y + scrY / this.z };
  }

  /** norm → doc */
  normToDoc(nx, ny) {
    return { x: nx * this.docW, y: ny * this.docH };
  }

  /** doc → norm */
  docToNorm(docX, docY) {
    return { nx: docX / this.docW, ny: docY / this.docH };
  }

  /** screen → norm (composição screen→doc→norm) */
  screenToNorm(scrX, scrY) {
    const d = this.screenToDoc(scrX, scrY);
    return this.docToNorm(d.x, d.y);
  }

  /** norm → screen */
  normToScreen(nx, ny) {
    const d = this.normToDoc(nx, ny);
    return this.docToScreen(d.x, d.y);
  }

  // ── Snapshot normalizado (para broadcast) ─────────────────────────────────

  /** Retorna o estado atual em coordenadas normalizadas */
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

  /** Restaura estado a partir de coordenadas normalizadas (recebido do peer) */
  fromNormState({ nx, ny, nw, nh }) {
    // Calcula zoom a partir de nw/nh para que a visão normalized corresponda à tela
    if (nw > 0 && nh > 0) {
      const zFromW = this.scrW / (nw * this.docW);
      const zFromH = this.scrH / (nh * this.docH);
      this.z = Math.min(zFromW, zFromH);
    }
    this.x = nx * this.docW;
    this.y = ny * this.docH;
    this.clamp();
  }
}
