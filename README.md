# Flashforge Adventurer 5M Pro Dashboard

*A LAN dashboard and AI toolchain (Claude + MCP + OpenSCAD) to design, review, slice and
print on a FlashForge Adventurer 5M / 5M Pro. Documentation in Italian.*

Dashboard web locale e catena di strumenti per **progettare oggetti parlando con Claude**,
rivederli in 3D, fare lo slicing con i profili ufficiali Flashforge e stamparli su una
**Flashforge Adventurer 5M Pro** (funziona anche con l'Adventurer 5M).

Il progetto è un fork di [ethanj2k/ai-3d-print](https://github.com/ethanj2k/ai-3d-print)
(licenza MIT), adattato e testato su **macOS** con una 5M Pro. Il README originale è in
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

> «Progettami un supporto per telefono e stampalo in PLA»
>
> — Solo progetto, o progetto e stampa?
> — Cerco prima un modello esistente online, o lo modello da zero?
> — Vuoi rivedere il modello prima della stampa?

---

## Cosa contiene

| Componente | A cosa serve |
| --- | --- |
| `dashboard/` | Pagina web locale per stato della stampante, **camera live**, revisione dei modelli in 3D, coda di stampa, storico e **Settings**. |
| `skills/print3d/scripts/openscad-mcp.mjs` | Server MCP senza dipendenze (Node 18+): rendering OpenSCAD, esportazione STL, slicing con Flash Studio, comandi alla stampante, progetti e coda. |
| `skills/print3d` | Skill per Claude: il flusso «richiesta → modello → revisione → slicing → stampa». |
| `skills/print3d-setup` | Skill per Claude: installa e configura tutto su un nuovo computer. |
| `macos/` | Avvio automatico della dashboard al login (LaunchAgent). |
| `docs/SETUP-macOS.md` | **Guida dettagliata** di tutto ciò che è stato configurato. |
| `docs/CLAUDE-PROMPT.md` | **Prompt pronto** da dare a Claude per rifare l'installazione su un altro Mac. |

## Novità rispetto al progetto originale

- **Settings nella dashboard.** Indirizzo IP, numero di serie, check code, modello e
  camera si configurano dal browser, con i pulsanti *Find* (cerca la stampante in rete) e
  *Test connection*. I dati vengono salvati in `~/.print3d/printer.json` con permessi `600`,
  **fuori dal repository**. Il check code non viene mai rimandato al browser e le
  impostazioni si possono modificare solo dal computer che esegue la dashboard.
- **Camera live (5M Pro).** Il pulsante *Show camera* mostra il flusso MJPEG della stampante,
  con *Photo* e *Fullscreen*. La dashboard apre **un solo collegamento** verso la stampante,
  lo condivide con tutti gli spettatori e lo chiude quando nessuno guarda o la scheda va in
  secondo piano.
- **Più modelli.** Il nome del modello viene riconosciuto dalla stampante (5M, 5M Pro, AD5X)
  oppure impostato in Settings. Il server MCP usa il modello salvato per scegliere il
  profilo di slicing corretto.
- **Parte anche senza configurazione.** Al primo avvio la dashboard non si chiude più per
  mancanza di dati: mostra un invito ad aprire Settings.
- **macOS pronto all'uso.** Percorsi predefiniti per OpenSCAD (Homebrew) e Flash Studio,
  `run-dashboard.sh` e installatore del LaunchAgent.
- **Skill aggiornate** per 5M Pro (ABS/ASA in camera chiusa, scelta automatica del profilo).

## Avvio rapido (macOS)

```bash
brew install uv node@22 gh
brew install --cask openscad@snapshot
git clone https://github.com/paologiachino/flashforge-ad5m-pro-dashboard.git ~/Documents/3D/ai-3d-print
git clone --depth 1 https://github.com/BelfrySCAD/BOSL2.git ~/Documents/OpenSCAD/libraries/BOSL2
cp ~/Documents/3D/ai-3d-print/dashboard/config.example.macos.json ~/Documents/3D/ai-3d-print/dashboard/config.json
# modifica config.json: sostituisci YOUR_USER e scegli la cartella dei modelli
~/Documents/3D/ai-3d-print/macos/install-dashboard-agent.sh
open http://127.0.0.1:3470    # → Settings: IP, seriale, check code → Test → Save
```

Poi installa **Flash Studio** da [flashforge.com](https://www.flashforge.com/pages/flash-studio-desktop),
copia le skill e registra i server MCP: tutto è spiegato passo per passo in
[docs/SETUP-macOS.md](docs/SETUP-macOS.md). In alternativa apri Claude Code e incolla il
contenuto di [docs/CLAUDE-PROMPT.md](docs/CLAUDE-PROMPT.md).

## Sulla stampante

*Impostazioni → Rete → attiva la **modalità LAN***. Lo schermo mostra **indirizzo IP,
numero di serie e check code**: inseriscili nella pagina **Settings** della dashboard.
Conviene assegnare alla stampante un IP fisso dal router.

## La dashboard

| Scheda | Contenuto |
| --- | --- |
| **Print** | Stato, temperature, avanzamento layer per layer, anteprima del percorso utensile, camera. |
| **Projects** | Progetti e pezzi, con il modello STL da ruotare in 3D e i pulsanti *Approve* / *Revise*. |
| **Queue** | Coda di stampa: nessun pezzo parte finché non premi *Bed clear – release*. |
| **History** | Stampe fatte, durata, filamento e costo. |
| **Settings** | Collegamento alla stampante, modello e camera. |

La dashboard **comanda solo in lettura**: non avvia, non mette in pausa e non annulla
stampe. Quei comandi li esegue Claude tramite il server MCP, dopo la tua conferma.

È raggiungibile da `http://127.0.0.1:3470` e, dagli altri dispositivi della stessa rete,
da `http://<nome-del-mac>.local` (porta 80) o `http://<ip-del-mac>:3470`.

### Configurazione (`dashboard/config.json`)

| Chiave | Predefinito | Significato |
| --- | --- | --- |
| `library` | `../library` | Cartella dei tuoi modelli (fuori dal repo). |
| `projectsRoot` | `<library>/projects` | Una sottocartella per progetto. |
| `gcodeDirs` | `[library]` | Dove cercare i G-code per l'anteprima. |
| `port` | `3470` | Porta principale. |
| `listen80` | `true` | Ascolta anche sulla porta 80. Su Linux richiede root: mettilo a `false`. |
| `allowRemoteSettings` | `false` | Permette di modificare Settings da altri dispositivi della rete. |
| `pollMs` | `2000` | Intervallo di lettura della stampante con l'aggiornamento automatico attivo. |
| `filament` | 1100 g, 20 $ | Peso e costo della bobina, per stimare il costo delle stampe. |

### Dati della stampante (`~/.print3d/printer.json`)

Normalmente lo scrive la pagina Settings. Formato (vedi `printer.example.json`):

```json
{ "ip": "192.168.1.50", "serial": "SN…", "checkCode": "…", "model": "Adventurer 5M Pro", "camera": true }
```

Le variabili d'ambiente `PRINTER_IP`, `PRINTER_SERIAL`, `PRINTER_CHECKCODE` e
`PRINTER_CONFIG` hanno la precedenza sul file. Settings lo segnala quando sono impostate.

## API della dashboard

| Metodo | Percorso | Note |
| --- | --- | --- |
| GET | `/api/status` · `/api/events` | Stato (anche in streaming SSE). |
| GET | `/api/camera/stream` | Flusso MJPEG condiviso. |
| GET | `/api/camera/snapshot` | Immagine JPEG singola. |
| GET | `/api/settings` | Impostazioni, **senza** check code. |
| POST | `/api/settings` | Salva. Solo da localhost, salvo `allowRemoteSettings`. |
| POST | `/api/settings/test` | Prova la connessione con i valori del modulo. |
| POST | `/api/settings/discover` | Cerca stampanti sulla porta 8898 nella rete locale. |

## Usarla con altre stampanti

Vedi la sezione dedicata in [docs/SETUP-macOS.md](docs/SETUP-macOS.md#usarla-con-altre-stampanti).
In breve:

- **Adventurer 5M Pro con firmware originale:** testata. **Adventurer 5M:** stessa API, non
  testata qui. Imposta in Settings IP, seriale, check code e modello. Sulla 5M base
  disattiva la camera, se non hai il modulo aggiuntivo.
- **AD5X:** stessa API, non testata. Stato e storico dovrebbero funzionare, lo slicing
  automatico invece non è supportato, perché i profili sono diversi.
- **Firmware Klipper modificato (Moonraker):** non supportato, l'API è diversa.
- **Più stampanti insieme:** non supportato. Serve un'istanza della dashboard per stampante,
  con porta, `printer.json` (`PRINTER_CONFIG`) e libreria separati.

## Limiti noti

- L'API della stampante non è documentata ufficialmente e può cambiare tra versioni del
  firmware. Testata con il firmware 5.1.9 della 5M Pro.
- I caricamenti via Wi-Fi oltre circa 12 MB possono fallire: per i lavori grandi usa la
  chiavetta USB.
- Il flusso della camera è 640×480 MJPEG. Si vede solo dalla rete locale.

## Licenza

MIT. Copyright © 2026 Ethan Johnson (progetto originale) e collaboratori di questo fork.
Vedi [LICENSE](LICENSE).
