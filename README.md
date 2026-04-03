# DigiCanvas 🎨

**Mesa digitalizadora remota no navegador** — Desenhe no celular, veja no computador em tempo real.

---

## Como funciona

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│   CELULAR (celular.html)          COMPUTADOR (index.html)        │
│   ┌─────────────────┐             ┌──────────────────────────┐  │
│   │  Canvas de      │  WebRTC     │  PDF + Canvas de         │  │
│   │  desenho tátil  │ ──P2P────►  │  anotação                │  │
│   │                 │             │                          │  │
│   │  Gestos pan/    │ ──viewport─► │  Retângulo indicador     │  │
│   │  zoom do VP     │             │  de foco                 │  │
│   └─────────────────┘             └──────────────────────────┘  │
│              │                              │                   │
│              └────────── Firebase ──────────┘                   │
│                     (sinalização WebRTC)                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Instruções de uso

### 1. Configure o Firebase
Siga o guia em `firebase-setup.md` para criar e configurar o projeto Firebase.
Atualize `js/firebase-config.js` com suas credenciais.

### 2. Desktop — Abra index.html
- Clique em **"Abrir PDF"** para carregar um documento
- Ou use **"Modo Demo"** para testar sem PDF
- No painel direito, clique em **"Gerar Código"**
- Um código de 6 dígitos será exibido

### 3. Celular — Abra celular.html
- Abra `celular.html` no navegador do smartphone
- Instale como PWA (opcional): toque em "Adicionar à tela inicial"
- Digite o código de 6 dígitos mostrado no computador
- Toque em **"Conectar"**

### 4. Desenhe!
- **Um dedo** → desenha no canvas
- **Dois dedos** → faz pan e zoom do viewport
- O **retângulo azul** no computador mostra onde o celular está focado
- Os traços do celular aparecem no computador em tempo real

---

## Ferramentas disponíveis

### Desktop
| Ferramenta | Descrição |
|-----------|-----------|
| 🖊 Caneta | Traço preciso, opacidade total |
| 🖌 Marcador | Traço largo, semi-transparente |
| ✏️ Borracha | Apaga pixels |
| ─ Linha | Linha reta entre dois pontos |
| □ Retângulo | Retângulo vazado |
| 🎨 Cor | Seletor de cor |
| S/M/L | Tamanho do traço |
| ↩ Undo | Desfaz última ação (Ctrl+Z) |
| 🗑 Limpar | Remove todas as anotações |
| ⬇ Exportar | Salva PDF+anotações como PNG |

### Celular
| Gesto | Ação |
|-------|------|
| 1 dedo | Desenha |
| 2 dedos (arrastar) | Move viewport |
| 2 dedos (pinch) | Zoom do viewport |
| Botão "Mover viewport" | Alterna modo pan com 1 dedo |

---

## Arquitetura técnica

```
digicanvas/
├── index.html          # Interface do computador
├── celular.html        # Interface do celular (PWA)
├── manifest.json       # Manifesto PWA
├── firebase-setup.md   # Guia de configuração do Firebase
├── README.md           # Este arquivo
│
├── css/
│   ├── shared.css      # Variáveis, botões, componentes comuns
│   ├── desktop.css     # Estilos específicos do desktop
│   └── mobile.css      # Estilos específicos do celular
│
└── js/
    ├── firebase-config.js  # ⚙️ Credenciais Firebase (editar)
    ├── signaling.js        # Troca de sinais WebRTC via Firebase RTDB
    ├── webrtc.js           # RTCPeerConnection + RTCDataChannel
    ├── pdf-viewer.js       # Renderização PDF com PDF.js
    ├── annotation.js       # Motor de anotação (desktop)
    ├── desktop.js          # Controller do computador
    └── mobile.js           # Controller do celular
```

### Fluxo de conexão WebRTC

```
HOST (desktop)                    GUEST (celular)
     │                                 │
     ├──createOffer()                  │
     ├──setLocalDescription(offer)     │
     ├──── Firebase: /offer ──────────►│
     │                                 ├──setRemoteDescription(offer)
     │                                 ├──createAnswer()
     │                                 ├──setLocalDescription(answer)
     │◄─── Firebase: /answer ──────────┤
     ├──setRemoteDescription(answer)   │
     │                                 │
     ├──ICE candidates ──────────────►│
     │◄──ICE candidates ──────────────┤
     │                                 │
     ╔══════════════════════════════════╗
     ║    RTCDataChannel P2P aberto     ║
     ╚══════════════════════════════════╝
```

### Protocolo de mensagens (DataChannel)

```typescript
// Traços de desenho
{ type: 'stroke:start', id: string, tool: string, color: string, size: number, x: number, y: number }
{ type: 'stroke:move',  id: string, x: number, y: number }
{ type: 'stroke:end',   id: string }

// Controle
{ type: 'undo' }
{ type: 'clear' }

// Viewport (celular → desktop, ~30fps)
{ type: 'viewport', x: number, y: number, zoom: number, canvasW: number, canvasH: number }
```

### Mapeamento de coordenadas

O celular trabalha com **coordenadas do viewport** (o que está visível na tela).
Para enviar traços ao desktop, converte para **coordenadas do documento**:

```
docX = viewportX + canvasX / zoom
docY = viewportY + canvasY / zoom
```

O zoom do celular afeta apenas o **viewport** (indicador azul no desktop),
nunca o zoom do PDF no computador.

---

## Tecnologias utilizadas

| Tecnologia | Uso |
|-----------|-----|
| [PDF.js](https://mozilla.github.io/pdf.js/) | Renderização de PDF no canvas |
| [WebRTC](https://webrtc.org/) | Comunicação P2P em tempo real |
| [Firebase RTDB](https://firebase.google.com/docs/database) | Sinalização WebRTC |
| CSS Grid + Flexbox | Layout responsivo |
| Canvas API | Desenho e anotação |
| PWA (manifest.json) | Instalação no celular |

---

## Compatibilidade

| Navegador | Desktop | Mobile |
|-----------|---------|--------|
| Chrome 90+ | ✅ | ✅ |
| Firefox 90+ | ✅ | ✅ |
| Safari 15+ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ |

> WebRTC não funciona em conexões HTTP sem `localhost`.
> Use sempre HTTPS (GitHub Pages fornece automaticamente).

---

## Desenvolvimento local

Para testar localmente com HTTPS:

```bash
# Com Python
python3 -m http.server 8080
# Acesse: http://localhost:8080 (localhost é tratado como seguro)

# Com Node.js (npx serve)
npx serve . -p 8080

# Para HTTPS local (Chrome, Firefox)
npx local-ssl-proxy --source 8443 --target 8080
# Acesse: https://localhost:8443
```

Para testar sem Firebase, ative o modo demo em `js/firebase-config.js`:
```javascript
export const DEMO_MODE = true;
```
No modo demo, desktop e celular precisam estar na **mesma aba** (não funciona
entre dispositivos reais — apenas para desenvolvimento).

---

## Licença

MIT — Use, modifique e distribua livremente.
