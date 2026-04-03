# 🔥 Firebase Setup — DigiCanvas

Guia completo para configurar o Firebase como servidor de sinalização WebRTC do DigiCanvas.

---

## Por que o Firebase?

O WebRTC é **peer-to-peer** — após a conexão, os dados trafegam direto entre os dispositivos.
Porém, para *iniciar* essa conexão, os dois lados precisam trocar mensagens de sinalização
(**offer**, **answer** e **ICE candidates**). O Firebase Realtime Database serve exatamente
como esse canal de sinalização temporário.

```
[Desktop]  ──offer──►  [Firebase RTDB]  ──offer──►  [Celular]
[Desktop]  ◄──answer──  [Firebase RTDB]  ◄──answer──  [Celular]
[Desktop] ←──────── WebRTC P2P ────────────────────► [Celular]
```

---

## Passo 1 — Criar projeto Firebase

1. Acesse [https://console.firebase.google.com](https://console.firebase.google.com)
2. Clique em **"Criar um projeto"**
3. Dê um nome (ex: `digicanvas-prod`)
4. Desative o Google Analytics (opcional para este uso)
5. Clique em **"Criar projeto"**

---

## Passo 2 — Habilitar Realtime Database

1. No menu lateral, clique em **Build → Realtime Database**
2. Clique em **"Criar banco de dados"**
3. Escolha a localização (ex: `us-central1` ou `southamerica-east1` para menor latência no Brasil)
4. Selecione **"Iniciar no modo de teste"** (ajustaremos as regras a seguir)
5. Clique em **"Habilitar"**

---

## Passo 3 — Configurar regras de segurança

No painel do Realtime Database, clique na aba **"Regras"** e substitua pelo JSON abaixo:

```json
{
  "rules": {
    "sessions": {
      "$code": {
        // Qualquer um pode criar/ler sessões (código de 6 dígitos como "chave")
        ".read": true,
        ".write": true,

        // Cada entrada expira após 1 hora (limpeza automática via TTL não existe
        // no RTDB gratuito — veja a seção "Limpeza automática" abaixo)
        "createdAt": {
          ".validate": "newData.isNumber()"
        },
        "offer": {
          ".validate": "newData.hasChildren(['type', 'sdp'])"
        },
        "answer": {
          ".validate": "newData.hasChildren(['type', 'sdp'])"
        },
        "hostICE": {
          "$id": {
            ".validate": "newData.hasChildren(['candidate', 'sdpMid', 'sdpMLineIndex'])"
          }
        },
        "guestICE": {
          "$id": {
            ".validate": "newData.hasChildren(['candidate', 'sdpMid', 'sdpMLineIndex'])"
          }
        }
      }
    }
  }
}
```

> **Nota de segurança:** As regras acima são abertas — qualquer pessoa com o código de 6 dígitos
> pode participar de uma sessão. Para produção, adicione autenticação Firebase e restrinja
> as regras ao UID do criador da sessão.

---

## Passo 4 — Registrar o app web

1. No console Firebase, clique no ícone `</>` (Web) para adicionar um app
2. Dê um apelido (ex: `DigiCanvas Web`)
3. **Não** habilite Firebase Hosting (usaremos GitHub Pages)
4. Clique em **"Registrar app"**
5. Copie o objeto `firebaseConfig` exibido

---

## Passo 5 — Atualizar firebase-config.js

Abra o arquivo `js/firebase-config.js` e substitua os valores:

```javascript
export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",          // ← cole aqui
  authDomain:        "SEU-PROJETO.firebaseapp.com",
  databaseURL:       "https://SEU-PROJETO-default-rtdb.firebaseio.com",
  projectId:         "SEU-PROJETO",
  storageBucket:     "SEU-PROJETO.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",
};

export const DEMO_MODE = false;  // ← mude para false
```

---

## Passo 6 — Configurar domínio autorizado (para GitHub Pages)

1. No Firebase Console → **Authentication → Settings → Authorized domains**
2. Adicione o domínio do seu GitHub Pages:
   ```
   SEU-USUARIO.github.io
   ```
3. Salve

> Isso é necessário para que o Firebase aceite requisições do seu domínio de produção.

---

## Passo 7 — Deploy no GitHub Pages

```bash
# Clone ou crie o repositório
git init
git add .
git commit -m "feat: DigiCanvas initial release"

# Suba para o GitHub
git remote add origin https://github.com/SEU-USUARIO/digicanvas.git
git push -u origin main

# No GitHub: Settings → Pages → Source: main branch / root
```

URLs finais:
- Desktop: `https://SEU-USUARIO.github.io/digicanvas/`
- Celular:  `https://SEU-USUARIO.github.io/digicanvas/celular.html`

---

## Limpeza automática de sessões

O Firebase RTDB gratuito não tem TTL automático. Para limpar sessões antigas:

### Opção A — Firebase Cloud Functions (requer plano Blaze)
```javascript
// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.cleanSessions = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    const db = admin.database();
    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h atrás
    const ref = db.ref('sessions');
    const snap = await ref.orderByChild('createdAt').endAt(cutoff).get();
    const deletions = [];
    snap.forEach(child => deletions.push(child.ref.remove()));
    await Promise.all(deletions);
    console.log(`Limpas ${deletions.length} sessões`);
  });
```

### Opção B — Limpeza no cliente (já implementada)
O código do DigiCanvas já chama `signaling.cleanup()` ao desconectar,
removendo a sessão do Firebase. Em casos de queda inesperada, as sessões
órfãs persistem mas são inofensivas.

---

## Estrutura de dados no Firebase

```
/sessions/
  ├── 482951/                    ← código de 6 dígitos
  │   ├── createdAt: 1706000000000
  │   ├── status: "waiting" | "connected"
  │   ├── offer:
  │   │   ├── type: "offer"
  │   │   └── sdp: "v=0\r\no=..."
  │   ├── answer:
  │   │   ├── type: "answer"
  │   │   └── sdp: "v=0\r\no=..."
  │   ├── hostICE/
  │   │   ├── -NxAbc123: { candidate, sdpMid, sdpMLineIndex }
  │   │   └── -NxDef456: { ... }
  │   └── guestICE/
  │       └── -NxGhi789: { ... }
  └── 738204/                    ← outra sessão ativa
      └── ...
```

---

## Custos estimados (plano Spark — gratuito)

| Recurso       | Limite gratuito | Uso típico DigiCanvas |
|---------------|-----------------|----------------------|
| Conexões sim. | 100             | 1 por sessão         |
| Downloads/mês | 10 GB           | ~5 KB por sessão     |
| Armazenamento | 1 GB            | ~2 KB por sessão     |

Para uso pessoal/pequena escala, **o plano gratuito é mais do que suficiente**.

---

## Alternativas ao Firebase

Se preferir não usar Firebase:

| Solução              | Prós                        | Contras                          |
|----------------------|-----------------------------|----------------------------------|
| **PeerJS**           | Simples, servidor gratuito  | Depende de servidor terceiro     |
| **Cloudflare Durable Objects** | Edge, rápido  | Requer conta Cloudflare          |
| **Socket.io + Render** | Flexível                | Requer backend próprio           |
| **WebSocket manual** | Controle total              | Requer servidor (não GitHub Pages) |

Para adaptar ao PeerJS, substitua `signaling.js` e `webrtc.js` pelo SDK do PeerJS.

---

## Troubleshooting

**"Sessão não encontrada"**
→ Verifique se o `databaseURL` no `firebase-config.js` está correto.
→ Verifique se as regras do RTDB permitem leitura.

**Conexão WebRTC falha após sinalização**
→ Redes corporativas bloqueiam UDP. Adicione servidores TURN:
```javascript
{ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
```

**CORS no GitHub Pages**
→ Firebase RTDB aceita origens `*.github.io` por padrão para o SDK JS.
→ Se usar a REST API, adicione o domínio nas configurações.

**"Firebase: No Firebase App"**
→ Certifique-se de que `DEMO_MODE = false` e que as credenciais são válidas.
