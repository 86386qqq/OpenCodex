const { app, BrowserWindow, Menu, clipboard, ipcMain, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = process.env.OPENCODEX_HOST || "127.0.0.1";
const DEFAULT_PORT = normalizePort(process.env.OPENCODEX_PORT);

let mainWindow = null;
let statusTimer = null;
let isQuitting = false;

const gatewayState = {
  child: null,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT || 0,
  listenUrl: "",
  localUrl: "",
  primaryUrl: "",
  lanUrls: [],
  token: crypto.randomBytes(32).toString("hex"),
  paths: null,
  settings: null,
  status: null,
  lastError: "",
  startedAt: null,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(line) {
  if (!gatewayState.paths || !gatewayState.paths.logPath) return;
  try {
    fs.appendFileSync(gatewayState.paths.logPath, line);
  } catch {}
}

function runtimePaths() {
  const userDataDir = app.getPath("userData");
  const runtimeDir = path.join(userDataDir, "runtime");
  const reportsDir = path.join(runtimeDir, "reports");
  const cacheDir = path.join(runtimeDir, "cache");
  const logsDir = path.join(userDataDir, "logs");
  const officialBundleDir = path.join(cacheDir, "codex-official-bundle");

  return {
    userDataDir,
    runtimeDir,
    reportsDir,
    cacheDir,
    logsDir,
    officialBundleDir,
    configPath: path.join(runtimeDir, "config.yaml"),
    settingsPath: path.join(userDataDir, "launcher-settings.json"),
    logPath: path.join(logsDir, "gateway.log"),
    gatewayScriptPath: path.join(APP_ROOT, "gateway", "dist", "server.js"),
  };
}

function ensureRuntimeLayout(paths) {
  ensureDir(paths.runtimeDir);
  ensureDir(paths.reportsDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.officialBundleDir);
}

function normalizeHostMode(value) {
  return value === "lan" ? "lan" : "local";
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function defaultSettings() {
  return {
    hostMode: DEFAULT_HOST === "0.0.0.0" ? "lan" : "local",
    port: DEFAULT_PORT,
  };
}

function loadLauncherSettings(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsPath, "utf8"));
    return {
      ...defaultSettings(),
      ...parsed,
      hostMode: normalizeHostMode(parsed.hostMode),
      port: normalizePort(parsed.port),
    };
  } catch {
    return defaultSettings();
  }
}

function saveLauncherSettings(paths, settings) {
  const nextSettings = {
    ...defaultSettings(),
    ...settings,
    hostMode: normalizeHostMode(settings && settings.hostMode),
    port: normalizePort(settings && settings.port),
  };
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  return nextSettings;
}

function hostForMode(hostMode) {
  return normalizeHostMode(hostMode) === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function readAuthEnabled(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const match = raw.match(/^\s*password\s*:\s*(.*)$/m);
    if (!match) return false;
    return !!parseYamlStringScalar(match[1]).trim();
  } catch {
    return false;
  }
}

function writeAuthConfig(paths, password) {
  const value = String(password || "").trim();
  const stored = value ? `sha256-v1:${sha256Hex(value)}` : "";
  fs.writeFileSync(paths.configPath, `auth:\n  password: ${JSON.stringify(stored)}\n`, "utf8");
}

function lanUrlsForPort(port) {
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4" || !entry.address) continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return Array.from(new Set(urls));
}

function updateGatewayUrls() {
  gatewayState.listenUrl = gatewayState.host ? `http://${gatewayState.host}:${gatewayState.port}` : "";
  gatewayState.localUrl = gatewayState.port ? `http://127.0.0.1:${gatewayState.port}` : "";
  gatewayState.lanUrls = gatewayState.host === "0.0.0.0" ? lanUrlsForPort(gatewayState.port) : [];
  gatewayState.primaryUrl =
    gatewayState.host === "0.0.0.0" && gatewayState.lanUrls.length > 0
      ? gatewayState.lanUrls[0]
      : gatewayState.localUrl || gatewayState.listenUrl;
}

function findFreePort(startPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };
    tryPort(startPort);
  });
}

async function findRandomFreePort(host) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 30000);
    try {
      return await findFreePort(candidate, host);
    } catch {}
  }
  return findFreePort(3737, host);
}

async function ensurePortSetting(paths, settings) {
  const port = normalizePort(settings && settings.port);
  if (port) return settings;
  const host = hostForMode(settings && settings.hostMode);
  return saveLauncherSettings(paths, {
    ...settings,
    port: await findRandomFreePort(host),
  });
}

