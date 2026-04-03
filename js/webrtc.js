/**
 * webrtc.js
 * ─────────
 * Encapsula a lógica de WebRTC (RTCPeerConnection + RTCDataChannel).
 * Usa a SignalingChannel do firebase para trocar offer/answer/ICE.
 */

import { SignalingChannel } from './signaling.js';

// STUN servers públicos
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ── Estados de conexão ──────────────────────────────────────────────────────
export const ConnState = {
  IDLE:        'idle',
  CONNECTING:  'connecting',
  CONNECTED:   'connected',
  DISCONNECTED:'disconnected',
  ERROR:       'error',
};

// ── Classe principal ────────────────────────────────────────────────────────

export class DigiPeer {
  constructor({ role, code, onStateChange, onMessage }) {
    this.role          = role;          // 'host' | 'guest'
    this.code          = code;
    this.onStateChange = onStateChange || (() => {});
    this.onMessage     = onMessage     || (() => {});

    this.state     = ConnState.IDLE;
    this.pc        = null;
    this.channel   = null;
    this.signaling = null;

    this._cleanupFns = [];
  }

  // ── Iniciar conexão como HOST ──────────────────────────────────────────────

  async startAsHost() {
    this._setState(ConnState.CONNECTING);

    this.signaling = new SignalingChannel(this.code, 'host');
    await this.signaling.init();
    await this.signaling.createSession();

    this.pc = this._createPC();

    // Cria DataChannel antes de criar a offer
    this.channel = this.pc.createDataChannel('digicanvas', {
      ordered: false,          // permite reordenar para menor latência
      maxRetransmits: 0,       // sem retransmissão (preferimos dados frescos)
    });
    this._setupDataChannel(this.channel);

    // Cria e envia offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signaling.sendOffer({ type: offer.type, sdp: offer.sdp });

    // Espera answer
    const stopAnswerListener = this.signaling.onAnswer(async (answerData) => {
      if (this.pc.remoteDescription) return; // já processado
      const answer = new RTCSessionDescription(answerData);
      await this.pc.setRemoteDescription(answer);
      stopAnswerListener?.();
    });

    // Ouve ICE candidates do guest
    const stopICEListener = this.signaling.onICE(async (candidate) => {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[WebRTC] ICE candidate inválido:', e);
      }
    });

    this._cleanupFns.push(stopAnswerListener, stopICEListener);
  }

  // ── Iniciar conexão como GUEST ─────────────────────────────────────────────

  async startAsGuest() {
    this._setState(ConnState.CONNECTING);

    this.signaling = new SignalingChannel(this.code, 'guest');
    await this.signaling.init();

    const exists = await this.signaling.sessionExists();
    if (!exists) throw new Error('Sessão não encontrada. Verifique o código.');

    this.pc = this._createPC();

    // Guest recebe DataChannel via evento
    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this._setupDataChannel(this.channel);
    };

    // Espera e processa offer
    const stopOfferListener = this.signaling.onOffer(async (offerData) => {
      if (this.pc.remoteDescription) return;

      const offer = new RTCSessionDescription(offerData);
      await this.pc.setRemoteDescription(offer);

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.signaling.sendAnswer({ type: answer.type, sdp: answer.sdp });

      stopOfferListener?.();
    });

    // Ouve ICE candidates do host
    const stopICEListener = this.signaling.onICE(async (candidate) => {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[WebRTC] ICE candidate inválido:', e);
      }
    });

    this._cleanupFns.push(stopOfferListener, stopICEListener);
  }

  // ── Enviar mensagem ────────────────────────────────────────────────────────

  send(data) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.channel.send(payload);
      return true;
    } catch (e) {
      console.warn('[WebRTC] Erro ao enviar:', e);
      return false;
    }
  }

  // ── Desconectar ────────────────────────────────────────────────────────────

  async disconnect() {
    this._cleanupFns.forEach(fn => fn?.());
    this._cleanupFns = [];

    this.channel?.close();
    this.pc?.close();
    await this.signaling?.cleanup();

    this.channel = null;
    this.pc = null;
    this._setState(ConnState.DISCONNECTED);
  }

  // ── INTERNOS ────────────────────────────────────────────────────────────────

  _createPC() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Timeout de 30s para conectar
    const timeout = setTimeout(() => {
      if (this.state !== ConnState.CONNECTED) {
        console.warn('[WebRTC] Timeout de conexão — verifique STUN/TURN');
        this._setState(ConnState.ERROR);
        pc.close();
      }
    }, 30_000);

    pc.onicecandidate = async ({ candidate }) => {
      if (candidate) {
        await this.signaling.sendICE({
          candidate:     candidate.candidate,
          sdpMid:        candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log('[WebRTC] connectionState:', s);

      if (s === 'connected') {
        clearTimeout(timeout);
        this._setState(ConnState.CONNECTED);
      }
      if (s === 'disconnected') {
        this._setState(ConnState.DISCONNECTED);
      }
      if (s === 'failed') {
        clearTimeout(timeout);
        console.error('[WebRTC] Conexão falhou. Tente reconectar.');
        this._setState(ConnState.ERROR);
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] iceGathering:', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        console.warn('[WebRTC] ICE falhou — tentando restart...');
        pc.restartIce?.();
      }
    };

    return pc;
  }

  _setupDataChannel(ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      console.log('[WebRTC] DataChannel aberto');
      this._setState(ConnState.CONNECTED);
    };

    ch.onclose = () => {
      console.log('[WebRTC] DataChannel fechado');
      this._setState(ConnState.DISCONNECTED);
    };

    ch.onerror = (e) => {
      console.error('[WebRTC] DataChannel erro:', e);
      this._setState(ConnState.ERROR);
    };

    ch.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data);
        this.onMessage(parsed);
      } catch {
        this.onMessage(data);
      }
    };
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    this.onStateChange(newState);
  }
}
