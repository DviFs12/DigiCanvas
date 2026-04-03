/**
 * desktop.js — Controller do PC
 * ──────────────────────────────
 * Gestão de PDF, anotações, WebRTC, viewport, temas, recentes
 */

import { generateCode }       from './signaling.js';
import { DigiPeer, ConnState } from './webrtc.js';
import { PDFViewer }           from './pdf-viewer.js';
import { AnnotationEngine }    from './annotation.js';
import { toast, showLoading, hideLoading } from './toast.js';
import { shortcuts }           from './shortcuts.js';
import { getTheme, setTheme, applyTheme, getPrefs, setPref, getRecents, addRecent, removeRecent } from './store.js';

// ── DOM helpers ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

// ── Elementos ──────────────────────────────────────────────────────────────
const screenWelcome     = $('screen-welcome');
const screenMain        = $('screen-main');
const canvasWrapper     = $('canvas-wrapper');
const pdfCanvas         = $('pdf-canvas');
const annotationCanvas  = $('annotation-canvas');
const remoteCanvas      = $('remote-canvas');
const gridCanvas        = $('grid-canvas');
const viewportIndicator = $('viewport-indicator');

// ── Estado ─────────────────────────────────────────────────────────────────
let viewer      = null;
let annotation  = null;
let peer        = null;
let sessionCode = null;
let strokeId    = 0;
let prefs       = getPrefs();
let currentFile = null; // { name, size, buffer }

// ── Init ───────────────────────────────────────────────────────────────────

applyTheme();
renderRecents();
applyPrefsToUI();

// ══════════════════════════════════════════════════════════════════════════
// TELA DE BOAS-VINDAS
// ══════════════════════════════════════════════════════════════════════════

on('file-input', 'change', async e => {
  const file = e.target.files[0]; if (!file) return;
  await openPDF(file);
});

on('btn-demo', 'click', openDemo);

on('btn-change-pdf', 'click', () => $('file-input-change')?.click());
on('file-input-change', 'change', async e => {
  const file = e.target.files[0]; if (!file) return;
  await openPDF(file);
});