function buildState() {
  return {
    running: !!gatewayState.child && !gatewayState.child.killed,
    pid: gatewayState.child ? gatewayState.child.pid : null,
    host: gatewayState.host,
    port: gatewayState.port,
    url: gatewayState.primaryUrl,
    urls: {
      primary: gatewayState.primaryUrl,
      local: gatewayState.localUrl,
      listen: gatewayState.listenUrl,
      lan: gatewayState.lanUrls,
    },
    paths: gatewayState.paths,
    settings: gatewayState.settings || defaultSettings(),
    auth: {
      enabled: gatewayState.paths ? readAuthEnabled(gatewayState.paths.configPath) : false,
    },
    status: gatewayState.status,
    lastError: gatewayState.lastError,
    startedAt: gatewayState.startedAt,
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("launcher:state", buildState());
}

async function fetchGatewayStatus() {
  if (!gatewayState.localUrl) return null;
  const response = await fetch(`${gatewayState.localUrl}/api/launcher/status`, {
    headers: {
      "x-opencodex-launcher-token": gatewayState.token,
    },
  });
  if (!response.ok) {
    throw new Error(`gateway status failed: HTTP ${response.status}`);
  }
  return response.json();
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    try {
      gatewayState.status = await fetchGatewayStatus();
      gatewayState.lastError = "";
    } catch (error) {
      gatewayState.lastError = error instanceof Error ? error.message : String(error);
    }
    broadcastState();
  }, 1500);
  if (statusTimer.unref) statusTimer.unref();
}

async function startGateway() {
  if (gatewayState.child) return buildState();

  const paths = runtimePaths();
  gatewayState.paths = paths;
  ensureRuntimeLayout(paths);
  gatewayState.settings = await ensurePortSetting(paths, loadLauncherSettings(paths));
  gatewayState.host = hostForMode(gatewayState.settings.hostMode);

  if (!fs.existsSync(paths.gatewayScriptPath)) {
    gatewayState.lastError = `Missing gateway build: ${paths.gatewayScriptPath}`;
    broadcastState();
    return buildState();
  }

  gatewayState.port = await findFreePort(gatewayState.settings.port, gatewayState.host);
  updateGatewayUrls();
  gatewayState.status = null;
  gatewayState.lastError = "";
  gatewayState.startedAt = new Date().toISOString();

  appendLog(`\n[launcher] starting gateway ${gatewayState.listenUrl} at ${gatewayState.startedAt}\n`);

  const child = spawn(process.execPath, [paths.gatewayScriptPath], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: gatewayState.host,
      PORT: String(gatewayState.port),
      CODEX_WEB_RUNTIME_DIR: paths.runtimeDir,
      CODEX_WEB_CONFIG_PATH: paths.configPath,
      CODEX_WEB_REPORTS_DIR: paths.reportsDir,
      CODEX_WEB_OFFICIAL_BUNDLE_DIR: paths.officialBundleDir,
      CODEX_WEB_GATEWAY_BASE_URL: gatewayState.primaryUrl,
      CODEX_WEB_LAUNCHER_TOKEN: gatewayState.token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  gatewayState.child = child;

  child.stdout.on("data", (chunk) => appendLog(`[gateway] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => appendLog(`[gateway:err] ${chunk.toString()}`));
  child.on("error", (error) => {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] gateway spawn error: ${gatewayState.lastError}\n`);
    broadcastState();
  });
  child.on("exit", (code, signal) => {
    appendLog(`[launcher] gateway exited: code=${code} signal=${signal}\n`);
    gatewayState.child = null;
    gatewayState.status = null;
    if (!isQuitting) {
      gatewayState.lastError = `gateway exited: code=${code} signal=${signal}`;
    }
    broadcastState();
  });

  startStatusPolling();
  broadcastState();
  return buildState();
}

function stopGateway() {
  return new Promise((resolve) => {
    const child = gatewayState.child;
    if (!child) {
      resolve(buildState());
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(buildState());
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(buildState());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve(buildState());
    }
  });
}

async function restartGateway() {
  await stopGateway();
  gatewayState.child = null;
  return startGateway();
}

function createWindow() {
  // Windows/Linux 默认会显示 Electron 应用菜单；启动器不需要菜单栏，创建窗口前统一关闭。
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: "OpenCodex",
    backgroundColor: "#f7f6f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function revealPath(targetPath) {
  if (!targetPath) return false;
  if (!fs.existsSync(targetPath)) return false;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    shell.openPath(targetPath);
  } else {
    shell.showItemInFolder(targetPath);
  }
  return true;
}

ipcMain.handle("launcher:get-state", () => buildState());
ipcMain.handle("launcher:start", () => startGateway());
ipcMain.handle("launcher:restart", () => restartGateway());
ipcMain.handle("launcher:open-url", () => {
  if (gatewayState.primaryUrl) shell.openExternal(gatewayState.primaryUrl);
  return buildState();
});
ipcMain.handle("launcher:open-logs", () => {
  if (gatewayState.paths) revealPath(gatewayState.paths.logPath);
  return buildState();
});
ipcMain.handle("launcher:reveal-path", (_event, targetPath) => revealPath(targetPath));
ipcMain.handle("launcher:copy", (_event, value) => {
  clipboard.writeText(String(value || ""));
  return true;
});
ipcMain.handle("launcher:update-host-mode", async (_event, hostMode) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    hostMode: normalizeHostMode(hostMode),
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-port", async (_event, port) => {
  const nextPort = normalizePort(port);
  if (!nextPort) {
    gatewayState.lastError = "端口必须是 1 到 65535 之间的整数";
    broadcastState();
    return buildState();
  }
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    port: nextPort,
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-password", async (_event, password) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  writeAuthConfig(paths, password);
  return restartGateway();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    createWindow();
    await startGateway();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (statusTimer) clearInterval(statusTimer);
    if (gatewayState.child) {
      try {
        gatewayState.child.kill("SIGTERM");
      } catch {}
    }
  });
}
