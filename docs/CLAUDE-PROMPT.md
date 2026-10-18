# Prompt per Claude: installazione completa

Copia tutto il testo sotto la linea e incollalo in una **nuova sessione di Claude Code**
(app desktop, scheda Code, oppure terminale) su un Mac. Claude installerà e verificherà
l'intera catena descritta in [SETUP-macOS.md](SETUP-macOS.md), chiedendoti i dati della
stampante solo quando servono.

---

Sei il mio assistente per configurare un ambiente di progettazione e stampa 3D su questo
Mac. Lavora in italiano, un passo alla volta, verifica ogni passo prima di passare al
successivo e dimmi chiaramente cosa è fallito invece di andare avanti.

## Obiettivo

Poterti chiedere «progettami X e stampalo» e ottenere: modello OpenSCAD → anteprime →
revisione nella dashboard → slicing con i profili ufficiali Flashforge → stampa sulla mia
**Flashforge Adventurer 5M Pro** (oppure Adventurer 5M: chiedimi quale), dopo il mio
consenso.

## Riferimenti

- Repository: `https://github.com/<UTENTE>/<REPO>` (Flashforge Adventurer 5M Pro Dashboard).
  Leggi `README.md`, `docs/SETUP-macOS.md` e `skills/print3d-setup/SKILL.md` prima di
  iniziare: sono la fonte di verità.
- Cartella del repository: `~/Documents/3D/ai-3d-print`. Libreria dei modelli:
  `~/Documents/3D/Modelli`. Prima di creare le cartelle chiedimi se voglio percorsi diversi.

## Regole

1. **Controlla prima cosa c'è già** (`brew`, `node`, `uv`, `openscad`, app in
   `/Applications`, `~/.claude.json`, `~/.claude/skills`) e salta ciò che funziona già.
2. **Non mettere mai** IP, numero di serie o check code nel repository, nei commit o nelle
   variabili d'ambiente dei server MCP. Vanno solo in `~/.print3d/printer.json`, con
   permessi 600, preferibilmente tramite la pagina Settings della dashboard.
3. **Fai un backup** di `~/.claude.json` prima di modificarlo.
4. **Non avviare stampe**, non caricare file sulla stampante e non mandare comandi di
   pausa o annullamento durante l'installazione. Sulla stampante sono ammesse solo letture
   (`printer_status`, `printer_files`).
5. Le installazioni grafiche (Flash Studio, OrcaSlicer, Blender) le faccio io: dimmi cosa
   scaricare e da dove, poi verifica.
6. Leggi il codice dei server MCP di terze parti prima di registrarli e dimmi se noti
   qualcosa di sospetto.

## Passi

1. **Programmi di base:** `brew install uv node@22` e
   `brew install --cask openscad@snapshot`. Verifica con `openscad --version` e
   `/opt/homebrew/opt/node@22/bin/node --version`.
2. **BOSL2:** clona `https://github.com/BelfrySCAD/BOSL2` in
   `~/Documents/OpenSCAD/libraries/BOSL2`. Prova un `cuboid` con `rounding` ed esportalo in
   STL.
3. **Flash Studio:** verifica che esista
   `/Applications/Flash Studio.app/Contents/Resources/profiles/Flashforge/machine/Flashforge Adventurer 5M Pro 0.4 Nozzle.json`
   e fai uno slicing di prova da riga di comando con `--curr-bed-type "High Temp Plate"`.
4. **Repository:** clonalo, poi copia `dashboard/config.example.macos.json` in
   `dashboard/config.json` con i percorsi della mia libreria.
5. **Skill:** copia `skills/print3d` e `skills/print3d-setup` in `~/.claude/skills/`.
6. **Server MCP** in `~/.claude.json` → `mcpServers`, a livello utente:
   - `openscad`: `node <repo>/skills/print3d/scripts/openscad-mcp.mjs` con
     `SCAD_PROJECT_DIR=<libreria>` e un `PATH` che includa `/opt/homebrew/bin`;
   - facoltativo, chiedimelo: `orcaslicer` = `uvx --python 3.12 --with "mcp<2" orca-mcp`
     con `ORCASLICER_PATH`;
   - facoltativo, chiedimelo: `blender` = `uvx mcp-for-blender` con
     `DISABLE_TELEMETRY=true`, più `uvx mcp-for-blender install-addon` e l'attivazione
     dell'add-on.

   Verifica ogni server avviandolo e chiamando `initialize` e `tools/list` tramite stdio.
   Per `openscad` prova anche `scad_render`, `scad_export` e `scad_slice` su un cubo, poi
   cancella i file di prova.
7. **Dashboard:** esegui `macos/install-dashboard-agent.sh`, controlla che
   `http://127.0.0.1:3470/api/settings` risponda e che il servizio sia `running`.
8. **Stampante:** chiedimi di attivare la modalità LAN e di leggere **IP, numero di serie e
   check code** dallo schermo. Salvali con `POST /api/settings`, oppure dimmi di inserirli
   nella pagina Settings del browser, insieme al modello. Poi `POST /api/settings/test` e
   `printer_status` in sola lettura. Se la stampante non risponde, usa
   `/api/settings/discover`.
9. **Camera** (solo 5M Pro): verifica che `/api/camera/snapshot` restituisca un JPEG.
10. **Resoconto finale:** una tabella con ogni componente, lo stato (✅/❌) e come l'hai
    verificato. Aggiungi l'indirizzo della dashboard dal telefono
    (`http://<LocalHostName>.local`) e ricordami di aprire una **nuova sessione** per
    caricare gli strumenti MCP.

## Dopo l'installazione

Per progettare e stampare segui la skill `print3d`. Chiedimi sempre se voglio solo il
progetto o anche la stampa, quale filamento è caricato, e aspetta la mia approvazione in
dashboard prima di stampare.
