/**
 * desktop.js — Controller principal do PC
 *
 * RESPONSABILIDADES:
 *  - Abrir/trocar PDF (PDF.js)
 *  - Anotar sobre o PDF (coordenadas normalizadas)
 *  - WebRTC como host
 *  - Sincronizar com celular: thumb, size, page, strokes
 *  - UI: toolbar, painel, recentes, temas, atalhos
 *
 * PROTOCOLO DE MENSAGENS (DataChannel):
 *   PC → Celular:
 *     pdf:size    { w, h }
 *     pdf:thumb   { data: jpegDataURL }
 *     pdf:page    { page, total }
 *     stroke:start/move/end  { id, tool, color, size, nx, ny }
 *     clear:all / clear:local / clear:remote
 *     undo / redo
 *     state:sync  { zoomLocked, gridEnabled }
 *     viewport:set { nx, ny }
 *
 *   Celular → PC:
 *     stroke:start/move/end  { id, tool, color, size, nx, ny, page }
 *     clear:all / clear:local / clear:remote
 *     undo
 *     viewport  { nx, ny, nw, nh, zoom }
 *     state:sync { zoomLocked }
 *     request:pdf
 */

import { generateCode }    from './signaling.js';
import { Peer, CS }        from './webrtc.js';
import { PDFViewer }       from './pdfviewer.js';
import { Annotation }      from './annotation.js';
import {
  getTheme, setTheme, applyTheme, cycleTheme,
  getPrefs, setPref,
  getRecents, addRecent, removeRecent, clearRecents,
  toast, showLoading, hideLoading,
} from './utils.js';

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
const qsa = sel => document.querySelectorAll(sel);

// ── Canvas elements ───────────────────────────────────────────────────────────
const cWrapper = $('canvas-wrapper');
const cPDF     = $('pdf-canvas');
const cAnnot   = $('annotation-canvas');
const cRemote  = $('remote-canvas');
const cGrid    = $('grid-canvas');
const cVP      = $('vp-indicator');

// ── Core state ────────────────────────────────────────────────────────────────
let viewer   = null;
let annot    = null;
let peer     = null;
let code     = null;
let strokeId = 0;

// Viewport do celular (normalizado)
let vpState   = { nx:0, ny:0, nw:1, nh:1, zoom:1 };
let followVP  = true;   // PC acompanha o viewport do celular
let pcMode    = 'draw'; // 'draw' | 'move'

// ── Init ──────────────────────────────────────────────────────────────────────
applyTheme();
renderRecents();
restorePrefs();

// ══════════════════════════════════════════════════════════════════════════════
// ABERTURA DE PDF
// ══════════════════════════════════════════════════════════════════════════════

on('file-input',        'change', e => openPDF(e.target.files[0]));
on('file-input-change', 'change', e => openPDF(e.target.files[0]));

