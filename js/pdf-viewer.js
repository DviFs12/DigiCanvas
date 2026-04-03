/**
 * pdf-viewer.js — PDF.js wrapper com DPR, reload e thumbnail
 */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

export class PDFViewer {
  constructor(pdfCanvas) {
    this.canvas       = pdfCanvas;
    this.ctx          = pdfCanvas.getContext('2d');
    this.pdfDoc       = null;
    this.currentPage  = 1;
    this.totalPages   = 0;
    this.scale        = 1.0;
    this.rendering    = false;
    this._pendingPage = null;
    this._rawBuffer   = null; // guarda buffer para recarregar
    this.onRender     = null; // (page, total, viewport) => void
    this.onLoading    = null; // (bool) => void
  }

  // ── Carga ────────────────────────────────────────────────────────────────

  async loadFromBuffer(buffer) {
    if (!window.pdfjsLib) throw new Error('PDF.js não carregado');
    this._rawBuffer  = buffer;
    this.onLoading?.(true);
    try {
      const task = pdfjsLib.getDocument({ data: buffer.slice(0) });
      this.pdfDoc      = await task.promise;
      this.totalPages  = this.pdfDoc.numPages;
      this.currentPage = 1;
      await this.renderPage(1);
    } finally {
      this.onLoading?.(false);
    }
  }

  /** Recarrega o mesmo PDF (útil após troca de escala ou resize) */
  async reload() {
    if (this._rawBuffer) await this.loadFromBuffer(this._rawBuffer);
  }

  // ── Renderização ─────────────────────────────────────────────────────────

  async renderPage(pageNum) {
    if (!this.pdfDoc) return;
    if (this.rendering) { this._pendingPage = pageNum; return; }
    this.rendering   = true;
    this.currentPage = Math.min(Math.max(1, pageNum), this.totalPages);
    try {
      const dpr      = window.devicePixelRatio || 1;
      const page     = await this.pdfDoc.getPage(this.currentPage);
      const viewport = page.getViewport({ scale: this.scale * dpr });

      this.canvas.width  = viewport.width;
      this.canvas.height = viewport.height;
      this.canvas.style.width  = (viewport.width  / dpr) + 'px';
      this.canvas.style.height = (viewport.height / dpr) + 'px';

      // Sincroniza canvas sobrepõe
      document.querySelectorAll('#annotation-canvas,#remote-canvas,#grid-canvas').forEach(c => {
        c.width  = viewport.width;
        c.height = viewport.height;
        c.style.width  = (viewport.width  / dpr) + 'px';
        c.style.height = (viewport.height / dpr) + 'px';
      });

      await page.render({ canvasContext: this.ctx, viewport }).promise;
      this.onRender?.(this.currentPage, this.totalPages, viewport);
    } catch (e) {
      console.error('[PDFViewer]', e);
    } finally {
      this.rendering = false;
      if (this._pendingPage !== null) {
        const next = this._pendingPage; this._pendingPage = null;
        await this.renderPage(next);
      }
    }
  }

  // ── Navegação ─────────────────────────────────────────────────────────────

  async prevPage() { if (this.currentPage > 1) await this.renderPage(this.currentPage - 1); }
  async nextPage() { if (this.currentPage < this.totalPages) await this.renderPage(this.currentPage + 1); }
  async goToPage(n) { await this.renderPage(n); }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  async setScale(s) {
    this.scale = Math.min(Math.max(0.25, s), 4.0);
    await this.renderPage(this.currentPage);
    return this.scale;
  }
  async zoomIn(step = 0.25)  { return this.setScale(this.scale + step); }
  async zoomOut(step = 0.25) { return this.setScale(this.scale - step); }
  async fitToContainer(el) {
    if (!this.pdfDoc) return;
    const page = await this.pdfDoc.getPage(this.currentPage);
    const vp   = page.getViewport({ scale: 1 });
    const sw   = (el.clientWidth  - 32) / (vp.width  / (window.devicePixelRatio || 1));
    const sh   = (el.clientHeight - 32) / (vp.height / (window.devicePixelRatio || 1));
    return this.setScale(Math.min(sw, sh));
  }

  // ── Thumbnail ─────────────────────────────────────────────────────────────

  /** Gera miniatura JPEG da página atual, maxW px de largura */
  async getThumbnail(maxW = 400) {
    if (!this.pdfDoc) return null;
    const page  = await this.pdfDoc.getPage(this.currentPage);
    const vp1   = page.getViewport({ scale: 1 });
    const scale = maxW / vp1.width;
    const vp    = page.getViewport({ scale });
    const tmp   = document.createElement('canvas');
    tmp.width   = vp.width; tmp.height = vp.height;
    await page.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    return tmp.toDataURL('image/jpeg', 0.75);
  }

  get pageSize() { return { width: this.canvas.width, height: this.canvas.height }; }
  get cssSize()  {
    const dpr = window.devicePixelRatio || 1;
    return { width: this.canvas.width / dpr, height: this.canvas.height / dpr };
  }
}
