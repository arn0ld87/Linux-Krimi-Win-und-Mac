const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class GameStore {
  constructor(directory) {
    this.directory = directory;
    this.fileURL = path.join(directory, "spielstand.json");
    this.isWriteProtected = false;
  }

  static defaultDirectory(app) {
    if (process.env.APP_STORE && process.env.APP_STORE.trim() !== "") {
      return path.resolve(process.env.APP_STORE);
    }
    return path.join(app.getPath("appData"), "StaffelZwei");
  }

  load() {
    if (!fs.existsSync(this.fileURL)) {
      return { status: "fresh" };
    }
    try {
      const raw = fs.readFileSync(this.fileURL, "utf8");
      const state = JSON.parse(raw);
      if (!state || typeof state !== "object" || typeof state.episodeID !== "number") {
        return { status: "corrupt", reason: "Ungültiges Spielstandsformat." };
      }
      return { status: "loaded", state };
    } catch (err) {
      return { status: "corrupt", reason: err.message || String(err) };
    }
  }

  protectFromOverwrite() {
    this.isWriteProtected = true;
  }

  liftWriteProtection() {
    this.isWriteProtected = false;
    if (!fs.existsSync(this.fileURL)) return null;
    return this.makeBackup();
  }

  save(state) {
    if (this.isWriteProtected) {
      throw new StoreError(
        "writeProtected",
        "Der Spielstand ist defekt und wird nicht automatisch überschrieben."
      );
    }
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const data = JSON.stringify(state, null, 2) + "\n";
      const tmp = path.join(this.directory, "spielstand.json.tmp");
      fs.writeFileSync(tmp, data, "utf8");
      fs.renameSync(tmp, this.fileURL);
      return this.fileURL;
    } catch (err) {
      throw new StoreError("saveFailed", `Speichern fehlgeschlagen: ${err.message}`);
    }
  }

  makeBackup() {
    const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    let target = path.join(this.directory, `spielstand.geloescht-${stamp}.json`);
    let counter = 1;
    while (fs.existsSync(target)) {
      target = path.join(this.directory, `spielstand.geloescht-${stamp}-${counter}.json`);
      counter += 1;
    }
    fs.copyFileSync(this.fileURL, target);
    return target;
  }

  diskPath() {
    return path.join(this.directory, "linux-x64.raw");
  }

  archiveDisk(onReset) {
    const disk = this.diskPath();
    if (!fs.existsSync(disk)) {
      return onReset();
    }
    const backup = path.join(this.directory, `linux-x64-backup-${crypto.randomUUID()}.raw`);
    fs.renameSync(disk, backup);
    try {
      return onReset();
    } catch (err) {
      try {
        fs.renameSync(backup, disk);
      } catch {}
      throw err;
    }
  }
}

module.exports = { GameStore, StoreError };