async function openPDF(file) {
  if (!file) return;
  const isSwap = !!viewer?.doc;
  showLoading('Carregando PDF…');
  try {
    const buf = await file.arrayBuffer();
    $('pdf-filename').textContent = file.name;
    showMain();
    initCanvas();

    // Troca de PDF com sessão ativa: mantém conexão, limpa traços remotos
    if (isSwap && peer?.state === CS.CONNECTED) {
      peer.send({ type: 'pdf:swapping' });
      annot.clearRemote();
      toast('PDF trocado — conexão mantida ✓', 'success', 2500);
    }

    await viewer.load(buf);
    const thumb = await viewer.thumbnail(120);
    addRecent({ name: file.name, size: file.size, thumb });
    renderRecents();
  } catch (e) {
    toast('Erro ao abrir PDF: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

on('btn-demo', 'click', () => {
  showMain();
  initCanvas();
  // Página demo A4
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(794*dpr), H = Math.round(1123*dpr);
  [cPDF, cAnnot, cRemote, cGrid].forEach(c => {
    if (!c) return;
    c.width = W; c.height = H;
    c.style.width = '794px'; c.style.height = '1123px';
  });
  const ctx = cPDF.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
  ctx.save(); ctx.scale(dpr,dpr);
  ctx.fillStyle='#1a1a2e'; ctx.font='bold 28px sans-serif'; ctx.textAlign='center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 80);
  ctx.font='14px sans-serif'; ctx.fillStyle='#888';
  ['Abra um PDF ou conecte o celular.','1 dedo = desenha | 2 dedos = move/zoom'].forEach((t,i) =>
    ctx.fillText(t, 397, 130 + i*28)
  );
  ctx.restore();
  $('page-info').textContent = '1 / 1';
  annot?.onResize();
  drawGrid();
  broadcastPDF();
});

function showMain() {
  $('screen-welcome')?.classList.remove('active');
  const sm = $('screen-main');
  if (sm) { sm.classList.add('active'); sm.style.display = 'flex'; }
}

// ── Init canvas + viewer + annotation ────────────────────────────────────────

function initCanvas() {
  if (annot) return; // já inicializado
  annot = new Annotation(cAnnot, cRemote);

  annot.onStart = ({ tool, color, size, nx, ny, page }) => {
    strokeId++;
    annot._curId = `h${strokeId}`;
    peer?.send({ type:'stroke:start', id:annot._curId, tool, color, size, nx, ny, page });
  };
  annot.onMove = ({ nx, ny }) => peer?.send({ type:'stroke:move', id:annot._curId, nx, ny });
  annot.onEnd  = () => peer?.send({ type:'stroke:end', id:annot._curId });

  viewer = new PDFViewer(cPDF);
  viewer.onRender = (page, total) => {
    $('page-info').textContent  = `${page} / ${total}`;
    $('zoom-level').textContent = Math.round(viewer.scale * 100) + '%';
    // Sincroniza tamanho dos canvas overlay
    [cAnnot, cRemote, cGrid].forEach(c => {
      if (!c) return;
      c.width  = cPDF.width;  c.height = cPDF.height;
      c.style.width  = cPDF.style.width;
      c.style.height = cPDF.style.height;
    });
    annot.setPage(page);
    annot.onResize();
    drawGrid();
    broadcastPDF();
    peer?.send({ type:'pdf:page', page, total });
  };
}

// ── Grid ──────────────────────────────────────────────────────────────────────

function drawGrid() {
  if (!cGrid) return;
  const ctx = cGrid.getContext('2d');
  ctx.clearRect(0, 0, cGrid.width, cGrid.height);
  if (!getPrefs().gridEnabled) return;
  const dpr = window.devicePixelRatio || 1;
  const step = 40 * dpr;
  ctx.strokeStyle = 'rgba(124,106,247,0.18)'; ctx.lineWidth = 0.5;
  for (let x = 0; x < cGrid.width;  x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cGrid.height); ctx.stroke(); }
  for (let y = 0; y < cGrid.height; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cGrid.width,y);  ctx.stroke(); }
}

// ── Broadcast PDF ao celular ──────────────────────────────────────────────────

async function broadcastPDF() {
  if (!peer || peer.state !== CS.CONNECTED || !cPDF.width) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cPDF.width / dpr, h = cPDF.height / dpr;
  peer.send({ type:'pdf:size', w, h });

  // Thumb 400px para o celular usar como fundo
  try {
    const thumb = viewer?.doc
      ? await viewer.thumbnail(400)
      : (() => {
          const t = document.createElement('canvas');
          const s = Math.min(1, 400 / (cPDF.width/dpr));
          t.width = Math.round(cPDF.width/dpr*s); t.height = Math.round(cPDF.height/dpr*s);
          t.getContext('2d').drawImage(cPDF, 0, 0, t.width, t.height);
          return t.toDataURL('image/jpeg', 0.72);
        })();
    if (thumb) peer.send({ type:'pdf:thumb', data: thumb });
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLES DO PDF
// ══════════════════════════════════════════════════════════════════════════════

on('btn-prev',    'click', () => viewer?.prev());
on('btn-next',    'click', () => viewer?.next());
on('btn-zoom-in', 'click', () => viewer?.zoomIn());
on('btn-zoom-out','click', () => viewer?.zoomOut());
on('btn-fit',     'click', () => viewer?.fit(cWrapper));

// Ctrl+scroll para zoom
cWrapper?.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  e.deltaY < 0 ? viewer?.zoomIn(0.1) : viewer?.zoomOut(0.1);
}, { passive: false });

// ══════════════════════════════════════════════════════════════════════════════
// MODOS: draw | move
// ══════════════════════════════════════════════════════════════════════════════

function setMode(m) {
  pcMode = m;
  qsa('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('mode-label').textContent = m === 'draw' ? 'Desenhar' : 'Mover VP';
  annot?.setEnabled(m === 'draw');
  if (cAnnot) cAnnot.style.cursor = m === 'draw' ? 'crosshair' : 'default';
  if (cVP) cVP.style.pointerEvents = m === 'move' ? 'all' : 'none';
}

qsa('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// Arraste do indicador de viewport no modo "move"
let _vpDrag = null;
cVP?.addEventListener('pointerdown', e => {
  if (pcMode !== 'move') return;
  e.preventDefault(); cVP.setPointerCapture(e.pointerId);
  const vp = vpState;
  _vpDrag = { sx: e.clientX, sy: e.clientY, nx0: vp.nx, ny0: vp.ny };
  cVP.style.cursor = 'grabbing';
});
cVP?.addEventListener('pointermove', e => {
  if (!_vpDrag) return;
  e.preventDefault();
  const dpr = window.devicePixelRatio || 1;
  const W = cPDF.width/dpr, H = cPDF.height/dpr;
  const dx = e.clientX - _vpDrag.sx, dy = e.clientY - _vpDrag.sy;
  const nx = Math.max(0, Math.min(_vpDrag.nx0 + dx/W, Math.max(0, 1 - vpState.nw)));
  const ny = Math.max(0, Math.min(_vpDrag.ny0 + dy/H, Math.max(0, 1 - vpState.nh)));
  vpState = { ...vpState, nx, ny };
  positionVP();
  peer?.send({ type:'viewport:set', nx, ny });
});
cVP?.addEventListener('pointerup',    () => { _vpDrag = null; if (pcMode==='move') cVP.style.cursor='grab'; });
cVP?.addEventListener('pointercancel',() => { _vpDrag = null; });

function positionVP() {
  if (!cVP) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cPDF.width/dpr, H = cPDF.height/dpr;
  if (!W || !H) return;
  const { nx, ny, nw, nh } = vpState;
  const x = nx*W, y = ny*H, w = Math.max(8, nw*W), h = Math.max(8, nh*H);
  const cx = Math.max(0, Math.min(x, W-w)), cy = Math.max(0, Math.min(y, H-h));
  Object.assign(cVP.style, { display:'block', left:cx+'px', top:cy+'px', width:w+'px', height:h+'px' });
}

// ══════════════════════════════════════════════════════════════════════════════
// FERRAMENTAS DE ANOTAÇÃO
// ══════════════════════════════════════════════════════════════════════════════

qsa('[data-tool]').forEach(b => b.addEventListener('click', () => {
  qsa('[data-tool]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  annot?.setTool(b.dataset.tool);
  setPref('tool', b.dataset.tool);
  if (pcMode !== 'draw') setMode('draw');
}));

on('stroke-color', 'input', e => { annot?.setColor(e.target.value); setPref('color', e.target.value); });

on('stroke-size', 'input', e => {
  const v = parseInt(e.target.value);
  annot?.setSize(v); setPref('size', v);
  const lbl = $('stroke-size-label'); if (lbl) lbl.textContent = v;
});

on('btn-undo', 'click', () => { if (annot?.undo()) peer?.send({ type:'undo' }); });
on('btn-redo', 'click', () => { if (annot?.redo()) peer?.send({ type:'redo' }); });

on('btn-clear-all',    'click', () => { annot?.clearAll();    peer?.send({ type:'clear:all' }); });
on('btn-clear-local',  'click', () => { annot?.clearLocal();  peer?.send({ type:'clear:local' }); });
on('btn-clear-remote', 'click', () => { annot?.clearRemote(); peer?.send({ type:'clear:remote' }); });

on('btn-export', 'click', () => {
  if (!annot) return;
  const a = document.createElement('a');
  a.href = annot.exportPNG(); a.download = 'digicanvas.png'; a.click();
});

// ══════════════════════════════════════════════════════════════════════════════
// TOGGLES DO PAINEL
// ══════════════════════════════════════════════════════════════════════════════

on('toggle-remote', 'change', e => {
  if (annot) annot.showRemote = e.target.checked;
  if (cRemote) cRemote.style.display = e.target.checked ? '' : 'none';
  setPref('showRemote', e.target.checked);
});

on('toggle-grid', 'change', e => { setPref('gridEnabled', e.target.checked); drawGrid(); });

on('toggle-follow', 'change', e => {
  followVP = e.target.checked; setPref('followVP', followVP);
  syncFollowBtn();
});

on('toggle-zoom-lock', 'change', e => {
  setPref('zoomLocked', e.target.checked);
  peer?.send({ type:'state:sync', zoomLocked: e.target.checked });
  toast(e.target.checked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

// Botão rápido follow na toolbar
on('btn-follow-toggle', 'click', () => {
  followVP = !followVP; setPref('followVP', followVP);
  const chk = $('toggle-follow'); if (chk) chk.checked = followVP;
  syncFollowBtn();
  toast(followVP ? '🔗 Acompanhando viewport' : '🔓 Viewport livre', 'info');
});

function syncFollowBtn() {
  const btn = $('btn-follow-toggle');
  if (!btn) return;
  btn.classList.toggle('active', followVP);
  btn.title = followVP ? 'Viewport livre (K)' : 'Acompanhar viewport (K)';
}

// Temas
qsa('[data-theme]').forEach(b => b.addEventListener('click', () => {
  setTheme(b.dataset.theme);
  qsa('[data-theme]').forEach(x => x.classList.toggle('active', x === b));
  toast('Tema: ' + b.dataset.theme, 'info');
}));

// ══════════════════════════════════════════════════════════════════════════════
// ATALHOS DE TECLADO
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  const key = (e.ctrlKey||e.metaKey?'c+':'') + (e.shiftKey?'s+':'') + e.key.toLowerCase();
  const map = {
    'arrowleft':'prev','arrowright':'next','c+z':'undo','c+s+z':'redo',
    'p':'pen','m':'marker','h':'highlighter','e':'eraser','l':'line','r':'rect',
    'd':'draw','v':'move','f':'fit','g':'grid','k':'follow','t':'theme',
    '+':'zoomin','-':'zoomout','c+e':'export','c+o':'open',
  };
  const act = map[key]; if (!act) return;
  e.preventDefault();
  ({
    prev:   () => viewer?.prev(),
    next:   () => viewer?.next(),
    undo:   () => { if (annot?.undo()) peer?.send({type:'undo'}); },
    redo:   () => { if (annot?.redo()) peer?.send({type:'redo'}); },
    pen:    () => document.querySelector('[data-tool="pen"]')?.click(),
    marker: () => document.querySelector('[data-tool="marker"]')?.click(),
    highlighter: () => document.querySelector('[data-tool="highlighter"]')?.click(),
    eraser: () => document.querySelector('[data-tool="eraser"]')?.click(),
    line:   () => document.querySelector('[data-tool="line"]')?.click(),
    rect:   () => document.querySelector('[data-tool="rect"]')?.click(),
    draw:   () => setMode('draw'),
    move:   () => setMode('move'),
    fit:    () => viewer?.fit(cWrapper),
    grid:   () => { const el=$('toggle-grid'); if(el){el.checked=!el.checked;el.dispatchEvent(new Event('change'));} },
    follow: () => $('btn-follow-toggle')?.click(),
    theme:  () => { const t=cycleTheme(); toast('Tema: '+t,'info'); },
    zoomin: () => viewer?.zoomIn(),
    zoomout:() => viewer?.zoomOut(),
    export: () => $('btn-export')?.click(),
    open:   () => $('file-input')?.click(),
  })[act]?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBRTC — HOST
// ══════════════════════════════════════════════════════════════════════════════

on('btn-generate', 'click', async () => {
  if (peer) await peer.disconnect();
  code = generateCode();
  renderCode(code);
  $('code-display')?.classList.remove('hidden');
  peer = new Peer({ role:'host', code, onState: handleState, onMsg: handleMsg });
  try { await peer.startHost(); }
  catch (err) { toast('Erro: '+err.message,'error',5000); }
});

on('btn-disconnect', 'click', async () => {
  await peer?.disconnect(); peer = null;
  $('conn-badge')?.classList.add('hidden');
  $('conn-setup').style.display = '';
  $('code-display')?.classList.add('hidden');
  if (cVP) cVP.style.display = 'none';
  setDot('disconnected');
});

function handleState(s) {
  setDot(s === CS.CONNECTED ? 'connected' : s === CS.CONNECTING ? 'connecting' : 'disconnected');
  if (s === CS.CONNECTED) {
    $('conn-setup').style.display = 'none';
    $('conn-badge')?.classList.remove('hidden');
    toast('📱 Celular conectado!', 'success');
    setTimeout(() => {
      broadcastPDF();
      peer?.send({ type:'pdf:page', page: viewer?.page ?? 1, total: viewer?.total ?? 1 });
      peer?.send({ type:'state:sync',
        zoomLocked:  getPrefs().zoomLocked  ?? false,
        gridEnabled: getPrefs().gridEnabled ?? false,
      });
    }, 400);
  }
  if (s === CS.DISCONNECTED) {
    $('conn-badge')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    if (cVP) cVP.style.display = 'none';
    if (peer) toast('Celular desconectado', 'error');
  }
}

function handleMsg(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
    case 'clear:all': case 'clear:local': case 'clear:remote':
    case 'undo':
      annot?.applyMsg(msg); break;

    case 'viewport':
      receiveVP(msg); break;

    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        setPref('zoomLocked', msg.zoomLocked);
        const el = $('toggle-zoom-lock'); if (el) el.checked = msg.zoomLocked;
        toast(msg.zoomLocked ? '🔒 Zoom travado pelo celular' : '🔓 Zoom liberado', 'info');
        peer?.send({ type:'state:sync', zoomLocked: msg.zoomLocked }); // eco
      }
      break;

    case 'request:pdf':
      broadcastPDF();
      peer?.send({ type:'pdf:page', page: viewer?.page ?? 1, total: viewer?.total ?? 1 });
      break;
  }
}

function receiveVP({ nx, ny, nw, nh, zoom }) {
  const snw = Math.max(0.001, Math.min(1, nw));
  const snh = Math.max(0.001, Math.min(1, nh));
  const snx = Math.max(0, Math.min(nx, 1 - snw));
  const sny = Math.max(0, Math.min(ny, 1 - snh));
  vpState = { nx:snx, ny:sny, nw:snw, nh:snh, zoom: zoom ?? 1 };
  positionVP();
  const vx=$('vp-x'),vy=$('vp-y'),vz=$('vp-zoom');
  if (vx) vx.textContent = Math.round(snx*100)+'%';
  if (vy) vy.textContent = Math.round(sny*100)+'%';
  if (vz) vz.textContent = (zoom??1).toFixed(2)+'×';
  if (followVP && cWrapper) {
    const dpr=window.devicePixelRatio||1;
    const W=cPDF.width/dpr, H=cPDF.height/dpr;
    cWrapper.scrollTo({
      left: snx*W - cWrapper.clientWidth/2  + snw*W/2,
      top:  sny*H - cWrapper.clientHeight/2 + snh*H/2,
      behavior:'smooth',
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// QR CODE
// ══════════════════════════════════════════════════════════════════════════════

function renderCode(c) {
  const el = $('code-digits'); if (!el) return;
  el.innerHTML = '';
  c.split('').forEach((d,i) => {
    const s = document.createElement('div');
    s.className='digit'; s.textContent=d; s.style.animationDelay=i*60+'ms';
    el.appendChild(s);
  });
  // QR
  const qrEl = $('code-qr'); if (!qrEl) return;
  qrEl.innerHTML = '';
  let url;
  try {
    const u = new URL(location.href);
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/') + 'celular.html';
    u.search=''; url = u.href + '?code=' + c;
  } catch { url = './celular.html?code=' + c; }
  const lnk = $('qr-link'); if (lnk) lnk.textContent = url;
  const render = () => {
    qrEl.innerHTML='';
    if (typeof QRCode==='undefined') { qrEl.innerHTML=`<input readonly value="${url}" style="font-size:10px;width:100%;padding:4px"/>`; return; }
    try { new QRCode(qrEl,{text:url,width:120,height:120,colorDark:'#7c6af7',colorLight:'#1e1e2e',correctLevel:QRCode.CorrectLevel.M}); } catch {}
  };
  if (typeof QRCode!=='undefined') render();
  else { const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload=render; document.head.appendChild(s); }
}

function setDot(s) {
  const el=$('status-dot'); if(el) el.className='status-dot '+s;
}

// ══════════════════════════════════════════════════════════════════════════════
// RECENTES
// ══════════════════════════════════════════════════════════════════════════════

function renderRecents() {
  const c = $('recents-list'); if (!c) return;
  const list = getRecents();
  if (!list.length) { c.innerHTML='<p class="recents-empty">Nenhum arquivo recente</p>'; return; }
  c.innerHTML = list.map(r=>`
    <div class="recent-item" data-name="${r.name}">
      <div class="recent-thumb">${r.thumb?`<img src="${r.thumb}"/>`:'<div class="rec-ph">PDF</div>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${r.name}">${r.name}</span>
        <span class="recent-meta">${fmtSize(r.size)}</span>
      </div>
      <button class="recent-del" data-name="${r.name}">×</button>
    </div>`).join('');
  c.querySelectorAll('.recent-del').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); removeRecent(b.dataset.name); renderRecents();
  }));
  c.querySelectorAll('.recent-item').forEach(el => el.addEventListener('click', e => {
    if (e.target.classList.contains('recent-del')) return;
    toast('Use "Abrir PDF" para reabrir o arquivo','info');
  }));
}

const fmtSize = b => !b?'': b<1024?b+'B': b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';
on('btn-clear-recents','click',()=>{ clearRecents(); renderRecents(); });

// ══════════════════════════════════════════════════════════════════════════════
// RESTORE PREFS
// ══════════════════════════════════════════════════════════════════════════════

function restorePrefs() {
  const p = getPrefs();
  const chk=(id,v)=>{ const el=$(id); if(el) el.checked=v; };
  chk('toggle-remote',  p.showRemote    ?? true);
  chk('toggle-grid',    p.gridEnabled   ?? false);
  chk('toggle-follow',  p.followVP      ?? true);
  chk('toggle-zoom-lock', p.zoomLocked  ?? false);
  followVP = p.followVP ?? true;
  syncFollowBtn();

  const ss=$('stroke-size'); if(ss) ss.value=p.size??3;
  const sl=$('stroke-size-label'); if(sl) sl.textContent=p.size??3;
  const sc=$('stroke-color'); if(sc) sc.value=p.color??'#e63946';

  // Restaura ferramenta ativa
  const toolBtn = document.querySelector(`[data-tool="${p.tool||'pen'}"]`);
  if (toolBtn) { qsa('[data-tool]').forEach(x=>x.classList.remove('active')); toolBtn.classList.add('active'); }

  qsa('[data-theme]').forEach(b=>b.classList.toggle('active', b.dataset.theme===getTheme()));
}

// Dropdown tabs do painel
qsa('.panel-tab').forEach(b => b.addEventListener('click', () => {
  qsa('.panel-tab').forEach(x=>x.classList.remove('active'));
  qsa('.tab-content').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  $('tab-'+b.dataset.tab)?.classList.add('active');
}));

// Dropdowns da toolbar
qsa('[data-dropdown]').forEach(btn => btn.addEventListener('click', e => {
  e.stopPropagation();
  const menu = $(btn.dataset.dropdown);
  const open = menu?.classList.contains('open');
  qsa('.tb-dropdown').forEach(m=>m.classList.remove('open'));
  if (!open) menu?.classList.add('open');
}));
document.addEventListener('click', ()=>qsa('.tb-dropdown').forEach(m=>m.classList.remove('open')));
