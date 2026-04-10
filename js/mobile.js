/**
 * mobile.js — Controller do celular
 *
 * GESTOS (Pointer Events API):
 *   1 toque = desenha (modo draw) ou move VP (modo pan)
 *   2 toques = pan + pinch-zoom do viewport
 *
 * COORDENADAS: normalizado [0-1] via Viewport.screenToNorm()
 *
 * PROTOCOLO: ver desktop.js
 */

import { Peer, CS }   from './webrtc.js';
import { Viewport }   from './viewport.js';
import { getPrefs, setPref, getTheme, setTheme, applyTheme, toast } from './utils.js';

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
const qsa = sel => document.querySelectorAll(sel);

const sConnect = $('screen-connect');
const sDraw    = $('screen-draw');
const cvs      = $('draw-canvas');     // captura eventos + traços locais
const cvsBG    = $('bg-canvas');       // fundo / thumb PDF
const cvsGrid  = $('grid-canvas-mob');
const cvsRem   = $('remote-canvas-mob');

// ── Core state ─────────────────────────────────────────────────────────────────
let peer = null;
const vp = new Viewport(794, 1123, window.innerWidth, window.innerHeight - 120);

// ── Tool state ─────────────────────────────────────────────────────────────────
let tool  = 'pen';
let color = '#e63946';
let size  = 3;
let mode  = 'draw'; // 'draw' | 'pan'

// ── PDF info ───────────────────────────────────────────────────────────────────
let pdfThumb    = null;   // HTMLImageElement
let pdfPage     = 1;      // página atual no desktop
let zoomLocked  = false;

// ── Stroke state ────────────────────────────────────────────────────────────────
let strokeId   = 0;
let curStrokeId = null;

// Per-page local strokes (para re-render no pan/zoom)
const localStrokes = new Map(); // Map<page, stroke[]>
let   activeStroke = null;

// Remote strokes: { id → {tool,color,size,points[{nx,ny}]} }
const remActive = {};
const remDone   = new Map(); // Map<page, stroke[]>

// ── Gesture state machine ───────────────────────────────────────────────────────
// 'idle' | 'drawing' | 'panning' | 'pinching'
let gesture     = 'idle';
const ptrs      = new Map(); // pointerId → PointerEvent
let panLX=0, panLY=0;
let pinchDist=0, pinchMX=0, pinchMY=0;

// ── Canvas sizes ────────────────────────────────────────────────────────────────
let csW = 0, csH = 0, dpr = 1;

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

applyTheme();
;(function restorePrefs() {
  const p = getPrefs();
  tool  = p.tool  || 'pen';
  color = p.color || '#e63946';
  size  = p.size  || 3;
  const sc=$('mob-color'); if(sc) sc.value = color;
  const ss=$('mob-size');  if(ss) { ss.value=size; updateSizeDot(size); }
  qsa('.mob-tool[data-tool]').forEach(b=>b.classList.toggle('active', b.dataset.tool===tool));
  qsa('[data-theme]').forEach(b=>b.classList.toggle('active', b.dataset.theme===getTheme()));
  const bg = $('bg-select'); if(bg) bg.value = p.bgMode||'pdf';
  const ps = $('pan-sens');  if(ps) ps.value = p.panSens||1;
  const hp = $('tog-haptic');if(hp) hp.checked = p.haptic??true;
  const pl = $('tog-palm');  if(pl) pl.checked = p.palmReject??true;
  const gl = $('tog-grid');  if(gl) gl.checked = p.gridEnabled??false;
  const zl = $('tog-zoom-lock'); if(zl) zl.checked = p.zoomLocked??false;
  zoomLocked = p.zoomLocked ?? false;
})();

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS RESIZE
// ══════════════════════════════════════════════════════════════════════════════

function resize() {
  const hud = $('mob-hud')?.offsetHeight ?? 52;
  const bar = $('mob-toolbar')?.offsetHeight ?? 120;
  csW = window.innerWidth;
  csH = Math.max(80, window.innerHeight - hud - bar);
  dpr = window.devicePixelRatio || 1;

  [cvs, cvsBG, cvsGrid, cvsRem].forEach(c => {
    if (!c) return;
    c.width  = csW * dpr; c.height = csH * dpr;
    c.style.width  = csW + 'px'; c.style.height = csH + 'px';
    c.style.top    = hud + 'px';
    c.style.position = 'absolute'; c.style.left = '0';
  });

  vp.setScr(csW, csH);
  redraw();
}
window.addEventListener('resize', () => { if (sDraw.classList.contains('active')) resize(); });

