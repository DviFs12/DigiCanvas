/**
 * desktop.js v5 — Controller do PC
 * ─────────────────────────────────
 * CORREÇÕES:
 *  #1  Clamp de viewport robusto (edge cases zoom alto, resize, troca PDF)
 *  #2  Modos de interação: draw / move / resize
 *  #7  QR Code reescrito (lib local inline, fallback canvas→SVG)
 *  #8  Split button Download (all / local-only / remote-only)
 *  #9  Split button Limpar (all / local / remote)
 *  #10 clearMode shared/separate
 *  #11 Borracha não apaga fundo — annotation usa overlay separado
 */

import { generateCode }        from './signaling.js';
import { DigiPeer, ConnState } from './webrtc.js';
import { PDFViewer }            from './pdf-viewer.js';
import { AnnotationEngine }     from './annotation.js';
import { toast, showLoading, hideLoading } from './toast.js';
import { shortcuts }            from './shortcuts.js';
import { getTheme, setTheme, applyTheme, getPrefs, setPref,
         getRecents, addRecent, removeRecent, clearRecents } from './store.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

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
let currentFile = null;

// Modo de interação no PC: 'draw' | 'move' | 'resize'
let pcMode = 'draw';

// Viewport state (espelhado do celular para renderização do indicador)
let vpState = { nx:0, ny:0, nw:1, nh:1, zoom:1 };

// ── Init ───────────────────────────────────────────────────────────────────
applyTheme();
renderRecents();
applyPrefsToUI();

// ══════════════════════════════════════════════════════════════════════════
// BOAS-VINDAS
// ══════════════════════════════════════════════════════════════════════════

on('file-input', 'change', async e => { const f = e.target.files[0]; if (f) await openPDF(f); });
on('btn-demo',   'click',  openDemo);
on('file-input-change', 'change', async e => { const f = e.target.files[0]; if (f) await openPDF(f); });
on('btn-change-pdf', 'click', () => $('file-input-change')?.click());

async function openPDF(file) {
  showLoading('Carregando PDF…');
  try {
    const buffer = await file.arrayBuffer();
    currentFile  = { name: file.name, size: file.size, buffer };
    showMain();
    if (!annotation) initCanvases();
    await viewer.loadFromBuffer(buffer);
    $('pdf-filename').textContent = file.name;
    const thumb = await viewer.getThumbnail(120);
    addRecent({ name: file.name, size: file.size, thumb });
    renderRecents();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  } finally { hideLoading(); }
}

function openDemo() {
  showMain();
  if (!annotation) initCanvases();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(794 * dpr), H = Math.round(1123 * dpr);
  [pdfCanvas, annotationCanvas, remoteCanvas, gridCanvas].forEach(c => {
    if (!c) return;
    c.width = W; c.height = H;
    c.style.width = '794px'; c.style.height = '1123px';
  });
  const ctx = pdfCanvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 32px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 90);
  ctx.font = '15px sans-serif'; ctx.fillStyle = '#666';
  ctx.fillText('Abra um PDF ou conecte o celular', 397, 135);
  ctx.restore();
  $('pdf-filename').textContent = 'Demo';
  $('page-info').textContent = '1 / 1';
  annotation?.onCanvasResize();
  broadcastPdfInfo();
}

function showMain() {
  $('screen-welcome').classList.remove('active');
  const sm = $('screen-main');
  sm.classList.add('active'); sm.style.display = 'flex';
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
  annotation.clearMode = prefs.clearMode || 'shared';

  annotation.onStrokeStart = ({ tool, color, size, nx, ny }) => {
    strokeId++;
    annotation._curId = `h${strokeId}`;
    peer?.send({ type:'stroke:start', id:annotation._curId, tool, color, size, nx, ny });
  };
  annotation.onStrokeMove = ({ nx, ny }) => {
    peer?.send({ type:'stroke:move', id:annotation._curId, nx, ny });
  };
  annotation.onStrokeEnd = () => {
    peer?.send({ type:'stroke:end', id:annotation._curId });
  };

  viewer = new PDFViewer(pdfCanvas);
  viewer.onLoading = b => b ? showLoading('Renderizando…') : hideLoading();
  viewer.onRender  = async (page, total) => {
    $('page-info').textContent  = `${page} / ${total}`;
    $('zoom-level').textContent = Math.round(viewer.scale * 100) + '%';
    annotation.onCanvasResize();
    drawGrid();
    broadcastPdfInfo();
  };

  applyPrefsToUI();
}

