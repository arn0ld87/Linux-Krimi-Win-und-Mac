const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const DISK_SIZE = 256 * 1024 * 1024;

function findFreePort(start = 5910) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => {
      findFreePort(start + 1).then(resolve, reject);
    });
    srv.listen(start, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class LinuxGuest {
  constructor({ directory, episode, supportsDesktop, guestAssetsDir, qemuDir }) {
    this.directory = directory;
    this.episode = episode;
    this.supportsDesktop = supportsDesktop;
    this.guestAssetsDir = guestAssetsDir;
    this.qemuDir = qemuDir;

    this.proc = null;
    this.agentServer = null;
    this.agentPort = null;
    this.agentSocket = null;
    this.ready = false;
    this.bootFailure = null;
    this.bootLog = "";
    this.buffer = "";
    this.pending = null;
    this.vncPort = null;
    this.wsServer = null;
    this.wsPort = null;
    this.onTerminalEvent = null;
  }

  get diskPath() {
    return path.join(this.directory, "linux-x64.raw");
  }

  ensureDisk() {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(this.diskPath)) {
      const fd = fs.openSync(this.diskPath, "w", 0o600);
      try {
        fs.ftruncateSync(fd, DISK_SIZE);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      const stat = fs.lstatSync(this.diskPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== DISK_SIZE) {
        throw new Error("Die virtuelle Festplatte hat ein unerwartetes Format.");
      }
    }
  }

  resolveQemuBinary() {
    if (process.platform === "win32") {
      const exe = path.join(this.qemuDir, "qemu-system-x86_64.exe");
      if (!fs.existsSync(exe)) {
        throw new Error("qemu-system-x86_64.exe wurde im Programmverzeichnis nicht gefunden.");
      }
      return { bin: exe, shareDir: path.join(this.qemuDir, "share"), isWin: true };
    }
    return { bin: "qemu-system-x86_64", shareDir: null, isWin: false };
  }

  async startAgentServer() {
    if (this.agentServer) return;
    this.agentServer = net.createServer((socket) => {
      if (this.agentSocket && !this.agentSocket.destroyed) {
        this.agentSocket.destroy();
      }
      this.agentSocket = socket;
      socket.on("data", (chunk) => this.receiveStdout(chunk));
      socket.on("error", (err) => {
        if (!this.ready) this.bootFailure = err.message;
      });
      socket.on("close", () => {
        if (this.agentSocket === socket) this.agentSocket = null;
      });
    });
    await new Promise((resolve, reject) => {
      this.agentServer.once("error", reject);
      this.agentServer.listen(0, "127.0.0.1", () => {
        this.agentPort = this.agentServer.address().port;
        resolve();
      });
    });
  }

  async startVncBridge() {
    if (!this.supportsDesktop || this.wsServer) return;
    this.vncPort = await findFreePort(5910);
    this.wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => this.wsServer.once("listening", resolve));
    this.wsPort = this.wsServer.address().port;

    this.wsServer.on("connection", (ws) => {
      const tcp = net.createConnection({ host: "127.0.0.1", port: this.vncPort });
      tcp.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk);
        }
      });
      tcp.on("error", () => {
        try { ws.close(); } catch {}
      });
      tcp.on("close", () => {
        try { ws.close(); } catch {}
      });
      ws.on("message", (msg) => {
        const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        if (!tcp.destroyed) tcp.write(buf);
      });
      ws.on("close", () => {
        tcp.destroy();
      });
      ws.on("error", () => {
        tcp.destroy();
      });
    });
  }

  async spawnQemu(accel, cpuModel) {
    const { bin, shareDir, isWin } = this.resolveQemuBinary();
    const kernel = path.join(this.guestAssetsDir, "vmlinuz");
    const initrd = path.join(this.guestAssetsDir, "initramfs.cpio.gz");
    if (!fs.existsSync(kernel) || !fs.existsSync(initrd)) {
      throw new Error("Das x86_64-Alpine-Linux-Abbild wurde nicht gefunden.");
    }

    const args = [];
    if (shareDir && fs.existsSync(shareDir)) {
      args.push("-L", shareDir);
    }
    args.push("-machine", `pc,accel=${accel}`);
    args.push("-cpu", cpuModel);
    args.push("-smp", "2");
    args.push("-m", "1280M");
    args.push("-net", "none");
    args.push("-no-reboot");
    args.push("-kernel", kernel);
    args.push("-initrd", initrd);
    args.push("-append", "console=ttyS0 quiet loglevel=3 panic=-1");
    args.push("-serial", "none");
    const escapedDisk = this.diskPath.replace(/,/g, ",,");
    args.push("-drive", `file=${escapedDisk},format=raw,if=virtio,cache=writeback`);
    args.push("-device", "virtio-serial-pci");
    args.push("-chardev", `socket,id=staffel0,host=127.0.0.1,port=${this.agentPort}`);
    args.push("-device", "virtconsole,chardev=staffel0");

    if (this.supportsDesktop && this.vncPort !== null) {
      const displayNum = this.vncPort - 5900;
      args.push("-device", "virtio-vga");
      args.push("-device", "qemu-xhci");
      args.push("-device", "usb-kbd");
      args.push("-device", "usb-tablet");
      args.push("-vnc", `127.0.0.1:${displayNum}`);
    } else {
      args.push("-display", "none");
    }

    const env = { ...process.env };
    if (isWin) {
      env.PATH = `${this.qemuDir};${env.PATH || ""}`;
    }

    this.ready = false;
    this.bootFailure = null;
    this.bootLog = "";
    this.buffer = "";

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    this.proc = child;

    const appendLog = (chunk) => {
      const text = chunk.toString("utf8");
      this.bootLog += text;
      if (this.bootLog.length > 4000) {
        this.bootLog = this.bootLog.slice(-4000);
      }
    };
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.on("exit", (code, signal) => {
      if (this.proc !== child) return;
      const reason = `Linux-VM wurde beendet (${code ?? signal}). ${this.bootLog.trim()}`.trim();
      this.bootFailure = reason;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.ready = false;
    });
    child.on("error", (err) => {
      if (this.proc !== child) return;
      this.bootFailure = err.message;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(err);
      }
    });

    const deadline = Date.now() + 35000;
    while (!this.ready && !this.bootFailure && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.ready) {
      const msg = this.bootFailure || `Linux antwortet beim Start nicht. ${this.bootLog}`;
      await this.killProc();
      throw new Error(msg);
    }
  }

  async connect(cwd, seed) {
    if (this.ready) {
      return this.exchange({ command: "", cwd, seed: null });
    }
    this.ensureDisk();
    await this.startAgentServer();
    await this.startVncBridge();

    const preferredAccel =
      process.platform === "win32" ? "whpx" : process.platform === "darwin" ? "hvf" : "kvm";
    try {
      await this.spawnQemu(preferredAccel, "max");
    } catch {
      try {
        await this.spawnQemu("tcg", "qemu64,+ssse3,+sse4.1,+sse4.2");
      } catch (err) {
        await this.stop();
        throw err;
      }
    }

    try {
      return await this.exchange({ command: "", cwd, seed });
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async run(command, cwd) {
    if (!this.ready) throw new Error("Linux ist noch nicht bereit.");
    return this.exchange({ command, cwd, seed: null });
  }

  async answer(answer, step, cwd) {
    return this.exchange({ command: "", cwd, seed: null, step, answer });
  }

  async desktop(action, cwd) {
    return this.exchange({ command: "", cwd, seed: null, desktop: action });
  }

  async openTerminal(cwd, size, maintenance) {
    await this.exchange({
      command: "",
      cwd,
      seed: null,
      terminal: maintenance ? "maintenance" : "start",
      terminalSize: size,
    });
  }

  sendTerminal(bytes) {
    if (!this.ready || !this.agentSocket?.writable) return;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const chunkSize = 16 * 1024;
    for (let i = 0; i < buf.length; i += chunkSize) {
      const slice = buf.subarray(i, Math.min(i + chunkSize, buf.length));
      this.sendTerminalEvent("input", slice.toString("base64"), null);
    }
  }

  resizeTerminal(size) {
    this.sendTerminalEvent("resize", null, size);
  }

  sendTerminalEvent(action, terminalBytesBase64, terminalSize) {
    if (!this.ready || !this.agentSocket?.writable) return;
    const req = {
      id: crypto.randomUUID(),
      command: "",
      cwd: "",
      seed: null,
      episode: this.episode,
      step: null,
      answer: null,
      desktop: null,
      terminal: action,
      terminalBytes: terminalBytesBase64,
      terminalSize,
    };
    try {
      this.agentSocket.write(JSON.stringify(req) + "\n");
    } catch {}
  }

  exchange({
    command,
    cwd,
    seed = null,
    step = null,
    answer = null,
    desktop = null,
    terminal = null,
    terminalSize = null,
  }) {
    if (this.pending || !this.agentSocket?.writable) {
      return Promise.reject(new Error("Das Linux-Terminal ist belegt."));
    }
    const id = crypto.randomUUID();
    const payload =
      JSON.stringify({
        id,
        command,
        cwd,
        seed,
        episode: this.episode,
        step,
        answer,
        desktop,
        terminal,
        terminalBytes: null,
        terminalSize,
      }) + "\n";

    return new Promise((resolve, reject) => {
      const timeoutMs = seed !== null ? 35000 : 18000;
      const timer = setTimeout(() => {
        if (this.pending && this.pending.id === id) {
          this.pending = null;
          reject(new Error("Zeitlimit beim Warten auf Linux."));
        }
      }, timeoutMs);

      this.pending = { id, resolve, reject, timer };
      try {
        this.agentSocket.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      }
    });
  }

  receiveStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        this.bootLog += line + "\n";
        continue;
      }

      if (reply.ready) {
        this.ready = true;
        continue;
      }
      if (!this.ready && reply.error) {
        this.bootFailure = reply.error;
        continue;
      }
      if (
        reply.terminalOutput !== undefined ||
        reply.terminalPrompt ||
        reply.terminalClosed ||
        reply.terminalDesktop
      ) {
        if (this.onTerminalEvent) {
          this.onTerminalEvent(reply);
        }
        continue;
      }
      if (this.pending && reply.id && reply.id.toLowerCase() === this.pending.id.toLowerCase()) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        if (reply.error) {
          p.reject(new Error(reply.error));
        } else {
          p.resolve(reply);
        }
      }
    }
  }

  async killProc() {
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new Error("Linux-VM wurde gestoppt."));
    }
    if (this.agentSocket) {
      try {
        this.agentSocket.destroy();
      } catch {}
      this.agentSocket = null;
    }
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  async stop() {
    await this.killProc();
    if (this.agentServer) {
      try {
        this.agentServer.close();
      } catch {}
      this.agentServer = null;
      this.agentPort = null;
    }
    if (this.wsServer) {
      try {
        for (const client of this.wsServer.clients) {
          client.close();
        }
        this.wsServer.close();
      } catch {}
      this.wsServer = null;
      this.wsPort = null;
    }
    this.vncPort = null;
  }
}

module.exports = { LinuxGuest };