async function openPDF(file) {
  showLoading('Carregando PDF…');
  try {
    const buffer = await file.arrayBuffer();
    currentFile  = { name: file.name, size: file.size, buffer };
    showMain();
    if (!annotation) initCanvases();
    await viewer.loadFromBuffer(buffer);
    $('pdf-filename').textContent = file.name;
    // Thumbnail para recentes
    const thumb = await viewer.getThumbnail(120);
    addRecent({ name: file.name, size: file.size, thumb });
    renderRecents();
  } catch (err) {
    toast('Erro ao abrir PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

function openDemo() {
  showMain();
  if (!annotation) initCanvases();
  // Página demo A4
  const dpr = window.devicePixelRatio || 1;
  const W = 794 * dpr, H = 1123 * dpr;
  pdfCanvas.width  = W; pdfCanvas.height  = H;
  pdfCanvas.style.width  = '794px'; pdfCanvas.style.height = '1123px';
  ['annotation-canvas','remote-canvas','grid-canvas'].forEach(id => {
    const c = $(id); if (!c) return;
    c.width = W; c.height = H;
    c.style.width  = '794px'; c.style.height = '1123px';
  });
  const ctx = pdfCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 794, 1123);
  ctx.fillStyle = '#1a1a2e'; ctx.font = `bold ${32*dpr}px sans-serif`; ctx.textAlign = 'center';
  ctx.scale(1/dpr, 1/dpr);
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText('DigiCanvas — Modo Demo', 794*dpr/2, 90*dpr);
  ctx.font = '16px sans-serif'; ctx.fillStyle = '#666';
  ctx.fillText('Conecte o celular e comece a desenhar', 794*dpr/2, 140*dpr);
  ctx.restore && ctx.restore();
  $('pdf-filename').textContent = 'Demo';
  $('page-info').textContent = '1 / 1';
  broadcastPdfInfo();
}

function showMain() {
  screenWelcome.classList.remove('active');
  screenMain.classList.add('active');
  screenMain.style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════
// CANVAS / VIEWER / ANNOTATION
// ══════════════════════════════════════════════════════════════════════════

function initCanvases() {
  annotation = new AnnotationEngine(
    annotationCanvas, remoteCanvas,
    () => {
      const dpr = window.devicePixelRatio || 1;
      return { w: pdfCanvas.width / dpr, h: pdfCanvas.height / dpr };
    }
  );

  annotation.onStrokeStart = ({ tool, color, size, nx, ny }) => {
    strokeId++;
    annotation._curId = `h${strokeId}`;
    peer?.send({ type: 'stroke:start', id: annotation._curId, tool, color, size, nx, ny });
  };
  annotation.onStrokeMove = ({ nx, ny }) => {
    peer?.send({ type: 'stroke:move', id: annotation._curId, nx, ny });
  };
  annotation.onStrokeEnd = () => {
    peer?.send({ type: 'stroke:end', id: annotation._curId });
  };

  viewer = new PDFViewer(pdfCanvas);
  viewer.onLoading = (loading) => loading ? showLoading('Renderizando…') : hideLoading();
  viewer.onRender  = async (page, total) => {
    $('page-info').textContent  = `${page} / ${total}`;
    $('zoom-level').textContent = Math.round(viewer.scale * 100) + '%';
    annotation.onCanvasResize();
    drawGrid();
    broadcastPdfInfo();
  };

  // Aplica prefs salvas às ferramentas
  applyPrefsToUI();
}

function syncCanvasSizes() {
  const W = pdfCanvas.width, H = pdfCanvas.height;
  const dpr = window.devicePixelRatio || 1;
  const sw  = (W / dpr) + 'px', sh = (H / dpr) + 'px';
  ['annotation-canvas','remote-canvas','grid-canvas'].forEach(id => {
    const c = $(id); if (!c) return;
    c.width = W; c.height = H;
    c.style.width = sw; c.style.height = sh;
  });
}

// ── Grid overlay ──────────────────────────────────────────────────────────

function drawGrid() {
  if (!gridCanvas) return;
  const ctx = gridCanvas.getContext('2d');
  ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  if (!prefs.gridEnabled) return;
  const dpr  = window.devicePixelRatio || 1;
  const step = 40 * dpr;
  const W    = gridCanvas.width, H = gridCanvas.height;
  ctx.strokeStyle = 'rgba(124,106,247,0.18)';
  ctx.lineWidth   = 1;
  for (let x = 0; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
}

// ── Broadcast PDF info ao celular ─────────────────────────────────────────

async function broadcastPdfInfo() {
  if (!peer || peer.state !== ConnState.CONNECTED) return;
  const dpr = window.devicePixelRatio || 1;
  peer.send({ type: 'pdf:size', w: pdfCanvas.width / dpr, h: pdfCanvas.height / dpr });
  try {
    const thumb = viewer?.pdfDoc ? await viewer.getThumbnail(400) : dataUrlFromCanvas(pdfCanvas, 400);
    if (thumb) peer.send({ type: 'pdf:thumb', data: thumb });
  } catch { /**/ }
}

function dataUrlFromCanvas(canvas, maxW) {
  const dpr = window.devicePixelRatio || 1;
  const cw  = canvas.width / dpr, ch = canvas.height / dpr;
  const sc  = Math.min(1, maxW / cw);
  const tmp = document.createElement('canvas');
  tmp.width = cw * sc * dpr; tmp.height = ch * sc * dpr;
  tmp.getContext('2d').drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/jpeg', 0.7);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROLES DE PDF
// ══════════════════════════════════════════════════════════════════════════

on('btn-prev-page', 'click', () => viewer?.prevPage());
on('btn-next-page', 'click', () => viewer?.nextPage());
on('btn-zoom-in',   'click', () => viewer?.zoomIn());
on('btn-zoom-out',  'click', () => viewer?.zoomOut());
on('btn-zoom-fit',  'click', () => viewer?.fitToContainer(canvasWrapper));

// Wheel zoom
canvasWrapper?.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  e.deltaY < 0 ? viewer?.zoomIn(0.1) : viewer?.zoomOut(0.1);
}, { passive: false });

// ══════════════════════════════════════════════════════════════════════════
// FERRAMENTAS DE ANOTAÇÃO
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setTool(btn.dataset.tool);
    prefs.tool = btn.dataset.tool;
  });
});

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const s = parseInt(btn.dataset.size);
    annotation?.setSize(s);
    prefs.size = s;
  });
});

