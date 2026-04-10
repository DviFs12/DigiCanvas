/**
 * webrtc.js — RTCPeerConnection + RTCDataChannel
 * Usa SignalingChannel do Firebase para trocar offer/answer/ICE.
 */
import { SignalingChannel } from './signaling.js';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export const CS = { IDLE:'idle', CONNECTING:'connecting', CONNECTED:'connected', DISCONNECTED:'disconnected', ERROR:'error' };

export class Peer {
  constructor({ role, code, onState, onMsg }) {
    this.role = role; this.code = code;
    this.onState = onState || (()=>{}); this.onMsg = onMsg || (()=>{});
    this.state = CS.IDLE;
    this.pc = null; this.ch = null; this.sig = null;
    this._cleanup = [];
  }

  async startHost() {
    this._setState(CS.CONNECTING);
    this.sig = new SignalingChannel(this.code, 'host');
    await this.sig.init();
    await this.sig.createSession();
    this.pc = this._createPC();
    this.ch = this.pc.createDataChannel('dc', { ordered: false, maxRetransmits: 0 });
    this._setupCh(this.ch);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.sig.sendOffer({ type: offer.type, sdp: offer.sdp });
    const stopAnswer = this.sig.onAnswer(async d => {
      if (this.pc.remoteDescription) return;
      await this.pc.setRemoteDescription(new RTCSessionDescription(d));
    });
    const stopICE = this.sig.onICE(async c => {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    });
    this._cleanup.push(stopAnswer, stopICE);
  }

  async startGuest() {
    this._setState(CS.CONNECTING);
    this.sig = new SignalingChannel(this.code, 'guest');
    try { await this.sig.init(); } catch(e) { this._setState(CS.ERROR); throw e; }
    const ok = await this.sig.sessionExists();
    if (!ok) {
      this._setState(CS.ERROR);
      throw new Error('Sessão não encontrada. Verifique o código e se o PC gerou um código.');
    }
    this.pc = this._createPC();
    this.pc.ondatachannel = e => { this.ch = e.channel; this._setupCh(e.channel); };
    const stopOffer = this.sig.onOffer(async d => {
      if (this.pc.remoteDescription) return;
      await this.pc.setRemoteDescription(new RTCSessionDescription(d));
      const ans = await this.pc.createAnswer();
      await this.pc.setLocalDescription(ans);
      await this.sig.sendAnswer({ type: ans.type, sdp: ans.sdp });
    });
    const stopICE = this.sig.onICE(async c => {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    });
    this._cleanup.push(stopOffer, stopICE);
  }

  send(data) {
    if (this.ch?.readyState !== 'open') return false;
    try { this.ch.send(typeof data === 'string' ? data : JSON.stringify(data)); return true; }
    catch { return false; }
  }

  async disconnect() {
    this._cleanup.forEach(f => { try { f?.(); } catch {} });
    this._cleanup = [];
    this.ch?.close(); this.pc?.close();
    await this.sig?.cleanup();
    this.ch = null; this.pc = null;
    this._setState(CS.DISCONNECTED);
  }

  _createPC() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const timeout = setTimeout(() => {
      if (this.state !== CS.CONNECTED) { this._setState(CS.ERROR); pc.close(); }
    }, 30000);
    pc.onicecandidate = async ({ candidate }) => {
      if (candidate) await this.sig.sendICE({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearTimeout(timeout); this._setState(CS.CONNECTED); }
      if (pc.connectionState === 'disconnected') this._setState(CS.DISCONNECTED);
      if (pc.connectionState === 'failed') { clearTimeout(timeout); this._setState(CS.ERROR); }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce?.();
    };
    return pc;
  }

  _setupCh(ch) {
    ch.onopen  = () => { console.log('[WebRTC] open'); this._setState(CS.CONNECTED); };
    ch.onclose = () => this._setState(CS.DISCONNECTED);
    ch.onerror = () => this._setState(CS.ERROR);
    ch.onmessage = ({ data }) => {
      try { this.onMsg(JSON.parse(data)); } catch { this.onMsg(data); }
    };
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s; this.onState(s);
  }
}
