const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { GameStore } = require("./gameStore");
const { GameEngine, MissionCatalog } = require("./gameEngine");
const { LinuxGuest } = require("./linuxGuest");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function resolvePaths() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      resourcesDir: path.join(res, "Resources"),
      missionsJson: path.join(res, "Resources", "Missions.json"),
      guestAssetsDir: path.join(res, "LinuxGuest"),
      qemuDir: path.join(res, "qemu"),
    };
  }
  const repoRoot = path.resolve(__dirname, "..", "..");
  const cacheBase = process.env.NACHTDIFF_CACHE || "/tmp/nachtdiff-win-cache";
  return {
    resourcesDir: path.join(repoRoot, "Resources"),
    missionsJson: path.join(repoRoot, "Sources", "StaffelCore", "Resources", "Missions.json"),
    guestAssetsDir: path.join(cacheBase, "linux-guest-x64"),
    qemuDir: path.join(cacheBase, "qemu-w64"),
  };
}

class AppController {
  constructor() {
    this.paths = resolvePaths();
    this.catalog = new MissionCatalog(this.paths.missionsJson);
    this.campaignDir = GameStore.defaultDirectory(app);

    const selFile = path.join(this.campaignDir, "aktive-episode.txt");
    let episodeID = 0;
    try {
      const parsed = parseInt(fs.readFileSync(selFile, "utf8").trim(), 10);
      if (!Number.isNaN(parsed)) episodeID = parsed;
    } catch {}

    const episode = this.catalog.episode(episodeID);
    const loaded = this.loadEpisodeStore(episode);
    this.store = loaded.store;
    this.engine = loaded.engine;
    this.loadWarning = loaded.warning;
    this.statusMessage = null;
    this.appearance = "system";

    this.linuxConnected = false;
    this.linuxMessage = "Linux bereit zum Start";
    this.terminalBusy = false;
    this.interactiveShellOpen = false;
    this.maintenanceShell = false;
    this.terminalPromptCount = 0;
    this.terminalSize = { rows: 24, cols: 80 };
    this.desktopReady = false;
    this.desktopMessage = null;
    this.vncPort = null;
    this.terminalRefreshTimer = null;

    this.guest = this.createGuest(episode.id);
    this.window = null;
  }

  createGuest(episodeID) {
    return new LinuxGuest({
      directory: this.store.directory,
      episode: episodeID,
      supportsDesktop: this.catalog.supportsDesktop(episodeID),
      guestAssetsDir: this.paths.guestAssetsDir,
      qemuDir: this.paths.qemuDir,
    });
  }

  episodeStore(episode) {
    if (episode.id === 0) return new GameStore(this.campaignDir);
    return new GameStore(path.join(this.campaignDir, "episoden", String(episode.id)));
  }

  loadEpisodeStore(episode) {
    const store = this.episodeStore(episode);
    const result = store.load();
    if (result.status === "corrupt") {
      store.protectFromOverwrite();
      return {
        store,
        engine: new GameEngine(this.catalog, GameEngine.freshState(this.catalog, episode.id)),
        warning: `Der Spielstand konnte nicht gelesen werden. Grund: ${result.reason}`,
      };
    }
    if (result.status === "loaded") {
      if (result.state.episodeID === episode.id) {
        const eng = new GameEngine(this.catalog, result.state);
        eng.refreshProgress();
        return { store, engine: eng, warning: null };
      }
      store.protectFromOverwrite();
      return {
        store,
        engine: new GameEngine(this.catalog, GameEngine.freshState(this.catalog, episode.id)),
        warning: "Der Spielstand gehört zu einer anderen Episode.",
      };
    }
    return {
      store,
      engine: new GameEngine(this.catalog, GameEngine.freshState(this.catalog, episode.id)),
      warning: null,
    };
  }