// ══════════════════════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════════════════════

let _dirty = false;
function markDirty() {
  if (_dirty) return;
  _dirty = true;
  requestAnimationFrame(() => { _dirty=false; redraw(); });
}

function redraw() {
  drawBG();
  drawGrid();
  drawLayer(cvsRem,  remDone,    true);
  drawLayer(cvs,     localStrokes, false);
  drawActiveStroke();
  drawRemActive();
}

// Fundo + thumb PDF
function drawBG() {
  const ctx = cvsBG?.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, csW*dpr, csH*dpr);
  const bgMode = getPrefs().bgMode || 'pdf';
  if (bgMode === 'dark')         { ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,csW*dpr,csH*dpr); }
  else if (bgMode === 'light')   { ctx.fillStyle='#f8f8f5'; ctx.fillRect(0,0,csW*dpr,csH*dpr); }
  else if (bgMode === 'amoled')  { /* pure black — CSS já define */ return; }
  else if (bgMode === 'grid')    { ctx.fillStyle='#0d0d0f'; ctx.fillRect(0,0,csW*dpr,csH*dpr); }
  else { ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,csW*dpr,csH*dpr); } // default dark

  if (pdfThumb && bgMode === 'pdf') {
    ctx.drawImage(pdfThumb,
      -vp.x * vp.z * dpr, -vp.y * vp.z * dpr,
      vp.docW * vp.z * dpr, vp.docH * vp.z * dpr
    );
  }
}

function drawGrid() {
  const ctx = cvsGrid?.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0,0,csW*dpr,csH*dpr);
  if (!getPrefs().gridEnabled) return;
  const step = 40 * vp.z * dpr;
  const offX = ((-vp.x*vp.z*dpr) % step + step) % step;
  const offY = ((-vp.y*vp.z*dpr) % step + step) % step;
  ctx.strokeStyle='rgba(124,106,247,0.22)'; ctx.lineWidth=0.5*dpr;
  for (let x=offX; x<csW*dpr; x+=step) { ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,csH*dpr);ctx.stroke(); }
  for (let y=offY; y<csH*dpr; y+=step) { ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(csW*dpr,y);ctx.stroke(); }
}

function drawLayer(canvas, strokMap, isRemote) {
  const ctx = canvas?.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0,0,csW*dpr,csH*dpr);
  const strokes = strokMap.get(isRemote ? pdfPage : pdfPage) ?? [];
  ctx.save();
  // Clip to document area
  const cx=Math.max(0,-vp.x*vp.z*dpr), cy=Math.max(0,-vp.y*vp.z*dpr);
  const cw=Math.min(csW*dpr, vp.docW*vp.z*dpr), ch=Math.min(csH*dpr, vp.docH*vp.z*dpr);
  ctx.beginPath(); ctx.rect(cx,cy,cw,ch); ctx.clip();
  strokes.forEach(s => drawStroke(ctx, s));
  ctx.restore();
}

function drawActiveStroke() {
  // Repaint active local stroke after a full redraw (pan/zoom resets canvas)
  if (!activeStroke || activeStroke.points.length < 1) return;
  const ctx = cvs?.getContext('2d'); if (!ctx) return;
  ctx.save();
  const cx=Math.max(0,-vp.x*vp.z*dpr), cy=Math.max(0,-vp.y*vp.z*dpr);
  const cw=Math.min(csW*dpr, vp.docW*vp.z*dpr), ch=Math.min(csH*dpr, vp.docH*vp.z*dpr);
  ctx.beginPath(); ctx.rect(cx,cy,cw,ch); ctx.clip();
  drawStroke(ctx, activeStroke);
  ctx.restore();
}

