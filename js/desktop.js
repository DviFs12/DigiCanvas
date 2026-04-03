/**
 * desktop.js
 * ──────────
 * Controller principal do lado desktop (index.html).
 * Orquestra PDF, anotação, WebRTC e UI.
 */

import { generateCode } from './signaling.js';
import { DigiPeer, ConnState } from './webrtc.js';
import { PDFViewer } from './pdf-viewer.js';
import { AnnotationEngine } from './annotation.js';
import { toast } from './toast.js';

// ── Elementos DOM ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const screenWelcome    = $('screen-welcome');
const screenMain       = $('screen-main');
const fileInput        = $('file-input');
const btnOpenPDF       = $('btn-open-pdf');
const btnDemo          = $('btn-demo');
const pdfPanel         = $('pdf-panel');
const canvasWrapper    = $('canvas-wrapper');
const pdfCanvas        = $('pdf-canvas');
const annotationCanvas = $('annotation-canvas');
const remoteCanvas     = $('remote-canvas');
const viewportIndicator= $('viewport-indicator');
const pageInfo         = $('page-info');
const zoomLevel        = $('zoom-level');
const pdfFilename      = $('pdf-filename');
const btnPrev          = $('btn-prev-page');
const btnNext          = $('btn-next-page');
const btnZoomIn        = $('btn-zoom-in');
const btnZoomOut       = $('btn-zoom-out');
const btnZoomFit       = $('btn-zoom-fit');
const btnUndo          = $('btn-undo');
const btnClear         = $('btn-clear-annotations');
const btnExport        = $('btn-export');
const strokeColor      = $('stroke-color');
const statusDot        = $('status-dot');
const btnGenerateCode  = $('btn-generate-code');
const codeDisplay      = $('code-display');
const codeDigits       = $('code-digits');
const connSetup        = $('conn-setup');
const connStatus       = $('conn-status');
const btnDisconnect    = $('btn-disconnect');
const vpX              = $('vp-x');
const vpY              = $('vp-y');
const vpZoom           = $('vp-zoom');
const toggleRemote     = $('toggle-remote-strokes');
const toggleSync       = $('toggle-sync-scroll');

// ── Estado global ──────────────────────────────────────────────────────────

let viewer     = null;
let annotation = null;
let peer       = null;
let sessionCode = null;
let strokeId   = 0;

// ── Transição de telas ────────────────────────────────────────────────────

function showMain() {
  screenWelcome.classList.remove('active');
  screenMain.classList.add('active');
  screenMain.style.display = 'flex';
}

// ── Abertura de PDF ────────────────────────────────────────────────────────

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  pdfFilename.textContent = file.name;
  showMain();
  initCanvases();

  const buffer = await file.arrayBuffer();
  await viewer.loadFromBuffer(buffer);
});

btnDemo.addEventListener('click', () => {
  pdfFilename.textContent = 'Demo (sem PDF)';
  showMain();
  initCanvases();

  // Desenha uma página demo no canvas
  pdfCanvas.width  = 794;  // A4 ~96dpi
  pdfCanvas.height = 1123;
  annotationCanvas.width  = 794;
  annotationCanvas.height = 1123;
  remoteCanvas.width  = 794;
  remoteCanvas.height = 1123;

  const ctx = pdfCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 794, 1123);
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 100);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#444';
  ctx.fillText('Abra um PDF para usar como fundo', 397, 160);
  ctx.fillStyle = '#e0e0f0';
  ctx.fillRect(60, 220, 674, 2);
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#888';
  ctx.textAlign = 'left';
  const lines = [
    '1. Gere um código de conexão no painel direito',
    '2. Abra celular.html no seu smartphone',
    '3. Digite o código gerado',
    '4. Comece a desenhar no celular — aparece aqui!',
    '5. Use as ferramentas acima para anotar localmente',
  ];
  lines.forEach((l, i) => ctx.fillText(l, 80, 270 + i * 40));

  pageInfo.textContent = '1 / 1';
});