// ── Grid ──────────────────────────────────────────────────────────────────

function drawGrid() {
  if (!gridCanvas) return;
  const ctx = gridCanvas.getContext('2d');
  ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  if (!prefs.gridEnabled) return;
  const dpr = window.devicePixelRatio || 1;
  const step = 40 * dpr, W = gridCanvas.width, H = gridCanvas.height;
  ctx.strokeStyle = 'rgba(124,106,247,0.18)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
}

// ── Broadcast PDF ─────────────────────────────────────────────────────────

async function broadcastPdfInfo() {
  if (!peer || peer.state !== ConnState.CONNECTED) return;
  const dpr = window.devicePixelRatio || 1;
  peer.send({ type:'pdf:size', w: pdfCanvas.width/dpr, h: pdfCanvas.height/dpr });
  try {
    const thumb = viewer?.pdfDoc
      ? await viewer.getThumbnail(400)
      : canvasToJpeg(pdfCanvas, 400);
    if (thumb) peer.send({ type:'pdf:thumb', data:thumb });
  } catch { /**/ }
}

function canvasToJpeg(canvas, maxW) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.width/dpr, ch = canvas.height/dpr;
  const sc = Math.min(1, maxW/cw);
  const tmp = document.createElement('canvas');
  tmp.width = Math.round(cw*sc*dpr); tmp.height = Math.round(ch*sc*dpr);
  tmp.getContext('2d').drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/jpeg', 0.72);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROLES PDF
// ══════════════════════════════════════════════════════════════════════════

on('btn-prev-page', 'click', () => viewer?.prevPage());
on('btn-next-page', 'click', () => viewer?.nextPage());
on('btn-zoom-in',   'click', () => viewer?.zoomIn());
on('btn-zoom-out',  'click', () => viewer?.zoomOut());
on('btn-zoom-fit',  'click', () => viewer?.fitToContainer(canvasWrapper));

canvasWrapper?.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  e.deltaY < 0 ? viewer?.zoomIn(0.1) : viewer?.zoomOut(0.1);
}, { passive:false });

// ══════════════════════════════════════════════════════════════════════════
// MODO DE INTERAÇÃO NO PC  (#2)
// draw | move | resize
// ══════════════════════════════════════════════════════════════════════════

function setPcMode(mode) {
  pcMode = mode;
  document.querySelectorAll('[data-pc-mode]').forEach(b => b.classList.toggle('active', b.dataset.pcMode === mode));
  // Controla se annotation recebe eventos de mouse
  annotation?.setActive(mode === 'draw');
  // Cursor visual
  if (annotationCanvas) {
    annotationCanvas.style.cursor =
      mode === 'draw'   ? 'crosshair' :
      mode === 'move'   ? 'grab'      : 'nw-resize';
  }
  const label = $('pc-mode-label');
  if (label) label.textContent = mode === 'draw' ? 'Desenhar' : mode === 'move' ? 'Mover caixa' : 'Redimensionar';
}

document.querySelectorAll('[data-pc-mode]').forEach(btn => {
  btn.addEventListener('click', () => setPcMode(btn.dataset.pcMode));
});

// ── Drag do viewport indicator — MOVE ─────────────────────────────────────

let vpDrag = { active:false, startX:0, startY:0, startNX:0, startNY:0 };
// Resize do viewport pelo PC
let vpResize = { active:false, startX:0, startY:0, startNW:0, startNH:0 };

function getCssPdfSize() {
  const dpr = window.devicePixelRatio || 1;
  return { W: pdfCanvas.width / dpr, H: pdfCanvas.height / dpr };
}