on('stroke-color', 'input', e => { annotation?.setColor(e.target.value); });

on('btn-undo',              'click', () => { if (annotation?.undo()) peer?.send({ type: 'undo' }); });
on('btn-redo',              'click', () => { if (annotation?.redo()) peer?.send({ type: 'redo' }); });
on('btn-clear-annotations', 'click', () => { annotation?.clear(); peer?.send({ type: 'clear' }); });
on('btn-export',            'click', exportAnnotations);

function exportAnnotations() {
  if (!annotation) return;
  const a  = document.createElement('a');
  a.href   = annotation.exportPNG();
  a.download = (currentFile?.name?.replace('.pdf','') ?? 'digicanvas') + '-anotacoes.png';
  a.click();
  toast('Imagem exportada!', 'success');
}

// ══════════════════════════════════════════════════════════════════════════
// TOGGLES / PREFERÊNCIAS
// ══════════════════════════════════════════════════════════════════════════

on('toggle-remote-strokes', 'change', e => {
  if (annotation) annotation.showRemote = e.target.checked;
  if (remoteCanvas) remoteCanvas.style.display = e.target.checked ? '' : 'none';
  setPref('showRemote', e.target.checked);
});

on('toggle-sync-scroll', 'change', e => setPref('syncScroll', e.target.checked));

on('toggle-zoom-lock-desktop', 'change', e => {
  prefs.zoomLocked = e.target.checked;
  setPref('zoomLocked', prefs.zoomLocked);
  peer?.send({ type: 'state:sync', zoomLocked: prefs.zoomLocked });
  toast(prefs.zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

on('toggle-grid', 'change', e => {
  prefs.gridEnabled = e.target.checked;
  setPref('gridEnabled', prefs.gridEnabled);
  drawGrid();
});

// Seletor de tema
document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.themeBtn;
    setTheme(t);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Tema: ' + t, 'info');
  });
});

function applyPrefsToUI() {
  prefs = getPrefs();
  const t = $('toggle-remote-strokes'); if (t) t.checked = prefs.showRemote;
  const s = $('toggle-sync-scroll');    if (s) s.checked = prefs.syncScroll;
  const z = $('toggle-zoom-lock-desktop'); if (z) z.checked = prefs.zoomLocked;
  const g = $('toggle-grid');           if (g) g.checked = prefs.gridEnabled;
  // Tema buttons
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.classList.toggle('active', b.dataset.themeBtn === getTheme());
  });
}

// ══════════════════════════════════════════════════════════════════════════
// ARQUIVOS RECENTES
// ══════════════════════════════════════════════════════════════════════════

function renderRecents() {
  const container = $('recents-list');
  if (!container) return;
  const list = getRecents();
  if (!list.length) {
    container.innerHTML = '<p class="recents-empty">Nenhum arquivo recente</p>';
    return;
  }
  container.innerHTML = list.map(r => `
    <div class="recent-item" data-name="${r.name}">
      <div class="recent-thumb">
        ${r.thumb ? `<img src="${r.thumb}" alt="${r.name}" />` : '<div class="thumb-placeholder">PDF</div>'}
      </div>
      <div class="recent-info">
        <span class="recent-name">${r.name}</span>
        <span class="recent-size">${formatSize(r.size)}</span>
      </div>
      <button class="recent-remove" title="Remover" data-name="${r.name}">×</button>
    </div>
  `).join('');

  container.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('recent-remove')) {
        e.stopPropagation();
        removeRecent(e.target.dataset.name);
        renderRecents();
        return;
      }
      toast('Re-abrir PDF: use o botão "Abrir PDF"', 'info');
    });
  });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ══════════════════════════════════════════════════════════════════════════
// WEBRTC
// ══════════════════════════════════════════════════════════════════════════