  snapshot() {
    const ep = this.engine.episode;
    const mission = this.engine.mission;
    return {
      episodes: this.catalog.episodes,
      episode: ep,
      mission,
      supportsDesktop: this.catalog.supportsDesktop(ep.id),
      state: this.engine.state,
      completedTracks: this.engine.completedTracksCount(),
      storePath: this.store.directory,
      loadWarning: this.loadWarning,
      statusMessage: this.statusMessage,
      appearance: this.appearance,
      linuxConnected: this.linuxConnected,
      linuxMessage: this.linuxMessage,
      terminalBusy: this.terminalBusy,
      interactiveShellOpen: this.interactiveShellOpen,
      maintenanceShell: this.maintenanceShell,
      desktopReady: this.desktopReady,
      desktopMessage: this.desktopMessage,
      vncWsPort: this.desktopReady ? this.guest.wsPort : null,
    };
  }

  emitState() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("state:changed", this.snapshot());
    }
  }

  persist() {
    try {
      this.store.save(this.engine.state);
      this.statusMessage = null;
    } catch (err) {
      if (err.code === "writeProtected") {
        this.statusMessage =
          "Der defekte Spielstand wird nicht überschrieben. Bestätige „Zurücksetzen“, um neu zu beginnen.";
      } else {
        this.statusMessage = `Speichern fehlgeschlagen: ${err.message}`;
      }
    }
  }

  setPage(page) {
    if (page === "desktop" && !this.catalog.supportsDesktop(this.engine.episode.id)) return;
    const leftDesktop = this.engine.state.page === "desktop" && page !== "desktop";
    this.engine.state.page = page;
    this.persist();
    this.emitState();
    this.rebuildMenu();
    if (leftDesktop) {
      this.refreshGuest();
    }
  }

  setAppearance(pref) {
    this.appearance = pref;
    nativeTheme.themeSource = pref;
    this.emitState();
  }

  async selectEpisode(episodeID) {
    const episode = this.catalog.episode(episodeID);
    if (!episode.playable || this.terminalBusy) return;
    if (episode.id === this.engine.state.episodeID) {
      this.setPage("briefing");
      return;
    }
    this.terminalBusy = true;
    this.emitState();
    try {
      await this.guest.stop();
      this.resetTerminalState();
      this.linuxConnected = false;
      this.desktopReady = false;
      this.desktopMessage = null;
      this.linuxMessage = "Linux bereit zum Start";

      const loaded = this.loadEpisodeStore(episode);
      fs.mkdirSync(this.campaignDir, { recursive: true });
      fs.writeFileSync(path.join(this.campaignDir, "aktive-episode.txt"), String(episode.id), "utf8");
      this.store = loaded.store;
      this.engine = loaded.engine;
      this.guest = this.createGuest(episode.id);
      this.loadWarning = loaded.warning;
      this.engine.state.page = "briefing";
      this.persist();
      this.rebuildMenu();
    } catch (err) {
      this.statusMessage = `Episodenwechsel fehlgeschlagen: ${err.message}`;
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  resetTerminalState() {
    if (this.terminalRefreshTimer) {
      clearTimeout(this.terminalRefreshTimer);
      this.terminalRefreshTimer = null;
    }
    this.interactiveShellOpen = false;
    this.maintenanceShell = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("terminal:reset");
    }
  }

  async connectLinux() {
    if (this.linuxConnected) return;
    this.linuxMessage = "Alpine Linux startet …";
    this.emitState();
    const reply = await this.guest.connect(this.engine.state.cwd, this.engine.linuxSeed);
    this.applyLinux(reply);
    this.linuxConnected = true;
    this.linuxMessage = "Alpine Linux · x86_64 · Offline";
  }

  applyLinux(reply) {
    if (reply && reply.cwd && reply.files) {
      this.engine.syncLinux(reply.cwd, reply.files, reply.checks || []);
    }
  }

  async reportLinuxError(err) {
    try {
      await this.guest.stop();
    } catch {}
    this.resetTerminalState();
    this.linuxConnected = false;
    this.desktopReady = false;
    this.desktopMessage = null;
    this.linuxMessage = `Linux: ${err.message || String(err)}`;
  }

  async startLinux() {
    if (this.linuxConnected || this.terminalBusy) return;
    this.terminalBusy = true;
    this.emitState();
    try {
      await this.connectLinux();
      this.persist();
    } catch (err) {
      await this.reportLinuxError(err);
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  async openInteractiveTerminal(maintenance = false) {
    while (this.terminalBusy) {
      await new Promise((r) => setTimeout(r, 35));
    }
    if (this.engine.state.page !== "terminal") return;
    if (this.interactiveShellOpen && this.maintenanceShell === maintenance) return;

    this.terminalBusy = true;
    this.emitState();
    try {
      await this.connectLinux();
      this.guest.onTerminalEvent = (event) => this.receiveTerminalEvent(event);
      this.interactiveShellOpen = true;
      this.maintenanceShell = maintenance;
      await this.guest.openTerminal(this.engine.state.cwd, this.terminalSize, maintenance);
      this.guest.resizeTerminal(this.terminalSize);
      this.persist();
    } catch (err) {
      await this.reportLinuxError(err);
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  receiveTerminalEvent(event) {
    if (event.terminalOutput && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("terminal:output", event.terminalOutput);
    }
    if (event.terminalDesktop && this.catalog.supportsDesktop(this.engine.episode.id)) {
      if (this.engine.state.page === "terminal") {
        this.setPage("desktop");
      }
    }
    if (event.terminalPrompt) {
      this.terminalPromptCount += 1;
      if (this.terminalRefreshTimer) clearTimeout(this.terminalRefreshTimer);
      this.terminalRefreshTimer = setTimeout(() => {
        if (!this.terminalBusy) this.refreshGuest();
      }, 80);
    }
    if (event.terminalClosed) {
      this.interactiveShellOpen = false;
      this.maintenanceShell = false;
      this.emitState();
      if (this.engine.state.page === "terminal") {
        this.openInteractiveTerminal(false);
      }
    }
  }

  async refreshGuest() {
    if (!this.linuxConnected || this.terminalBusy) return;
    this.terminalBusy = true;
    this.emitState();
    try {
      const reply = await this.guest.run("", this.engine.state.cwd);
      this.applyLinux(reply);
      this.persist();
    } catch (err) {
      await this.reportLinuxError(err);
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  async submitAnswer(value, step) {
    const answer = (value || "").trim();
    if (this.terminalBusy || !answer || Buffer.byteLength(answer, "utf8") > 200) {
      return "Gib eine kurze Antwort ein und warte auf Linux.";
    }
    this.terminalBusy = true;
    this.emitState();
    try {
      await this.connectLinux();
      const reply = await this.guest.answer(answer, step, this.engine.state.cwd);
      this.applyLinux(reply);
      if (reply.accepted) {
        this.engine.markAnswer(step);
        this.persist();
        return null;
      }
      this.persist();
      return "Die Antwort stimmt noch nicht. Prüfe die Quelle und das Format.";
    } catch (err) {
      await this.reportLinuxError(err);
      return this.linuxMessage;
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  async useDesktop(action) {
    if (!this.catalog.supportsDesktop(this.engine.episode.id) || this.terminalBusy) return;
    this.terminalBusy = true;
    this.desktopMessage = null;
    this.emitState();
    try {
      await this.connectLinux();
      if (!this.desktopReady) {
        this.applyLinux(await this.guest.desktop("start", this.engine.state.cwd));
        this.desktopReady = true;
        const initial = this.engine.mission?.desktop?.initialApp;
        if (action === "start" && initial) {
          this.applyLinux(await this.guest.desktop(initial, this.engine.state.cwd));
        }
      }
      if (action !== "start") {
        this.applyLinux(await this.guest.desktop(action, this.engine.state.cwd));
      }
      this.persist();
    } catch (err) {
      this.desktopMessage = err.message || String(err);
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  submitAccusation() {
    const res = this.engine.evaluateAccusation(
      this.engine.state.selectedSuspectID,
      this.engine.state.selectedEvidenceIDs
    );
    this.engine.state.lastAccusationFeedback = res.message;
    if (res.outcome === "accepted") {
      this.engine.state.solved = true;
      this.engine.state.page = "briefing";
    }
    this.persist();
    this.emitState();
    return res;
  }

  async submitFinale() {
    if (this.engine.episode.id !== 7 || this.terminalBusy) {
      return { outcome: "missingEvidence", message: "Warte auf Linux." };
    }
    this.terminalBusy = true;
    this.emitState();
    try {
      await this.connectLinux();
      this.applyLinux(await this.guest.run("", this.engine.state.cwd));
      this.engine.state.selectedSuspectID = "timo";
      this.terminalBusy = false;
      return this.submitAccusation();
    } catch (err) {
      await this.reportLinuxError(err);
      this.engine.state.lastAccusationFeedback = this.linuxMessage;
      this.persist();
      this.terminalBusy = false;
      this.emitState();
      return { outcome: "missingEvidence", message: this.linuxMessage };
    }
  }

  async resetProgress() {
    if (this.terminalBusy) return;
    this.terminalBusy = true;
    this.emitState();
    try {
      await this.guest.stop();
      this.resetTerminalState();
      this.linuxConnected = false;
      this.desktopReady = false;
      this.desktopMessage = null;
      this.linuxMessage = "Linux bereit zum Start";

      const fresh = new GameEngine(
        this.catalog,
        GameEngine.freshState(this.catalog, this.engine.episode.id)
      );
      this.store.archiveDisk(() => {
        this.store.liftWriteProtection();
        this.store.save(fresh.state);
      });
      this.engine = fresh;
      this.loadWarning = null;
      this.statusMessage = "Spielstand zurückgesetzt.";
    } catch (err) {
      this.statusMessage = `Zurücksetzen fehlgeschlagen: ${err.message}`;
    } finally {
      this.terminalBusy = false;
      this.emitState();
    }
  }

  rebuildMenu() {
    const supportsDesktop = this.catalog.supportsDesktop(this.engine.episode.id);
    const isFinale = this.engine.episode.id === 7;
    const template = [
      {
        label: "Datei",
        submenu: [
          {
            label: "Einstellungen…",
            accelerator: "CmdOrCtrl+,",
            click: () => this.window?.webContents.send("ui:open-settings"),
          },
          { type: "separator" },
          { role: "quit", label: "Beenden" },
        ],
      },
      {
        label: "Bearbeiten",
        submenu: [
          { role: "copy", label: "Kopieren" },
          { role: "paste", label: "Einfügen" },
          { role: "selectAll", label: "Alles auswählen" },
        ],
      },
      {
        label: "Fall",
        submenu: [
          { label: "Einsatzrahmen", accelerator: "CmdOrCtrl+1", click: () => this.setPage("briefing") },
          { label: "Terminal", accelerator: "CmdOrCtrl+2", click: () => this.setPage("terminal") },
          { label: "Aktenwand", accelerator: "CmdOrCtrl+3", click: () => this.setPage("aktenwand") },
          {
            label: isFinale ? "Übergabe" : "Vorwurf",
            accelerator: "CmdOrCtrl+4",
            click: () => this.setPage("vorwurf"),
          },
          { label: "Hilfe & Werkzeuge", accelerator: "CmdOrCtrl+5", click: () => this.setPage("help") },
          ...(supportsDesktop
            ? [{ label: "Linux-Bildschirm", accelerator: "CmdOrCtrl+6", click: () => this.setPage("desktop") }]
            : []),
          { type: "separator" },
          {
            label: isFinale ? "Übergabe abgeben" : "Vorwurf prüfen",
            accelerator: "CmdOrCtrl+Return",
            click: () => {
              if (this.engine.state.page !== "vorwurf" || this.terminalBusy) return;
              if (isFinale) this.submitFinale();
              else this.submitAccusation();
            },
          },
          {
            label: "Wartungs-Shell (Root)…",
            accelerator: "CmdOrCtrl+Alt+Shift+R",
            click: () => {
              if (this.engine.state.page === "terminal" && this.interactiveShellOpen && !this.maintenanceShell) {
                this.window?.webContents.send("ui:request-maintenance");
              }
            },
          },
        ],
      },
      {
        label: "Ansicht",
        submenu: [
          { role: "toggleDevTools", label: "Entwicklerwerkzeuge" },
          { role: "togglefullscreen", label: "Vollbild" },
        ],
      },
      {
        label: "Hilfe",
        submenu: [{ label: "Hilfe & Werkzeuge öffnen", click: () => this.setPage("help") }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  getAssetUrls() {
    const resUrl = pathToFileURL(this.paths.resourcesDir).href.replace(/\/$/, "");
    const hasWebmTrailer = fs.existsSync(path.join(this.paths.resourcesDir, "StaffelZwei-Trailer.webm"));
    const hasTrailerVtt = fs.existsSync(path.join(this.paths.resourcesDir, "StaffelZwei-Trailer.vtt"));
    return {
      resourcesBase: resUrl,
      trailer: `${resUrl}/${hasWebmTrailer ? "StaffelZwei-Trailer.webm" : "StaffelZwei-Trailer.mp4"}`,
      trailerVtt: hasTrailerVtt ? `${resUrl}/StaffelZwei-Trailer.vtt` : null,
      videoExt: hasWebmTrailer ? "webm" : "mp4",
      einsatzBase: `${resUrl}/Einsatzszene`,
      finaleBase: `${resUrl}/Einsatzszene/finale`,
    };
  }
}

let controller = null;

function createWindow() {
  controller = new AppController();
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1000,
    minHeight: 700,
    title: "NACHTDIFF",
    backgroundColor: "#141615",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  controller.window = win;
  controller.rebuildMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (process.env.NACHTDIFF_UI_SMOKE === "1") {
    const errors = [];
    win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
      if (level >= 3) errors.push(`console(${level}): ${message}`);
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      errors.push(`renderer gone: ${details.reason}`);
    });
    win.webContents.once("did-finish-load", async () => {
      try {
        for (let i = 0; i < 40; i++) {
          const ready = await win.webContents.executeJavaScript(`document.querySelectorAll(".episode-btn").length`);
          if (ready > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const res = await win.webContents.executeJavaScript(`(async () => {
          const out = {};
          out.episodes = document.querySelectorAll(".episode-btn").length;
          out.title = document.querySelector(".page-title")?.textContent;
          const imgs = Array.from(document.querySelectorAll(".stage-card img"));
          out.stageImagesLoaded = imgs.length >= 3 && imgs.every(i => i.complete && i.naturalWidth > 0);
          document.querySelectorAll(".nav-item").forEach(b => {
            if (b.textContent.includes("Aktenwand")) b.click();
          });
          await new Promise(r => setTimeout(r, 150));
          out.aktenwandTitle = document.querySelector(".page-title")?.textContent;
          document.querySelectorAll(".nav-item").forEach(b => {
            if (b.textContent.includes("Vorwurf")) b.click();
          });
          await new Promise(r => setTimeout(r, 150));
          out.vorwurfTitle = document.querySelector(".page-title")?.textContent;
          out.suspects = document.querySelectorAll(".suspect-row").length;
          document.querySelectorAll(".nav-item").forEach(b => {
            if (b.textContent.includes("Hilfe")) b.click();
          });
          await new Promise(r => setTimeout(r, 150));
          out.helpTitle = document.querySelector(".page-title")?.textContent;
          document.querySelectorAll(".episode-btn")[1].click();
          await new Promise(r => setTimeout(r, 300));
          out.ep1Title = document.querySelector(".page-title")?.textContent;
          const roomBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("3D-Serverraum"));
          roomBtn?.click();
          await new Promise(r => setTimeout(r, 250));
          const canvas = document.querySelector(".room3d-canvas");
          out.room3dMounted = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
          document.querySelector(".modal-header button")?.click();
          await new Promise(r => setTimeout(r, 100));
          document.getElementById("btn-open-settings")?.click();
          await new Promise(r => setTimeout(r, 150));
          out.settingsOpen = Boolean(document.querySelector(".modal-header")?.textContent.includes("Einstellungen"));
          document.querySelector(".modal-header button")?.click();
          return out;
        })()`);
        if (res.episodes !== 8) throw new Error(`Expected 8 episodes, got ${res.episodes}`);
        if (!res.stageImagesLoaded) throw new Error("Stage images failed to load");
        if (res.aktenwandTitle !== "Aktenwand") throw new Error(`Unexpected aktenwand: ${res.aktenwandTitle}`);
        if (res.vorwurfTitle !== "Vorwurf erheben" || res.suspects !== 3) {
          throw new Error(`Unexpected vorwurf: ${JSON.stringify(res)}`);
        }
        if (res.helpTitle !== "Hilfe & Werkzeuge") throw new Error(`Unexpected help: ${res.helpTitle}`);
        if (res.ep1Title !== "Episode 1 · Zu viele Rechte") throw new Error(`Unexpected ep1: ${res.ep1Title}`);
        if (!res.room3dMounted) throw new Error("3D Serverraum canvas failed to mount");
        if (!res.settingsOpen) throw new Error("Settings modal failed to open");
        if (errors.length > 0) throw new Error(errors.join("; "));
        console.log("UI SMOKE PASS:", JSON.stringify(res));
        app.exit(0);
      } catch (err) {
        console.error("UI SMOKE FAIL:", err.stack || err.message);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  ipcMain.handle("app:get-state", () => controller.snapshot());
  ipcMain.handle("app:set-page", (_e, page) => controller.setPage(page));
  ipcMain.handle("app:select-episode", (_e, id) => controller.selectEpisode(id));
  ipcMain.handle("app:set-appearance", (_e, pref) => controller.setAppearance(pref));
  ipcMain.handle("linux:start", () => controller.startLinux());
  ipcMain.handle("linux:open-terminal", (_e, maint) => controller.openInteractiveTerminal(Boolean(maint)));
  ipcMain.on("linux:terminal-input", (_e, b64) => {
    if (controller.interactiveShellOpen) {
      controller.guest.sendTerminal(Buffer.from(b64, "base64"));
    }
  });
  ipcMain.on("linux:terminal-resize", (_e, size) => {
    if (!size) return;
    const next = { rows: size.rows || 24, cols: size.cols || 80 };
    if (next.rows !== controller.terminalSize.rows || next.cols !== controller.terminalSize.cols) {
      controller.terminalSize = next;
      if (controller.interactiveShellOpen) controller.guest.resizeTerminal(next);
    }
  });
  ipcMain.handle("linux:refresh", () => controller.refreshGuest());
  ipcMain.handle("linux:submit-answer", (_e, val, step) => controller.submitAnswer(val, step));
  ipcMain.handle("linux:desktop", (_e, action) => controller.useDesktop(action));
  ipcMain.handle("app:set-suspect", (_e, id) => {
    controller.engine.state.selectedSuspectID = id;
    controller.persist();
    controller.emitState();
  });
  ipcMain.handle("app:toggle-evidence", (_e, id) => {
    const list = new Set(controller.engine.state.selectedEvidenceIDs || []);
    if (list.has(id)) list.delete(id);
    else list.add(id);
    controller.engine.state.selectedEvidenceIDs = Array.from(list);
    controller.persist();
    controller.emitState();
  });
  ipcMain.handle("app:submit-accusation", () => controller.submitAccusation());
  ipcMain.handle("app:submit-finale", () => controller.submitFinale());
  ipcMain.handle("app:reset-progress", () => controller.resetProgress());
  ipcMain.handle("app:copy-text", (_e, text) => {
    clipboard.writeText(text || "");
  });
  ipcMain.handle("app:get-assets", () => controller.getAssetUrls());

  createWindow();
});

app.on("before-quit", async (event) => {
  if (controller?.guest?.proc) {
    event.preventDefault();
    await controller.guest.stop();
    app.exit(0);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
