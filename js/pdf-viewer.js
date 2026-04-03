/**
 * pdf-viewer.js
 * ─────────────
 * Gerencia a renderização do PDF usando PDF.js.
 * Expõe estado (currentPage, totalPages, scale) e métodos de navegação.
 */

// Worker do PDF.js (CDN)
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

export class PDFViewer {
  constructor(pdfCanvas) {
    this.canvas      = pdfCanvas;
    this.ctx         = pdfCanvas.getContext('2d');
    this.pdfDoc      = null;
    this.currentPage = 1;
    this.totalPages  = 0;
    this.scale       = 1.0;
    this.rendering   = false;
    this._pendingPage = null;
    this.onRender    = null; // callback após renderizar
  }

  // ── Carrega PDF de um ArrayBuffer ──────────────────────────────────────────

  async loadFromBuffer(buffer) {
    if (!window.pdfjsLib) {
      throw new Error('PDF.js não carregado');
    }
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    this.pdfDoc    = await loadingTask.promise;
    this.totalPages = this.pdfDoc.numPages;
    this.currentPage = 1;
    await this.renderPage(this.currentPage);
  }

  // ── Renderiza uma página ───────────────────────────────────────────────────

  async renderPage(pageNum) {
    if (!this.pdfDoc) return;

    // Fila: se já renderizando, guarda pedido
    if (this.rendering) {
      this._pendingPage = pageNum;
      return;
    }

    this.rendering = true;
    this.currentPage = Math.min(Math.max(1, pageNum), this.totalPages);

    try {
      const page     = await this.pdfDoc.getPage(this.currentPage);
      const viewport = page.getViewport({ scale: this.scale });

      this.canvas.width  = viewport.width;
      this.canvas.height = viewport.height;

      // Sincroniza tamanho dos outros canvas
      document.querySelectorAll('#annotation-canvas, #remote-canvas').forEach(c => {
        c.width  = viewport.width;
        c.height = viewport.height;
      });

      await page.render({
        canvasContext: this.ctx,
        viewport,
      }).promise;

      this.onRender?.(this.currentPage, this.totalPages, viewport);
    } catch (e) {
      console.error('[PDFViewer] Erro ao renderizar página:', e);
    } finally {
      this.rendering = false;
      if (this._pendingPage !== null) {
        const next = this._pendingPage;
        this._pendingPage = null;
        await this.renderPage(next);
      }
    }
  }

  // ── Navegação ──────────────────────────────────────────────────────────────

  async prevPage() {
    if (this.currentPage > 1) await this.renderPage(this.currentPage - 1);
  }

  async nextPage() {
    if (this.currentPage < this.totalPages) await this.renderPage(this.currentPage + 1);
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────

  async setScale(scale) {
    this.scale = Math.min(Math.max(0.25, scale), 4.0);
    await this.renderPage(this.currentPage);
    return this.scale;
  }

  async zoomIn()  { return this.setScale(this.scale + 0.25); }
  async zoomOut() { return this.setScale(this.scale - 0.25); }

  // Ajusta ao container pai
  async fitToContainer(container) {
    if (!this.pdfDoc) return;
    const page = await this.pdfDoc.getPage(this.currentPage);
    const vp   = page.getViewport({ scale: 1 });
    const scaleW = (container.clientWidth  - 48) / vp.width;
    const scaleH = (container.clientHeight - 48) / vp.height;
    return this.setScale(Math.min(scaleW, scaleH));
  }

  // ── Coordenadas ────────────────────────────────────────────────────────────

  // Retorna as dimensões atuais da página renderizada
  get pageSize() {
    return { width: this.canvas.width, height: this.canvas.height };
  }
}