on('btn-generate-code', 'click', async () => {
  if (peer) await peer.disconnect();
  sessionCode = generateCode();
  renderCode(sessionCode);
  $('code-display')?.classList.remove('hidden');

  peer = new DigiPeer({
    role: 'host', code: sessionCode,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });
  try {
    await peer.startAsHost();
  } catch (err) {
    toast('Erro ao iniciar sessão: ' + err.message, 'error', 6000);
  }
});

on('btn-disconnect', 'click', async () => {
  await peer?.disconnect(); peer = null;
  $('conn-status')?.classList.add('hidden');
  $('conn-setup').style.display = '';
  $('code-display')?.classList.add('hidden');
  if (viewportIndicator) viewportIndicator.style.display = 'none';
  setStatusDot('disconnected');
});

function handleStateChange(state) {
  setStatusDot(
    state === ConnState.CONNECTED  ? 'connected'  :
    state === ConnState.CONNECTING ? 'connecting' : 'disconnected'
  );
  if (state === ConnState.CONNECTED) {
    $('conn-setup').style.display = 'none';
    $('conn-status')?.classList.remove('hidden');
    if (viewportIndicator) viewportIndicator.style.display = 'block';
    toast('📱 Celular conectado!', 'success');
    setTimeout(() => {
      broadcastPdfInfo();
      peer?.send({ type: 'state:sync', zoomLocked: prefs.zoomLocked, gridEnabled: prefs.gridEnabled });
    }, 400);
  }
  if (state === ConnState.DISCONNECTED) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    if (viewportIndicator) viewportIndicator.style.display = 'none';
    if (peer) toast('Celular desconectado', 'error');
  }
  if (state === ConnState.ERROR) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    toast('Erro WebRTC', 'error');
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
    case 'clear':
    case 'undo':
    case 'redo':
      annotation?.applyRemoteMessage(msg); break;

    case 'viewport': updateViewport(msg); break;

    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        prefs.zoomLocked = msg.zoomLocked;
        const el = $('toggle-zoom-lock-desktop'); if (el) el.checked = prefs.zoomLocked;
        toast(prefs.zoomLocked ? '🔒 Zoom travado pelo celular' : '🔓 Zoom liberado', 'info');
        peer?.send({ type: 'state:sync', zoomLocked: prefs.zoomLocked });
      }
      break;

    case 'request:pdf':
      // Celular pediu re-envio do PDF info
      broadcastPdfInfo();
      break;
  }
}

// ── Viewport indicator ─────────────────────────────────────────────────────

function updateViewport({ nx, ny, nw, nh, zoom }) {
  const dpr = window.devicePixelRatio || 1;
  const W   = pdfCanvas.width / dpr;
  const H   = pdfCanvas.height / dpr;
  if (!W || !H) return;

  const indX = nx * W, indY = ny * H;
  const indW = Math.max(20, nw * W);
  const indH = Math.max(20, nh * H);
  const cx   = Math.max(0, Math.min(indX, W - indW));
  const cy   = Math.max(0, Math.min(indY, H - indH));

  if (viewportIndicator) {
    viewportIndicator.style.cssText = `left:${cx}px;top:${cy}px;width:${indW}px;height:${indH}px;display:block`;
  }
  const vx = $('vp-x'); if (vx) vx.textContent = Math.round(nx * 100) + '%';
  const vy = $('vp-y'); if (vy) vy.textContent = Math.round(ny * 100) + '%';
  const vz = $('vp-zoom'); if (vz) vz.textContent = (zoom ?? 1).toFixed(2) + '×';

  const prefs2 = getPrefs();
  if (prefs2.syncScroll && canvasWrapper) {
    canvasWrapper.scrollTo({ left: cx - canvasWrapper.clientWidth/2 + indW/2, top: cy - canvasWrapper.clientHeight/2 + indH/2, behavior: 'smooth' });
  }
}

// ── QR Code ────────────────────────────────────────────────────────────────

function renderCode(code) {
  const el = $('code-digits'); if (!el) return;
  el.innerHTML = '';
  code.split('').forEach((d, i) => {
    const s = document.createElement('div');
    s.className = 'digit'; s.textContent = d;
    s.style.animationDelay = `${i * 60}ms`;
    el.appendChild(s);
  });
  renderQR(code);
}