viewportIndicator?.addEventListener('mousedown', e => {
  e.preventDefault(); e.stopPropagation();
  if (pcMode === 'move') {
    vpDrag.active  = true;
    vpDrag.startX  = e.clientX; vpDrag.startY  = e.clientY;
    vpDrag.startNX = vpState.nx; vpDrag.startNY = vpState.ny;
    viewportIndicator.style.cursor = 'grabbing';
  } else if (pcMode === 'resize') {
    vpResize.active  = true;
    vpResize.startX  = e.clientX; vpResize.startY  = e.clientY;
    vpResize.startNW = vpState.nw; vpResize.startNH = vpState.nh;
  }
});

document.addEventListener('mousemove', e => {
  if (vpDrag.active) {
    const { W, H } = getCssPdfSize();
    if (!W || !H) return;
    const dx = e.clientX - vpDrag.startX, dy = e.clientY - vpDrag.startY;
    const nw = vpState.nw, nh = vpState.nh;
    // Bug #1: clamp correto ao mover
    const nx = clampNorm(vpDrag.startNX + dx/W, 0, Math.max(0, 1 - nw));
    const ny = clampNorm(vpDrag.startNY + dy/H, 0, Math.max(0, 1 - nh));
    vpState.nx = nx; vpState.ny = ny;
    positionIndicator(nx, ny, nw, nh);
    peer?.send({ type:'viewport:set', nx, ny });
  }
  if (vpResize.active) {
    const { W, H } = getCssPdfSize();
    if (!W || !H) return;
    const dx = e.clientX - vpResize.startX, dy = e.clientY - vpResize.startY;
    // Largura/altura mínima de 5% do doc
    const nw = clampNorm(vpResize.startNW + dx/W, 0.05, 1 - vpState.nx);
    const nh = clampNorm(vpResize.startNH + dy/H, 0.05, 1 - vpState.ny);
    vpState.nw = nw; vpState.nh = nh;
    positionIndicator(vpState.nx, vpState.ny, nw, nh);
    // Envia resize ao celular: celular ajusta vpZ para encaixar a visão
    peer?.send({ type:'viewport:resize', nw, nh });
  }
});

document.addEventListener('mouseup', () => {
  vpDrag.active = false; vpResize.active = false;
  if (viewportIndicator) viewportIndicator.style.cursor = '';
});

function clampNorm(v, min, max) { return Math.max(min, Math.min(max, v)); }

function positionIndicator(nx, ny, nw, nh) {
  const { W, H } = getCssPdfSize();
  if (!W || !H || !viewportIndicator) return;
  const x = nx*W, y = ny*H, w = Math.max(8, nw*W), h = Math.max(8, nh*H);
  viewportIndicator.style.cssText =
    `left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:block;` +
    (pcMode === 'resize' ? 'cursor:nw-resize' : pcMode === 'move' ? 'cursor:grab' : '');
}

// ══════════════════════════════════════════════════════════════════════════
// FERRAMENTAS DE ANOTAÇÃO
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setTool(btn.dataset.tool);
    setPref('tool', btn.dataset.tool);
  });
});

// Slider de espessura (#4)
on('stroke-size-slider', 'input', e => {
  const v = parseInt(e.target.value);
  annotation?.setSize(v);
  const lbl = $('stroke-size-label'); if (lbl) lbl.textContent = v;
  setPref('size', v);
});

on('stroke-color', 'input', e => { annotation?.setColor(e.target.value); });

on('btn-undo', 'click', () => {
  if (annotation?.undo()) peer?.send({ type:'undo' });
});
on('btn-redo', 'click', () => {
  if (annotation?.redo()) peer?.send({ type:'redo' });
});

// ── Split button Limpar (#9) ───────────────────────────────────────────────
on('btn-clear-all',    'click', () => { annotation?.clear();        peer?.send({ type:'clear:all' });    toast('Tudo limpo','info'); });
on('btn-clear-local',  'click', () => { annotation?.clearLocal();   peer?.send({ type:'clear:local' });  toast('Traços do PC limpos','info'); });
on('btn-clear-remote', 'click', () => { annotation?.clearRemote();  peer?.send({ type:'clear:remote' }); toast('Traços do celular limpos','info'); });