function initCanvases() {
  if (annotation) return;
  annotation = new AnnotationEngine(annotationCanvas, remoteCanvas);

  annotation.onStrokeStart = ({ tool, color, size, x, y }) => {
    strokeId++;
    const id = `h${strokeId}`;
    annotation._currentStrokeId = id;
    peer?.send({ type: 'stroke:start', id, tool, color, size, x, y });
  };

  annotation.onStrokeMove = ({ x, y }) => {
    peer?.send({ type: 'stroke:move', id: annotation._currentStrokeId, x, y });
  };

  annotation.onStrokeEnd = () => {
    peer?.send({ type: 'stroke:end', id: annotation._currentStrokeId });
  };

  viewer = new PDFViewer(pdfCanvas);
  viewer.onRender = (page, total, vp) => {
    pageInfo.textContent = `${page} / ${total}`;
    zoomLevel.textContent = Math.round(viewer.scale * 100) + '%';
  };
}

// ── Controles PDF ──────────────────────────────────────────────────────────

btnPrev.addEventListener('click', () => viewer?.prevPage());
btnNext.addEventListener('click', () => viewer?.nextPage());
btnZoomIn.addEventListener('click', () => viewer?.zoomIn());
btnZoomOut.addEventListener('click', () => viewer?.zoomOut());
btnZoomFit.addEventListener('click', () => {
  viewer?.fitToContainer(canvasWrapper);
});

// ── Ferramentas de anotação ────────────────────────────────────────────────

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setTool(btn.dataset.tool);
  });
});

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setSize(parseInt(btn.dataset.size));
  });
});

strokeColor.addEventListener('input', () => annotation?.setColor(strokeColor.value));

btnUndo.addEventListener('click', () => {
  annotation?.undo();
  peer?.send({ type: 'undo' });
});

btnClear.addEventListener('click', () => {
  annotation?.clear();
  peer?.send({ type: 'clear' });
});

btnExport.addEventListener('click', () => {
  if (!annotation) return;
  const dataURL = annotation.exportPNG();
  const a = document.createElement('a');
  a.href     = dataURL;
  a.download = 'digicanvas-anotacoes.png';
  a.click();
});

// Undo via teclado
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') annotation?.undo();
});

// ── Toggles ────────────────────────────────────────────────────────────────

toggleRemote.addEventListener('change', () => {
  if (annotation) annotation.showRemote = toggleRemote.checked;
  remoteCanvas.style.display = toggleRemote.checked ? 'block' : 'none';
});

// ── WebRTC / Conexão ───────────────────────────────────────────────────────

btnGenerateCode.addEventListener('click', async () => {
  if (peer) await peer.disconnect();

  sessionCode = generateCode();
  renderCode(sessionCode);
  codeDisplay.classList.remove('hidden');

  peer = new DigiPeer({
    role:  'host',
    code:  sessionCode,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });

  try {
    await peer.startAsHost();
  } catch (err) {
    console.error('[Desktop] Erro ao iniciar WebRTC:', err);
    showError(err.message);
  }
});

btnDisconnect.addEventListener('click', async () => {
  await peer?.disconnect();
  peer = null;
  connStatus.classList.add('hidden');
  connSetup.style.display = '';
  codeDisplay.classList.add('hidden');
  setStatusDot('disconnected');
});

function renderCode(code) {
  codeDigits.innerHTML = '';
  code.split('').forEach((digit, i) => {
    const el = document.createElement('div');
    el.className  = 'digit';
    el.textContent = digit;
    el.style.animationDelay = `${i * 60}ms`;
    codeDigits.appendChild(el);
  });

  // Gera QR code com a URL do celular + código pré-preenchido
  renderQR(code);
}