function drawRemActive() {
  // Repaint in-progress remote strokes after a full redraw
  const ctx = cvsRem?.getContext('2d'); if (!ctx) return;
  const entries = Object.values(remActive);
  if (!entries.length) return;
  ctx.save();
  const cx=Math.max(0,-vp.x*vp.z*dpr), cy=Math.max(0,-vp.y*vp.z*dpr);
  const cw=Math.min(csW*dpr, vp.docW*vp.z*dpr), ch=Math.min(csH*dpr, vp.docH*vp.z*dpr);
  ctx.beginPath(); ctx.rect(cx,cy,cw,ch); ctx.clip();
  entries.forEach(s => drawStroke(ctx, s));
  ctx.restore();
}

function drawStroke(ctx, s) {
  const pts = s.points; if (!pts?.length) return;
  const TOOLS_DEF = { pen:{mul:1,alpha:1,op:'source-over'}, marker:{mul:2.5,alpha:1,op:'source-over'}, highlighter:{mul:8,alpha:0.35,op:'source-over'}, eraser:{mul:5,alpha:1,op:'destination-out'} };
  const t = TOOLS_DEF[s.tool] ?? TOOLS_DEF.pen;
  ctx.save();
  ctx.lineCap=ctx.lineJoin='round';
  ctx.globalCompositeOperation=t.op; ctx.globalAlpha=t.alpha;
  ctx.strokeStyle=s.tool==='eraser'?'rgba(0,0,0,1)':s.color; ctx.fillStyle=ctx.strokeStyle;
  ctx.lineWidth=s.size*t.mul*dpr;

  const sc = (nx,ny) => {
    const p=vp.normToScreen(nx,ny); return {x:p.x*dpr,y:p.y*dpr};
  };

  if (pts.length===1) {
    const p=sc(pts[0].nx,pts[0].ny);
    ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.5,ctx.lineWidth/2),0,Math.PI*2); ctx.fill();
  } else if (s.tool==='line') {
    const a=sc(pts[0].nx,pts[0].ny), b=sc(pts[pts.length-1].nx,pts[pts.length-1].ny);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  } else if (s.tool==='rect') {
    const a=sc(pts[0].nx,pts[0].ny), b=sc(pts[pts.length-1].nx,pts[pts.length-1].ny);
    ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
  } else {
    ctx.beginPath();
    const p0=sc(pts[0].nx,pts[0].ny); ctx.moveTo(p0.x,p0.y);
    if (pts.length===2) { const p1=sc(pts[1].nx,pts[1].ny); ctx.lineTo(p1.x,p1.y); }
    else {
      for (let i=1;i<pts.length-1;i++) {
        const c=sc(pts[i].nx,pts[i].ny), n=sc(pts[i+1].nx,pts[i+1].ny);
        ctx.quadraticCurveTo(c.x,c.y,(c.x+n.x)/2,(c.y+n.y)/2);
      }
      const l=sc(pts[pts.length-1].nx,pts[pts.length-1].ny); ctx.lineTo(l.x,l.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ── Incremental segment for active stroke ────────────────────────────────────
function drawSegIncr(ctx, s, prevPt, newPt) {
  const TOOLS_DEF = { pen:{mul:1,alpha:1,op:'source-over'}, marker:{mul:2.5,alpha:1,op:'source-over'}, highlighter:{mul:8,alpha:0.35,op:'source-over'}, eraser:{mul:5,alpha:1,op:'destination-out'} };
  const t = TOOLS_DEF[s.tool] ?? TOOLS_DEF.pen;
  ctx.save();
  ctx.lineCap=ctx.lineJoin='round';
  ctx.globalCompositeOperation=t.op; ctx.globalAlpha=t.alpha;
  ctx.strokeStyle=s.tool==='eraser'?'rgba(0,0,0,1)':s.color;
  ctx.fillStyle=ctx.strokeStyle;
  ctx.lineWidth=s.size*t.mul*dpr;
  if (!prevPt) {
    // Dot for stroke start
    const p=vp.normToScreen(newPt.nx,newPt.ny);
    ctx.beginPath(); ctx.arc(p.x*dpr,p.y*dpr,Math.max(0.5,ctx.lineWidth/2),0,Math.PI*2); ctx.fill();
  } else {
    const a=vp.normToScreen(prevPt.nx,prevPt.ny), b=vp.normToScreen(newPt.nx,newPt.ny);
    ctx.beginPath(); ctx.moveTo(a.x*dpr,a.y*dpr); ctx.lineTo(b.x*dpr,b.y*dpr); ctx.stroke();
  }
  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// POINTER EVENTS
// ══════════════════════════════════════════════════════════════════════════════

function bindInput() {
  cvs.removeEventListener('pointerdown',  onDown);
  cvs.removeEventListener('pointermove',  onMove);
  cvs.removeEventListener('pointerup',    onUp);
  cvs.removeEventListener('pointercancel',onCancel);
  cvs.addEventListener('pointerdown',  onDown,   {passive:false});
  cvs.addEventListener('pointermove',  onMove,   {passive:false});
  cvs.addEventListener('pointerup',    onUp,     {passive:false});
  cvs.addEventListener('pointercancel',onCancel, {passive:false});
}

function isPalm(e) {
  return (getPrefs().palmReject ?? true) && e.pointerType==='touch' && (e.width>60||e.height>60);
}

function firstId() { return ptrs.keys().next().value ?? null; }

function onDown(e) {
  e.preventDefault();
  if (isPalm(e)) return;
  ptrs.set(e.pointerId, e); cvs.setPointerCapture(e.pointerId);

  if (ptrs.size === 1 && gesture === 'idle') {
    const {x,y} = canvasXY(e);
    if (mode === 'draw') {
      gesture = 'drawing'; beginStroke(x, y);
    } else {
      gesture = 'panning'; panLX=e.clientX; panLY=e.clientY;
    }
  } else if (ptrs.size === 2) {
    if (gesture === 'drawing') { cancelStroke(); }
    gesture = 'pinching';
    const [a,b] = [...ptrs.values()];
    pinchDist = Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    pinchMX=(a.clientX+b.clientX)/2; pinchMY=(a.clientY+b.clientY)/2;
  }
}

function onMove(e) {
  e.preventDefault();
  ptrs.set(e.pointerId, e);
  if (gesture==='drawing' && e.pointerId===firstId()) {
    const {x,y} = canvasXY(e); continueStroke(x, y);
  } else if (gesture==='panning' && e.pointerId===firstId()) {
    const sens = parseFloat($('pan-sens')?.value ?? '1');
    vp.pan((e.clientX-panLX)*sens, (e.clientY-panLY)*sens);
    panLX=e.clientX; panLY=e.clientY; markDirty();
  } else if (gesture==='pinching' && ptrs.size>=2) {
    doPinch();
  }
}

function onUp(e) {
  e.preventDefault(); ptrs.delete(e.pointerId);
  if (gesture==='drawing' && ptrs.size===0) { finishStroke(); gesture='idle'; }
  else if (gesture==='panning' && ptrs.size===0) { gesture='idle'; }
  else if (gesture==='pinching') {
    if (ptrs.size===1) {
      gesture='panning';
      const rem=[...ptrs.values()][0]; panLX=rem.clientX; panLY=rem.clientY;
    } else if (ptrs.size===0) gesture='idle';
  }
}

function onCancel(e) {
  ptrs.delete(e.pointerId);
  if (gesture==='drawing') { cancelStroke(); }
  if (ptrs.size===0) gesture='idle';
}

function canvasXY(e) {
  const r=cvs.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top};
}

// ── Pinch ──────────────────────────────────────────────────────────────────────
function doPinch() {
  const [a,b]=[...ptrs.values()];
  const dist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
  const mx=(a.clientX+b.clientX)/2, my=(a.clientY+b.clientY)/2;
  const r=cvs.getBoundingClientRect();
  const fx=mx-r.left, fy=my-r.top;

  if (!zoomLocked && pinchDist>0) {
    vp.zoomAt(vp.z*(dist/pinchDist), fx, fy);
  }
  const sens=parseFloat($('pan-sens')?.value??'1');
  vp.pan((mx-pinchMX)*sens,(my-pinchMY)*sens);
  pinchDist=dist; pinchMX=mx; pinchMY=my;
  markDirty();
}

// ══════════════════════════════════════════════════════════════════════════════
// STROKE LOGIC
// ══════════════════════════════════════════════════════════════════════════════

function beginStroke(sx, sy) {
  strokeId++; curStrokeId = `m${strokeId}`;
  const {nx,ny} = vp.screenToNorm(sx, sy);
  activeStroke = { tool, color, size, points:[{nx,ny}] };
  localStrokes.has(pdfPage) || localStrokes.set(pdfPage,[]);
  localStrokes.get(pdfPage).push(activeStroke);
  if (getPrefs().haptic && navigator.vibrate) navigator.vibrate(8);
  peer?.send({type:'stroke:start',id:curStrokeId,tool,color,size,nx,ny,page:pdfPage});
}

function continueStroke(sx, sy) {
  if (!activeStroke) return;
  const {nx,ny}=vp.screenToNorm(sx,sy);
  const pts=activeStroke.points;
  const prev=pts[pts.length-1];
  // Minimum distance filter
  if (Math.hypot(nx-prev.nx, ny-prev.ny) < 0.5/Math.max(vp.docW,vp.docH)) return;
  pts.push({nx,ny});
  drawSegIncr(cvs.getContext('2d'), activeStroke, prev, {nx,ny});
  peer?.send({type:'stroke:move',id:curStrokeId,nx,ny});
}

function finishStroke() {
  activeStroke=null;
  peer?.send({type:'stroke:end',id:curStrokeId}); curStrokeId=null;
}

function cancelStroke() {
  // Remove o stroke ativo da lista
  if (activeStroke) {
    const arr=localStrokes.get(pdfPage)??[];
    const idx=arr.lastIndexOf(activeStroke); if(idx>=0) arr.splice(idx,1);
  }
  activeStroke=null;
  peer?.send({type:'stroke:end',id:curStrokeId}); curStrokeId=null;
  markDirty();
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEWPORT BROADCAST
// ══════════════════════════════════════════════════════════════════════════════

let _vpTimer=null;
function startVPBroadcast() {
  if (_vpTimer) return;
  _vpTimer=setInterval(()=>{
    if(peer?.state===CS.CONNECTED) peer.send({type:'viewport',...vp.toMsg()});
  },40);
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGES FROM DESKTOP
// ══════════════════════════════════════════════════════════════════════════════

function onMsg(msg) {
  if (!msg?.type) return;
  switch(msg.type) {
    case 'stroke:start': {
      const s={tool:msg.tool,color:msg.color,size:msg.size,points:[{nx:msg.nx,ny:msg.ny}]};
      remActive[msg.id]=s;
      // Draw dot
      const ctx=cvsRem?.getContext('2d'); if(ctx){ drawSegIncr(ctx,s,null,{nx:msg.nx,ny:msg.ny}); }
      break;
    }
    case 'stroke:move': {
      const s=remActive[msg.id]; if(!s) break;
      const prev=s.points[s.points.length-1];
      s.points.push({nx:msg.nx,ny:msg.ny});
      const ctx=cvsRem?.getContext('2d'); if(ctx) drawSegIncr(ctx,s,prev,{nx:msg.nx,ny:msg.ny});
      break;
    }
    case 'stroke:end': {
      const s=remActive[msg.id]; if(s){ remDone.has(pdfPage)||remDone.set(pdfPage,[]); remDone.get(pdfPage).push(s); }
      delete remActive[msg.id]; break;
    }
    case 'clear:all':    localStrokes.clear(); remDone.clear(); Object.keys(remActive).forEach(k=>delete remActive[k]); markDirty(); break;
    case 'clear:remote': remDone.clear(); Object.keys(remActive).forEach(k=>delete remActive[k]); markDirty(); break;
    case 'clear:local':  localStrokes.clear(); markDirty(); break;
    case 'undo': {
      const arr=remDone.get(pdfPage)??[]; if(arr.length){arr.pop();markDirty();} break;
    }
    case 'pdf:size':
      vp.setDoc(msg.w, msg.h); markDirty(); break;
    case 'pdf:thumb': {
      const img=new Image(); img.onload=()=>{pdfThumb=img;markDirty();}; img.src=msg.data; break;
    }
    case 'pdf:page':
      pdfPage = msg.page ?? 1;
      setText('mob-page-info', `Pág ${msg.page}${msg.total?'/'+msg.total:''}`);
      setTimeout(()=>setText('mob-page-info',''), 2500);
      break;
    case 'pdf:swapping':
      remDone.clear(); Object.keys(remActive).forEach(k=>delete remActive[k]);
      pdfThumb=null; markDirty();
      toast('📄 Novo PDF chegando…','info',1500); break;
    case 'viewport:set':
      vp.moveTo(msg.nx*vp.docW, msg.ny*vp.docH); markDirty(); break;
    case 'state:sync':
      if(typeof msg.zoomLocked==='boolean'){
        zoomLocked=msg.zoomLocked; setPref('zoomLocked',msg.zoomLocked);
        const el=$('tog-zoom-lock');if(el) el.checked=msg.zoomLocked;
        toast(msg.zoomLocked?'🔒 Zoom travado':'🔓 Zoom liberado','info');
      }
      if(typeof msg.gridEnabled==='boolean'){
        setPref('gridEnabled',msg.gridEnabled);
        const el=$('tog-grid');if(el) el.checked=msg.gridEnabled;
        markDirty();
      }
      break;
    case 'request:pdf': break; // não se aplica no celular
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CODE INPUT + CONEXÃO
// ══════════════════════════════════════════════════════════════════════════════

const codeChars=[...qsa('.code-char')];
codeChars.forEach((inp,i)=>{
  inp.addEventListener('input',e=>{
    const v=e.target.value.replace(/\D/,''); inp.value=v;
    inp.classList.toggle('filled',!!v);
    if(v&&i<codeChars.length-1) codeChars[i+1].focus();
    checkCode();
  });
  inp.addEventListener('keydown',e=>{
    if(e.key==='Backspace'&&!inp.value&&i>0){codeChars[i-1].focus();codeChars[i-1].value='';codeChars[i-1].classList.remove('filled');}
  });
  inp.addEventListener('paste',e=>{
    e.preventDefault();
    const t=e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
    t.split('').forEach((c,j)=>{if(codeChars[j]){codeChars[j].value=c;codeChars[j].classList.add('filled');}});
    checkCode();
  });
});
const getCode=()=>codeChars.map(i=>i.value).join('');
const checkCode=()=>{ const b=$('btn-connect'); if(b) b.disabled=getCode().length<6; };

// Auto-fill via URL
;(()=>{
  const code=new URLSearchParams(location.search).get('code');
  if(code&&/^\d{6}$/.test(code)){
    code.split('').forEach((c,i)=>{if(codeChars[i]){codeChars[i].value=c;codeChars[i].classList.add('filled');}});
    checkCode(); setTimeout(()=>$('btn-connect')?.click(),500);
  }
})();

on('btn-connect','click',async()=>{
  const code=getCode(); if(code.length<6) return;
  setStatus('connecting','Conectando…'); $('btn-connect').disabled=true;
  peer=new Peer({role:'guest',code,onState:handleState,onMsg});
  try{await peer.startGuest();}
  catch(err){setStatus('error',err.message.split('\n')[0]);$('btn-connect').disabled=false;}
});

function handleState(s) {
  if(s===CS.CONNECTED){
    setStatus('success','Conectado!');
    setTimeout(()=>{
      sConnect.classList.remove('active');
      sDraw.classList.add('active'); sDraw.style.display='flex';
      $('mob-status-dot')?.classList.replace('disconnected','connected');
      setText('mob-status-text','Conectado');
      peer.send({type:'request:pdf'});
      resize(); bindInput(); startVPBroadcast();
      toast('1 dedo = desenha  |  2 dedos = move/zoom','info',3000);
    },500);
  } else if(s===CS.DISCONNECTED){
    setText('mob-status-text','Desconectado');
    $('mob-status-dot')?.classList.replace('connected','disconnected');
    if(sDraw.classList.contains('active')){
      toast('Conexão perdida','error');
      setTimeout(()=>{
        sDraw.classList.remove('active'); sDraw.style.display='';
        sConnect.classList.add('active');
        $('btn-connect').disabled=false; setStatus('','');
      },1500);
    }
  } else if(s===CS.ERROR){
    setStatus('error','Falha na conexão'); $('btn-connect').disabled=false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOLBAR UI
// ══════════════════════════════════════════════════════════════════════════════

qsa('.mob-tool[data-tool]').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.tool==='pan'){
    mode=mode==='pan'?'draw':'pan';
    qsa('.mob-tool[data-tool]').forEach(x=>x.classList.remove('active'));
    if(mode==='pan') b.classList.add('active');
    else $(`[data-tool="${tool}"]`)?.classList.add('active');
    setText('mob-mode-label',mode==='pan'?'Navegar':'Desenho');
    return;
  }
  mode='draw'; tool=b.dataset.tool; setPref('tool',tool);
  qsa('.mob-tool[data-tool]').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  setText('mob-mode-label','Desenho');
}));

qsa('.quick-color').forEach(b=>b.addEventListener('click',()=>{
  qsa('.quick-color').forEach(x=>x.classList.remove('active')); b.classList.add('active');
  color=b.dataset.color; setPref('color',color);
  const mc=$('mob-color');if(mc) mc.value=color;
}));
on('mob-color','input',e=>{color=e.target.value;setPref('color',color);qsa('.quick-color').forEach(x=>x.classList.remove('active'));});

on('mob-size','input',e=>{size=parseInt(e.target.value);setPref('size',size);updateSizeDot(size);});
function updateSizeDot(v){
  const d=$('size-dot');if(d){const px=Math.min(40,Math.max(2,v));d.style.width=px+'px';d.style.height=px+'px';}
  const l=$('mob-size-label');if(l) l.textContent=v;
}

on('btn-mob-undo','click',()=>{
  const arr=localStrokes.get(pdfPage)??[];
  if(!arr.length){toast('Nada para desfazer','info',800);return;}
  arr.pop(); markDirty(); peer?.send({type:'undo'});
  if(navigator.vibrate) navigator.vibrate([10,20,10]);
});

on('btn-mob-clear','click',()=>{
  const arr=localStrokes.get(pdfPage)??[];
  if(!arr.length){toast('Nada para limpar','info',800);return;}
  if(!confirm('Limpar seus traços desta página?')) return;
  localStrokes.set(pdfPage,[]); markDirty(); peer?.send({type:'clear:local'});
});

on('btn-mob-disconnect','click',async()=>{
  clearInterval(_vpTimer);_vpTimer=null;
  await peer?.disconnect(); peer=null;
  sDraw.classList.remove('active'); sDraw.style.display='';
  sConnect.classList.add('active');
  codeChars.forEach(i=>{i.value='';i.classList.remove('filled');}); checkCode(); setStatus('','');
  localStrokes.clear(); remDone.clear();
});

// Menu
on('btn-mob-menu','click',()=>$('mob-menu')?.classList.remove('hidden'));
on('btn-close-menu','click',()=>$('mob-menu')?.classList.add('hidden'));

on('bg-select','change',e=>{ setPref('bgMode',e.target.value); markDirty(); });
on('pan-sens','input',e=>setPref('panSens',parseFloat(e.target.value)));
on('tog-haptic','change',e=>setPref('haptic',e.target.checked));
on('tog-palm','change',e=>setPref('palmReject',e.target.checked));
on('tog-zoom-lock','change',e=>{
  zoomLocked=e.target.checked; setPref('zoomLocked',zoomLocked);
  peer?.send({type:'state:sync',zoomLocked});
  toast(zoomLocked?'🔒 Zoom travado':'🔓 Zoom liberado','info');
});
on('tog-grid','change',e=>{setPref('gridEnabled',e.target.checked);markDirty();});
qsa('[data-theme]').forEach(b=>b.addEventListener('click',()=>{
  setTheme(b.dataset.theme); qsa('[data-theme]').forEach(x=>x.classList.toggle('active',x===b));
}));

// Helpers
function setStatus(type,text){
  const s=$('conn-status');if(s) s.className='conn-status '+type;
  const m=$('conn-msg');if(m) m.textContent=text;
}
function setText(id,txt){const el=$(id);if(el)el.textContent=txt;}
