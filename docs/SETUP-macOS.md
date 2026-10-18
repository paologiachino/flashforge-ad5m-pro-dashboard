# Configurazione completa su macOS

Questa guida descrive **tutto ciò che è stato installato e configurato** per progettare e
stampare con Claude su una Flashforge Adventurer 5M Pro, partendo da un Mac Apple Silicon
(macOS 26, Homebrew già presente). Ogni passo è stato eseguito e verificato.

Nei comandi, `~/Documents/3D/ai-3d-print` è la cartella del repository e
`~/Documents/3D/Modelli` la libreria dei modelli. Puoi scegliere percorsi diversi.

## Indice

1. [Architettura](#1-architettura)
2. [Programmi di base](#2-programmi-di-base)
3. [OpenSCAD e BOSL2](#3-openscad-e-bosl2)
4. [Repository e libreria dei modelli](#4-repository-e-libreria-dei-modelli)
5. [Skill di Claude](#5-skill-di-claude)
6. [Server MCP](#6-server-mcp)
7. [Stampante](#7-stampante)
8. [Dashboard](#8-dashboard)
9. [Camera](#9-camera)
10. [Come si usa](#10-come-si-usa)
11. [Aggiornare dal progetto originale](#11-aggiornare-dal-progetto-originale)
12. [Usarla con altre stampanti](#usarla-con-altre-stampanti)
13. [Problemi e soluzioni](#13-problemi-e-soluzioni)
14. [Sicurezza](#14-sicurezza)

---

## 1. Architettura

```
Claude (Claude Code / app desktop)
 ├── skill print3d ............ guida il flusso progetta → rivedi → slicing → stampa
 ├── MCP "openscad" ........... OpenSCAD (render, STL) + Flash Studio CLI (G-code)
 │                               + API LAN della stampante (porta 8898)
 ├── MCP "orcaslicer" ......... OrcaSlicer CLI: prove con parametri diversi, analisi G-code (facoltativo)
 └── MCP "blender" ............ Blender, per forme organiche e rendering (facoltativo)

Dashboard (Node 22, porta 3470 e 80)
 ├── legge la stampante (/detail) solo mentre qualcuno guarda
 ├── mostra la camera (MJPEG, porta 8080 della stampante)
 └── salva progetti e storico in SQLite dentro la libreria dei modelli

~/.print3d/printer.json ....... IP, seriale, check code e modello: letto da dashboard e MCP
```

Perché OpenSCAD: il modello è un file di testo, che Claude scrive direttamente. Il server
MCP lo trasforma in immagini PNG, così Claude *vede* il risultato e corregge gli errori
prima di arrivare alla stampante.

## 2. Programmi di base

```bash
brew install uv          # esegue i server MCP scritti in Python (blender, orcaslicer)
brew install node@22     # la dashboard richiede Node 22+ per node:sqlite
brew install gh          # facoltativo: per pubblicare su GitHub
```

`node@22` è *keg-only*: non sostituisce il Node già presente nel sistema. Si trova in
`/opt/homebrew/opt/node@22/bin/node`.

Applicazioni da installare a mano:

| App | Necessaria? | Note |
| --- | --- | --- |
| **Flash Studio** | Sì, per lo slicing | [flashforge.com](https://www.flashforge.com/pages/flash-studio-desktop). Contiene i profili ufficiali *Adventurer 5M Pro 0.25/0.4/0.6/0.8 Nozzle*. |
| **OrcaSlicer** | Facoltativa | Per il server MCP `orcaslicer`. Testata la versione 2.4.2. |
| **Blender** | Facoltativa | Per il server MCP `blender`. Testata la versione 5.2. |

Verifica che lo slicing da riga di comando funzioni:

```bash
P="/Applications/Flash Studio.app/Contents/Resources/profiles/Flashforge"
"/Applications/Flash Studio.app/Contents/MacOS/Flash Studio" \
  --load-settings "$P/machine/Flashforge Adventurer 5M Pro 0.4 Nozzle.json;$P/process/0.20mm Standard @Flashforge AD5M Pro 0.4 Nozzle.json" \
  --load-filaments "$P/filament/Flashforge Generic PLA.json" \
  --curr-bed-type "High Temp Plate" --slice 0 --outputdir /tmp/slicetest model.stl
```

> `--curr-bed-type "High Temp Plate"` è importante: senza, il CLI usa il piatto «Cool Plate»
> con temperature generiche (per esempio 35 °C per il PETG invece di 70 °C).

## 3. OpenSCAD e BOSL2

Serve una **versione di sviluppo** (snapshot): la stabile 2021.01 è troppo vecchia per BOSL2.

```bash
brew install --cask openscad@snapshot
openscad --version
git clone --depth 1 https://github.com/BelfrySCAD/BOSL2.git ~/Documents/OpenSCAD/libraries/BOSL2
```

Test:

```bash
echo 'include <BOSL2/std.scad>; cuboid([20,20,10], rounding=2);' > /tmp/t.scad
openscad -o /tmp/t.stl /tmp/t.scad     # deve riportare "Genus: 0"
```

## 4. Repository e libreria dei modelli

```bash
mkdir -p ~/Documents/3D/Modelli/projects
git clone https://github.com/paologiachino/flashforge-ad5m-pro-dashboard.git ~/Documents/3D/ai-3d-print
cp ~/Documents/3D/ai-3d-print/dashboard/config.example.macos.json \
   ~/Documents/3D/ai-3d-print/dashboard/config.json
```

In `dashboard/config.json` sostituisci `/Users/YOUR_USER/Documents/3D/Models` con la tua
libreria. Il file è escluso da git.

I modelli, gli STL, i G-code e il database **stanno nella libreria, non nel repository**.

## 5. Skill di Claude

Le skill sono istruzioni che Claude carica quando servono.

```bash
mkdir -p ~/.claude/skills
cp -R ~/Documents/3D/ai-3d-print/skills/print3d ~/Documents/3D/ai-3d-print/skills/print3d-setup ~/.claude/skills/
```

| Skill | Quando si attiva | Cosa fa |
| --- | --- | --- |
| `print3d` | «progetta…», «stampami…», «fammi un supporto…» | Chiede cosa vuoi, cerca online o modella con BOSL2, crea il progetto, ti fa approvare il modello in dashboard, chiede il filamento, fa lo slicing e stampa solo dopo il tuo consenso. |
| `print3d-setup` | «configura la stampa 3D», nuovo computer | Installa e verifica tutto il necessario. |

Adattamenti fatti per la 5M Pro:

- il modello si legge da Settings (`printer.json`) e determina il profilo di slicing;
- con la camera chiusa sono ammessi ABS e ASA, mentre per il PLA è consigliato aprire lo
  sportello o il coperchio;
- Claude risponde nella lingua dell'utente.

Dopo aver modificato le skill nel repository, ricopiale in `~/.claude/skills`.

## 6. Server MCP

I server si registrano a livello utente nel file `~/.claude.json`, nella chiave
`mcpServers`. Fai prima una copia di backup del file. Se hai la CLI `claude` puoi usare
`claude mcp add … --scope user` al posto della modifica manuale.

```json
{
  "mcpServers": {
    "openscad": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<utente>/Documents/3D/ai-3d-print/skills/print3d/scripts/openscad-mcp.mjs"],
      "env": {
        "SCAD_PROJECT_DIR": "/Users/<utente>/Documents/3D/Modelli",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    },
    "blender": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/uvx",
      "args": ["mcp-for-blender"],
      "env": { "DISABLE_TELEMETRY": "true" }
    },
    "orcaslicer": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/uvx",
      "args": ["--python", "3.12", "--with", "mcp<2", "orca-mcp"],
      "env": { "ORCASLICER_PATH": "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer" }
    }
  }
}
```

### `openscad` (indispensabile)

Su macOS trova da solo `openscad` di Homebrew e `/Applications/Flash Studio.app`. Per
percorsi diversi imposta `OPENSCAD_BIN`, `FLASHSTUDIO_BIN` e `FLASHSTUDIO_PROFILES`.
**Non** mettere IP, seriale o check code nelle variabili d'ambiente: stanno in
`printer.json`.

| Strumento | Funzione |
| --- | --- |
| `scad_render` · `scad_check` · `scad_export` | Anteprime PNG, validazione, STL con controllo «manifold» e del volume 220×220×220 mm. |
| `scad_slice` | G-code con Flash Studio. Usa il modello impostato in Settings. |
| `printer_discover` · `printer_status` · `printer_files` | Ricerca in rete, stato, file presenti sulla stampante. |
| `printer_print` · `printer_job` | Caricamento e avvio, pausa, ripresa e annullamento: **solo dopo la conferma dell'utente**. |
| `project_*` · `item_*` · `queue_*` · `print_history` | Progetti, revisioni, coda e storico (richiedono la dashboard attiva). |

### `orcaslicer` (facoltativo)

[orca-mcp](https://github.com/jeff-roche/orca-mcp) usa il CLI di OrcaSlicer. È utile per
provare più valori di un parametro (`parameter_sweep`) e per analizzare il G-code layer per
layer.

> **Attenzione:** la versione 0.1.0 non parte con la libreria `mcp` 2.x
> (`No module named 'mcp.server.fastmcp'`). Per questo negli argomenti c'è
> `--with "mcp<2"`, che la blocca alla versione 1.x.

### `blender` (facoltativo)

[mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) (ex `blender-mcp`):

```bash
uvx mcp-for-blender install-addon
# abilita l'add-on senza aprire l'interfaccia:
/Applications/Blender.app/Contents/MacOS/Blender -b --python-expr \
  "import bpy; bpy.ops.preferences.addon_enable(module='blender_mcp'); bpy.ops.wm.save_userpref()"
```

Ogni volta che vuoi usarlo, apri Blender, premi **N** nella vista 3D, apri la scheda **MCP**
e clicca **Start MCP Server**. La telemetria è disattivata con `DISABLE_TELEMETRY=true`.
Lo strumento `execute_blender_code` esegue codice Python dentro Blender.

### Verifica

I nuovi server MCP vengono caricati **solo nelle sessioni avviate dopo** la registrazione.
In una sessione nuova chiedi a Claude: *«elenca gli strumenti dei server openscad,
orcaslicer e blender»*.

## 7. Stampante

1. Sulla stampante: **Impostazioni → Rete → modalità LAN attiva**. Annota **IP, numero di
   serie e check code**.
2. Dal router, assegna alla stampante un **IP fisso** (prenotazione DHCP).
3. Avvia la dashboard (sezione 8), apri **Settings** dal browser del Mac:
   - **Find** cerca le stampanti sulla porta 8898 nella rete locale;
   - **Test connection** prova i valori senza salvarli;
   - **Save** scrive `~/.print3d/printer.json` con permessi `600`.

Porte usate dalla stampante: **8898** (API HTTP), **8899** (vecchio protocollo TCP),
**8080** (camera MJPEG).

## 8. Dashboard

### Avvio manuale

```bash
~/Documents/3D/ai-3d-print/dashboard/run-dashboard.sh
```

Lo script cerca da solo un Node ≥ 22.

### Avvio automatico al login

```bash
~/Documents/3D/ai-3d-print/macos/install-dashboard-agent.sh
```

Lo script crea `~/Library/LaunchAgents/com.print3d.dashboard.plist`. Il servizio riparte se
la dashboard si blocca e scrive i messaggi in `~/Library/Logs/print3d/dashboard.log`.

```bash
launchctl kickstart -k gui/$(id -u)/com.print3d.dashboard   # riavvia
launchctl bootout gui/$(id -u)/com.print3d.dashboard        # disattiva
```

> **Perché il servizio avvia Node direttamente e non uno script `sh`:** la protezione privacy
> di macOS impedisce a `/bin/sh`, avviato al login, di leggere `~/Documents`
> (`Operation not permitted`). L'installatore trova Node 22 e ne scrive il percorso nel file
> del servizio.

### Accesso

- dal Mac: `http://127.0.0.1:3470`
- dal telefono, sulla stessa rete: `http://<nome-del-mac>.local`. Il nome si legge con
  `scutil --get LocalHostName` o in *Impostazioni di Sistema → Generali → Condivisione*.
  Scrivi anche `http://`.

## 9. Camera

La 5M Pro trasmette un flusso MJPEG 640×480 da MJPG-Streamer su
`http://<ip-stampante>:8080/?action=stream`.

La dashboard:

- apre **un solo collegamento** verso la stampante e lo condivide tra tutti gli spettatori,
  perché MJPG-Streamer regge male più connessioni;
- si collega solo quando qualcuno preme **Show camera** e si scollega quando nessuno guarda
  o la scheda va in secondo piano;
- taglia i fotogrammi sui marcatori JPEG, così chi si collega a metà flusso parte sempre da
  un'immagine completa;
- offre **Photo** (`/api/camera/snapshot`) e **Fullscreen** (su iPhone apre il flusso in una
  scheda a parte).

L'indirizzo della camera si può cambiare in Settings, per esempio per una webcam esterna
sulla 5M base.

## 10. Come si usa

In una sessione nuova di Claude:

> «Progettami un gancio per la porta, spessore 4 mm, e stampalo in PETG»

1. Claude chiede se vuoi solo il progetto o anche la stampa, se cercare online e se vuoi
   rivedere il modello.
2. Crea il progetto in `~/Documents/3D/Modelli/projects/<nome>/` e scrive il file `.scad`.
3. Lo controlla con le anteprime e lo pubblica in dashboard → **Projects** per la tua
   revisione.
4. Tu premi **Approve** oppure **Revise** con una nota, anche dal telefono.
5. Claude chiede il filamento caricato, fa lo slicing con il profilo 5M Pro e riporta tempo
   e grammi.
6. Stampa **solo** se hai scelto la stampa. Se i pezzi sono più di uno, li mette in coda e
   aspetta che tu prema *Bed clear – release* tra un pezzo e l'altro.

## 11. Aggiornare dal progetto originale

```bash
cd ~/Documents/3D/ai-3d-print
git remote add upstream https://github.com/ethanj2k/ai-3d-print.git   # una volta sola
git fetch upstream
git rebase upstream/main          # oppure: git merge upstream/main
launchctl kickstart -k gui/$(id -u)/com.print3d.dashboard
```

Il ramo `local/camera` contiene solo la funzione camera, nella forma originale, per
riapplicarla facilmente su versioni future.

## Usarla con altre stampanti

| Stampante / situazione | Funziona? | Cosa configurare |
| --- | --- | --- |
| Adventurer 5M Pro, firmware originale | ✅ Testata (fw 5.1.9) | Settings: IP, seriale, check code, modello *Adventurer 5M Pro*. |
| Adventurer 5M, firmware originale | ✅ Stessa API (non testata qui) | Modello *Adventurer 5M*. **Camera disattivata**, a meno che non sia montata quella aggiuntiva (in quel caso imposta il suo URL). Solo PLA e PETG. |
| AD5X | ⚠️ Parziale, non testata | Stessa API: stato e storico dovrebbero funzionare. Lo slicing automatico non è supportato (profili diversi, multicolore). Camera solo se presente. |
| Firmware Klipper modificato (Moonraker/Mainsail) | ❌ | API diversa. |
| Più stampanti insieme | ⚠️ Un'istanza per stampante | Per ognuna: `DASH_PORT`, `PRINTER_CONFIG`, `PRINT_LIBRARY` diversi e `"listen80": false`. Il server MCP gestisce una stampante alla volta (`PRINTER_CONFIG`). |
| Ugello diverso da 0.4 | ✅ | Chiedi a Claude di usare `nozzle: "0.6"` (sono disponibili 0.25, 0.4, 0.6 e 0.8). |
| Linux | ✅ Con accorgimenti | `"listen80": false` (la porta 80 richiede root). Percorsi di OpenSCAD e Flash Studio tramite variabili d'ambiente. Al posto di LaunchAgent, un servizio systemd. |
| Windows | ✅ Progetto originale | `run-dashboard.cmd` e percorsi predefiniti di Windows. |

Altre impostazioni utili per ogni installazione:

- **Costo del filamento:** `filament` in `config.json` (peso bobina, prezzo, valuta).
- **Modifica di Settings dal telefono:** `"allowRemoteSettings": true`. Sconsigliato su reti
  non fidate.
- **Firmware:** l'API della stampante non è ufficiale e può cambiare. Se dopo un
  aggiornamento qualcosa smette di funzionare, *Test connection* mostra l'errore.

## 13. Problemi e soluzioni

| Sintomo | Causa | Soluzione |
| --- | --- | --- |
| *no answer: printer off or asleep?* / `EHOSTDOWN` | Stampante spenta, in standby o IP cambiato | Accendila. Usa **Find** e fissa l'IP dal router. |
| *refused: is LAN mode on?* | Modalità LAN disattivata | Attivala sulla stampante. |
| Il check code non viene accettato | Letto male, o cambiato sulla stampante | Rileggilo sulla stampante e salvalo di nuovo in Settings. |
| Il servizio non parte, `Operation not permitted` nel log | Protezione privacy di macOS | Usa `macos/install-dashboard-agent.sh`, che avvia Node direttamente. |
| `This dashboard needs Node 22` | Node troppo vecchio | `brew install node@22`. |
| `No module named 'mcp.server.fastmcp'` | orca-mcp con mcp 2.x | Aggiungi `--with "mcp<2"` agli argomenti di `uvx`. |
| Claude non vede gli strumenti MCP | Sessione aperta prima della registrazione | Apri una sessione nuova. |
| Blender non risponde | Server dell'add-on non avviato | Blender → N → MCP → *Start MCP Server*. |
| La camera non si vede | Camera disattivata in Settings, o 5M senza camera | Attivala o imposta l'URL corretto. |
| Il caricamento di file grandi fallisce | Limite dell'API Wi-Fi (circa 12 MB) | Usa la chiavetta USB. |

## 14. Sicurezza

- `printer.json` sta in `~/.print3d/` con permessi `600` ed è escluso da git.
  **Non pubblicarlo mai.**
- La dashboard **non rimanda mai il check code** al browser. Da altri dispositivi il seriale
  è mascherato e Settings è in sola lettura.
- La dashboard ascolta su tutta la rete locale (0.0.0.0): usala solo in reti fidate. Non
  ha autenticazione.
- I comandi che muovono la stampante (`printer_print`, `printer_job`) li usa solo Claude e
  la skill impone la conferma dell'utente.
- `mcp-for-blender` può eseguire codice Python arbitrario in Blender.