// ── Split button Download (#8) ─────────────────────────────────────────────
on('btn-export-all',    'click', () => doExport({ includeLocal:true,  includeRemote:true  }, 'completo'));
on('btn-export-local',  'click', () => doExport({ includeLocal:true,  includeRemote:false }, 'pc'));
on('btn-export-remote', 'click', () => doExport({ includeLocal:false, includeRemote:true  }, 'celular'));

function doExport(opts, suffix) {
  if (!annotation) { toast('Nada para exportar','error'); return; }
  const a = document.createElement('a');
  a.href     = annotation.exportPNG(opts);
  a.download = (currentFile?.name?.replace('.pdf','') ?? 'digicanvas') + `-${suffix}.png`;
  a.click();
  toast('Exportado!', 'success');
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

on('toggle-follow-vp', 'change', e => {
  prefs.followViewport = e.target.checked;
  setPref('followViewport', prefs.followViewport);
});

on('toggle-zoom-lock-desktop', 'change', e => {
  prefs.zoomLocked = e.target.checked; setPref('zoomLocked', prefs.zoomLocked);
  peer?.send({ type:'state:sync', zoomLocked: prefs.zoomLocked });
  toast(prefs.zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

on('toggle-grid', 'change', e => {
  prefs.gridEnabled = e.target.checked; setPref('gridEnabled', prefs.gridEnabled);
  drawGrid();
});

on('select-clear-mode', 'change', e => {
  const mode = e.target.value;
  if (annotation) annotation.clearMode = mode;
  setPref('clearMode', mode);
});

document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Tema: ' + btn.dataset.themeBtn, 'info');
  });
});

function applyPrefsToUI() {
  prefs = getPrefs();
  const set = (id, val) => { const el = $(id); if (el) el.checked = val; };
  set('toggle-remote-strokes', prefs.showRemote ?? true);
  set('toggle-sync-scroll',    prefs.syncScroll ?? true);
  set('toggle-zoom-lock-desktop', prefs.zoomLocked ?? false);
  set('toggle-grid',           prefs.gridEnabled ?? false);
  set('toggle-follow-vp',      prefs.followViewport ?? true);

  const slider = $('stroke-size-slider');
  if (slider) { slider.value = prefs.size ?? 3; }
  const sliderLbl = $('stroke-size-label');
  if (sliderLbl) sliderLbl.textContent = prefs.size ?? 3;

  const cm = $('select-clear-mode');
  if (cm) cm.value = prefs.clearMode ?? 'shared';

  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.themeBtn === getTheme())
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ARQUIVOS RECENTES
// ══════════════════════════════════════════════════════════════════════════

function renderRecents() {
  const container = $('recents-list'); if (!container) return;
  const list = getRecents();
  if (!list.length) { container.innerHTML = '<p class="recents-empty">Nenhum arquivo recente</p>'; return; }
  container.innerHTML = list.map(r => `
    <div class="recent-item" data-name="${r.name}">
      <div class="recent-thumb">${r.thumb ? `<img src="${r.thumb}" alt="" />` : '<div class="thumb-placeholder">PDF</div>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${r.name}">${r.name}</span>
        <span class="recent-size">${fmtSize(r.size)}</span>
      </div>
      <button class="recent-remove" data-name="${r.name}" title="Remover">×</button>
    </div>`).join('');

  container.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('recent-remove')) {
        e.stopPropagation();
        removeRecent(e.target.dataset.name);
        renderRecents(); return;
      }
      toast('Use "Abrir PDF" para reabrir o arquivo', 'info');
    });
  });
}

const fmtSize = b => !b ? '' : b < 1024 ? b+'B' : b < 1048576 ? (b/1024).toFixed(1)+'KB' : (b/1048576).toFixed(1)+'MB';

on('btn-clear-recents', 'click', () => { clearRecents(); renderRecents(); });

// ══════════════════════════════════════════════════════════════════════════
// WEBRTC
// ══════════════════════════════════════════════════════════════════════════