function renderQR(code) {
  const qrEl = $('code-qr'); if (!qrEl) return;
  const base = location.href.replace(/index\.html.*$/, '').replace(/\/$/, '');
  const url  = `${base}/celular.html?code=${code}`;
  const load = () => {
    qrEl.innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode(qrEl, { text: url, width: 120, height: 120, colorDark: '#7c6af7', colorLight: 'var(--surface, #1e1e2e)', correctLevel: QRCode.CorrectLevel.M });
  };
  if (!document.querySelector('script[src*="qrcode"]')) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = load; document.head.appendChild(s);
  } else { try { load(); } catch { /**/ } }
}

function setStatusDot(s) {
  const el = $('status-dot'); if (el) el.className = `status-dot ${s}`;
}

// ══════════════════════════════════════════════════════════════════════════
// ATALHOS DE TECLADO
// ══════════════════════════════════════════════════════════════════════════

shortcuts.on('undo',        () => { if (annotation?.undo()) peer?.send({ type: 'undo' }); });
shortcuts.on('redo',        () => { if (annotation?.redo()) peer?.send({ type: 'redo' }); });
shortcuts.on('clear',       () => { annotation?.clear(); peer?.send({ type: 'clear' }); });
shortcuts.on('export',      exportAnnotations);
shortcuts.on('open',        () => $('file-input')?.click());
shortcuts.on('zoom-in',     () => viewer?.zoomIn());
shortcuts.on('zoom-out',    () => viewer?.zoomOut());
shortcuts.on('zoom-fit',    () => viewer?.fitToContainer(canvasWrapper));
shortcuts.on('prev-page',   () => viewer?.prevPage());
shortcuts.on('next-page',   () => viewer?.nextPage());
shortcuts.on('toggle-grid', () => {
  const el = $('toggle-grid'); if (el) { el.checked = !el.checked; el.dispatchEvent(new Event('change')); }
});
shortcuts.on('toggle-theme', () => {
  const themes = ['dark','light','amoled'];
  const cur = getTheme();
  const next = themes[(themes.indexOf(cur) + 1) % themes.length];
  setTheme(next); toast('Tema: ' + next, 'info');
});

// Ferramenta via teclado
['pen','marker','highlighter','eraser','line','rect'].forEach(tool => {
  shortcuts.on(`tool:${tool}`, () => {
    const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
    btn?.click();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DRAG DO VIEWPORT INDICATOR (controle via PC)
// ══════════════════════════════════════════════════════════════════════════

let vpDragging = false, vpDragStartX = 0, vpDragStartY = 0;
let vpLastNX = 0, vpLastNY = 0;

viewportIndicator?.addEventListener('mousedown', e => {
  e.preventDefault();
  vpDragging   = true;
  vpDragStartX = e.clientX;
  vpDragStartY = e.clientY;
  vpLastNX     = parseFloat(viewportIndicator.style.left) / (pdfCanvas.width / (window.devicePixelRatio||1));
  vpLastNY     = parseFloat(viewportIndicator.style.top)  / (pdfCanvas.height / (window.devicePixelRatio||1));
});

document.addEventListener('mousemove', e => {
  if (!vpDragging) return;
  const dpr = window.devicePixelRatio || 1;
  const W = pdfCanvas.width / dpr, H = pdfCanvas.height / dpr;
  const rect = canvasWrapper.getBoundingClientRect();
  const dx = e.clientX - vpDragStartX;
  const dy = e.clientY - vpDragStartY;
  const dnx = dx / W, dny = dy / H;
  const nw  = parseFloat(viewportIndicator.style.width)  / W;
  const nh  = parseFloat(viewportIndicator.style.height) / H;
  const nx  = Math.max(0, Math.min(vpLastNX + dnx, 1 - nw));
  const ny  = Math.max(0, Math.min(vpLastNY + dny, 1 - nh));
  viewportIndicator.style.left = (nx * W) + 'px';
  viewportIndicator.style.top  = (ny * H) + 'px';
  // Envia comando de teleporte de viewport ao celular
  peer?.send({ type: 'viewport:set', nx, ny });
});

document.addEventListener('mouseup', () => { vpDragging = false; });