function renderQR(code) {
  const qrEl = $('code-qr');
  if (!qrEl) return;

  // URL da página do celular com o código como parâmetro
  const base = window.location.href.replace('index.html', '').replace(/\/$/, '');
  const url  = `${base}/celular.html?code=${code}`;

  // Carrega qrcode.js do CDN e gera o canvas
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  script.onload = () => {
    qrEl.innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode(qrEl, {
      text:         url,
      width:        120,
      height:       120,
      colorDark:    '#7c6af7',
      colorLight:   '#1e1e2e',
      correctLevel: QRCode.CorrectLevel.M,
    });
  };
  // Evita carregar duas vezes
  if (!document.querySelector('script[src*="qrcode"]')) {
    document.head.appendChild(script);
  } else {
    script.onload();
  }
}

function handleStateChange(state) {
  setStatusDot(
    state === ConnState.CONNECTED   ? 'connected'   :
    state === ConnState.CONNECTING  ? 'connecting'  : 'disconnected'
  );

  if (state === ConnState.CONNECTED) {
    connSetup.style.display = 'none';
    connStatus.classList.remove('hidden');
    viewportIndicator.style.display = 'block';
    toast('📱 Celular conectado!', 'success');
  }

  if (state === ConnState.DISCONNECTED) {
    connStatus.classList.add('hidden');
    connSetup.style.display = '';
    viewportIndicator.style.display = 'none';
    // Só avisa se já havia conectado antes (evita spam no início)
    if (peer) toast('Celular desconectado', 'error');
  }

  if (state === ConnState.ERROR) {
    connStatus.classList.add('hidden');
    connSetup.style.display = '';
    viewportIndicator.style.display = 'none';
    toast('Erro na conexão WebRTC', 'error');
  }
}

function handleMessage(msg) {
  if (!msg || !msg.type) return;

  // Traços de anotação do celular
  if (msg.type.startsWith('stroke:') || msg.type === 'clear' || msg.type === 'undo') {
    annotation?.applyRemoteMessage(msg);
    return;
  }

  // Viewport
  if (msg.type === 'viewport') {
    updateViewport(msg);
    return;
  }
}

// ── Viewport indicator ────────────────────────────────────────────────────

function updateViewport(msg) {
  // msg: { type, x, y, zoom, canvasW, canvasH }
  const { x, y, zoom, canvasW, canvasH } = msg;

  vpX.textContent    = Math.round(x);
  vpY.textContent    = Math.round(y);
  vpZoom.textContent = zoom.toFixed(2) + '×';

  if (!pdfCanvas.width) return;

  // O celular envia coordenadas no espaço do documento PDF.
  // canvasW/H são as dimensões CSS do canvas do celular (sem DPR).
  // Mapeamos para o espaço do canvas do desktop.
  const scaleX = pdfCanvas.width  / canvasW;
  const scaleY = pdfCanvas.height / canvasH;

  // Tamanho do viewport visível no celular em px do documento
  const vpW = canvasW / zoom;
  const vpH = canvasH / zoom;

  const indX = x * scaleX;
  const indY = y * scaleY;
  const indW = Math.max(40, vpW * scaleX);
  const indH = Math.max(40, vpH * scaleY);

  viewportIndicator.style.left   = `${indX}px`;
  viewportIndicator.style.top    = `${indY}px`;
  viewportIndicator.style.width  = `${indW}px`;
  viewportIndicator.style.height = `${indH}px`;

  // Auto-scroll se habilitado
  if (toggleSync.checked) {
    const wrapper = canvasWrapper;
    const targetScrollLeft = indX - wrapper.clientWidth  / 2 + indW / 2;
    const targetScrollTop  = indY - wrapper.clientHeight / 2 + indH / 2;
    wrapper.scrollTo({ left: targetScrollLeft, top: targetScrollTop, behavior: 'smooth' });
  }
}

function setStatusDot(state) {
  statusDot.className = `status-dot ${state}`;
}

function showError(msg) {
  console.error('[Desktop]', msg);
  toast('Erro: ' + msg, 'error', 5000);
}