on('btn-generate-code', 'click', async () => {
  if (peer) await peer.disconnect();
  sessionCode = generateCode();
  renderCode(sessionCode);
  $('code-display')?.classList.remove('hidden');

  peer = new DigiPeer({
    role:'host', code:sessionCode,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });
  try { await peer.startAsHost(); }
  catch (err) { toast('Erro: ' + err.message, 'error', 6000); }
});

on('btn-disconnect', 'click', async () => {
  await peer?.disconnect(); peer = null;
  $('conn-status')?.classList.add('hidden');
  $('conn-setup').style.display = '';
  $('code-display')?.classList.add('hidden');
  if (viewportIndicator) viewportIndicator.style.display = 'none';
  setStatusDot('disconnected');
  const sl = $('status-label'); if (sl) sl.textContent = 'Desconectado';
});

function handleStateChange(state) {
  setStatusDot(state === ConnState.CONNECTED ? 'connected' : state === ConnState.CONNECTING ? 'connecting' : 'disconnected');
  const sl = $('status-label');
  if (state === ConnState.CONNECTED) {
    $('conn-setup').style.display = 'none';
    $('conn-status')?.classList.remove('hidden');
    if (viewportIndicator) viewportIndicator.style.display = 'block';
    if (sl) sl.textContent = 'Conectado';
    toast('📱 Celular conectado!', 'success');
    setTimeout(() => {
      broadcastPdfInfo();
      peer?.send({ type:'state:sync', zoomLocked:prefs.zoomLocked, gridEnabled:prefs.gridEnabled, clearMode: prefs.clearMode || 'shared' });
    }, 400);
  }
  if (state === ConnState.DISCONNECTED) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    if (viewportIndicator) viewportIndicator.style.display = 'none';
    if (sl) sl.textContent = 'Desconectado';
    if (peer) toast('Celular desconectado', 'error');
  }
  if (state === ConnState.ERROR) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    if (sl) sl.textContent = 'Erro';
    toast('Erro WebRTC', 'error');
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    // Traços do celular (Bug #10: bidirecional)
    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
      annotation?.applyRemoteMessage(msg); break;

    // Limpeza — modo separado ou compartilhado (#9 + #10)
    case 'clear':       annotation?.applyRemoteMessage({ type: annotation?.clearMode === 'shared' ? 'clear:all' : 'clear:remote' }); break;
    case 'clear:all':   annotation?.clear();        break;
    case 'clear:remote':annotation?.clearLocal();   break; // celular limpou os dele → PC remove a camada remota
    case 'clear:local': annotation?.clearRemote();  break; // celular pediu que PC limpe os traços dele
    case 'undo':        annotation?.applyRemoteMessage({ type:'undo' }); break;
    case 'redo':        annotation?.applyRemoteMessage({ type:'redo' }); break;

    case 'viewport':    updateViewport(msg); break;

    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        prefs.zoomLocked = msg.zoomLocked;
        const el = $('toggle-zoom-lock-desktop'); if (el) el.checked = prefs.zoomLocked;
        toast(prefs.zoomLocked ? '🔒 Zoom travado pelo celular' : '🔓 Zoom liberado','info');
        peer?.send({ type:'state:sync', zoomLocked:prefs.zoomLocked });
      }
      break;
    case 'request:pdf': broadcastPdfInfo(); break;
  }
}

// ── Viewport (#1 + #6) ────────────────────────────────────────────────────

