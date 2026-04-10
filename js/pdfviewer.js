/**
 * pdfviewer.js — PDF.js wrapper
 * Renderiza páginas com DPR, suporta zoom e navegação.
 */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

export class PDFViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.doc    = null;
    this.page   = 1;
    this.total  = 0;
    this.scale  = 1.0;
    this._busy  = false;
    this._queue = null;
    this.onRender = null; // (page, total) => void
  }

  async load(buffer) {
    if (!window.pdfjsLib) throw new Error('PDF.js não carregado');
    this.doc   = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    this.total = this.doc.numPages;
    this.page  = 1;
    await this._render(1);
  }

  async _render(n) {
    if (!this.doc) return;
    if (this._busy) { this._queue = n; return; }
    this._busy = true;
    this.page  = Math.min(Math.max(1, n), this.total);
    const dpr  = window.devicePixelRatio || 1;
    const pg   = await this.doc.getPage(this.page);
    const vp   = pg.getViewport({ scale: this.scale * dpr });
    this.canvas.width  = vp.width;
    this.canvas.height = vp.height;
    this.canvas.style.width  = (vp.width  / dpr) + 'px';
    this.canvas.style.height = (vp.height / dpr) + 'px';
    await pg.render({ canvasContext: this.ctx, viewport: vp }).promise;
    this._busy = false;
    this.onRender?.(this.page, this.total);
    if (this._queue !== null) {
      const q = this._queue; this._queue = null; await this._render(q);
    }
  }

  async goto(n)    { await this._render(n); }
  async prev()     { if (this.page > 1)           await this._render(this.page - 1); }
  async next()     { if (this.page < this.total)  await this._render(this.page + 1); }
  async zoom(s)    { this.scale = Math.min(4, Math.max(0.25, s)); await this._render(this.page); }
  async zoomIn()   { await this.zoom(this.scale + 0.25); }
  async zoomOut()  { await this.zoom(this.scale - 0.25); }

  async fit(wrapper) {
    if (!this.doc) return;
    const pg = await this.doc.getPage(this.page);
    const vp = pg.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const sw = (wrapper.clientWidth  - 32) / (vp.width  / dpr);
    const sh = (wrapper.clientHeight - 32) / (vp.height / dpr);
    await this.zoom(Math.min(sw, sh));
  }

  async thumbnail(maxW = 400) {
    if (!this.doc) return null;
    const pg = await this.doc.getPage(this.page);
    const vp1 = pg.getViewport({ scale: 1 });
    const s   = maxW / vp1.width;
    const vp  = pg.getViewport({ scale: s });
    const tmp = document.createElement('canvas');
    tmp.width = vp.width; tmp.height = vp.height;
    await pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    return tmp.toDataURL('image/jpeg', 0.75);
  }

  get cssW() { return this.canvas.width  / (window.devicePixelRatio || 1); }
  get cssH() { return this.canvas.height / (window.devicePixelRatio || 1); }
}