function updateViewport({ nx, ny, nw, nh, zoom }) {
  // Bug #1: clamp rigoroso antes de renderizar
  const cnw = Math.min(nw, 1); const cnh = Math.min(nh, 1);
  const cnx = clampNorm(nx, 0, Math.max(0, 1 - cnw));
  const cny = clampNorm(ny, 0, Math.max(0, 1 - cnh));

  vpState = { nx:cnx, ny:cny, nw:cnw, nh:cnh, zoom: zoom ?? 1 };

  positionIndicator(cnx, cny, cnw, cnh);

  const vx = $('vp-x'); if (vx) vx.textContent = Math.round(cnx*100)+'%';
  const vy = $('vp-y'); if (vy) vy.textContent = Math.round(cny*100)+'%';
  const vz = $('vp-zoom'); if (vz) vz.textContent = (zoom??1).toFixed(2)+'×';

  // Bug #6: "Acompanhar Caixa" — só faz scroll se toggle-follow-vp estiver on
  const followEl = $('toggle-follow-vp');
  if (followEl?.checked && canvasWrapper) {
    const { W, H } = getCssPdfSize();
    const cx = cnx*W, cy = cny*H, iw = cnw*W, ih = cnh*H;
    canvasWrapper.scrollTo({
      left: cx - canvasWrapper.clientWidth/2 + iw/2,
      top:  cy - canvasWrapper.clientHeight/2 + ih/2,
      behavior:'smooth'
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// QR CODE (#7) — solução robusta sem dependência de CDN na hora de exibir
// ══════════════════════════════════════════════════════════════════════════

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
  qrEl.innerHTML = '';

  // Bug #7: constrói URL corretamente para GitHub Pages e file://
  const base = (() => {
    try {
      const u = new URL(location.href);
      u.pathname = u.pathname.replace(/\/[^/]*$/, '/celular.html');
      u.search = ''; u.hash = '';
      return u.toString().replace('celular.html', '') + 'celular.html';
    } catch { return './celular.html'; }
  })();
  const url = base + '?code=' + code;

  // Atualiza link de cópia
  const linkEl = $('qr-link'); if (linkEl) linkEl.textContent = url;

  const doRender = () => {
    try {
      // eslint-disable-next-line no-undef
      if (typeof QRCode === 'undefined') throw new Error('QRCode not loaded');
      qrEl.innerHTML = '';
      // Bug #7: colorLight deve ser string hex, não CSS var
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      // eslint-disable-next-line no-undef
      new QRCode(qrEl, {
        text:         url,
        width:        128, height: 128,
        colorDark:    '#7c6af7',
        colorLight:   isDark ? '#1e1e2e' : '#ffffff',
        // eslint-disable-next-line no-undef
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (err) {
      // Fallback: exibe a URL como texto copiável
      qrEl.innerHTML = `<div class="qr-fallback">
        <span>Abra no celular:</span>
        <input readonly value="${url}" onclick="this.select()" style="font-size:10px;width:100%;margin-top:4px;padding:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);" />
      </div>`;
    }
  };

  if (typeof QRCode !== 'undefined') { doRender(); return; }

  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  script.onload  = doRender;
  script.onerror = doRender; // fallback mesmo se script falhar
  document.head.appendChild(script);
}

function setStatusDot(s) {
  const el = $('status-dot'); if (el) el.className = `status-dot ${s}`;
}

// ══════════════════════════════════════════════════════════════════════════
// ATALHOS
// ══════════════════════════════════════════════════════════════════════════

shortcuts.on('undo',     () => { if (annotation?.undo()) peer?.send({ type:'undo' }); });
shortcuts.on('redo',     () => { if (annotation?.redo()) peer?.send({ type:'redo' }); });
shortcuts.on('clear',    () => { annotation?.clear(); peer?.send({ type:'clear:all' }); });
shortcuts.on('export',   () => doExport({ includeLocal:true, includeRemote:true }, 'completo'));
shortcuts.on('open',     () => $('file-input')?.click());
shortcuts.on('zoom-in',  () => viewer?.zoomIn());
shortcuts.on('zoom-out', () => viewer?.zoomOut());
shortcuts.on('zoom-fit', () => viewer?.fitToContainer(canvasWrapper));
shortcuts.on('prev-page',() => viewer?.prevPage());
shortcuts.on('next-page',() => viewer?.nextPage());
shortcuts.on('toggle-grid', () => {
  const el = $('toggle-grid'); if (el) { el.checked = !el.checked; el.dispatchEvent(new Event('change')); }
});
shortcuts.on('toggle-theme', () => {
  const themes = ['dark','light','amoled'];
  const next = themes[(themes.indexOf(getTheme()) + 1) % themes.length];
  setTheme(next); toast('Tema: ' + next, 'info');
});
['pen','marker','highlighter','eraser','line','rect'].forEach(t => {
  shortcuts.on(`tool:${t}`, () => document.querySelector(`.tool-btn[data-tool="${t}"]`)?.click());
});
