const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const asar = require("@electron/asar");

const RUNNER_APP_NAME = "OpenCodex Gateway.app";
const RUNNER_EXECUTABLE_NAME = "Codex";
const RUNNER_BUNDLE_IDENTIFIER = "dev.opencodex.gateway.officialruntime";

function logLine(logger, message) {
  if (typeof logger === "function") logger(`[launcher] ${message}\n`);
}

function expandHome(rawPath) {
  const value = String(rawPath || "");
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function withPhysicalAsarAccess(read) {
  /**
   * Electron 会把任意 *.asar 路径挂成虚拟目录。这里要探测的是官方 Codex.app 里的物理 app.asar 文件，
   * 所以 stat/read 这类文件系统访问必须临时关闭 asar 虚拟化；普通 Node 下设置 noAsar 也兼容。
   */
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return read();
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function realpathSafe(filePath) {
  try {
    return withPhysicalAsarAccess(() =>
      fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath)
    );
  } catch {
    return path.resolve(filePath);
  }
}

function statSummary(filePath) {
  try {
    const stat = withPhysicalAsarAccess(() => fs.statSync(filePath));
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      realpath: realpathSafe(filePath),
    };
  } catch (error) {
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      isSymbolicLink: false,
      errorCode: error && error.code ? String(error.code) : "",
      errorMessage: error instanceof Error ? error.message : String(error || ""),
      realpath: realpathSafe(filePath),
    };
  }
}

function logJsonLine(logger, message, value) {
  if (typeof logger !== "function") return;
  let json = "";
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value || "");
  }
  logLine(logger, `${message} ${json}`);
}

function isFile(filePath) {
  try {
    return withPhysicalAsarAccess(() => fs.statSync(filePath).isFile());
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return withPhysicalAsarAccess(() => fs.statSync(filePath).isDirectory());
  } catch {
    return false;
  }
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map(String)));
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileFingerprint(filePath) {
  try {
    const stat = withPhysicalAsarAccess(() => fs.statSync(filePath));
    return {
      path: realpathSafe(filePath),
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function defaultCodexAppCandidates() {
  if (process.platform === "darwin") {
    return ["/Applications/Codex.app", path.join(os.homedir(), "Applications", "Codex.app")];
  }
  return [];
}

function manifestCodexAppCandidates(officialBundleDir) {
  const manifest = readJsonIfPresent(path.join(officialBundleDir || "", "manifest.json"));
  if (!manifest) return [];
  return uniqueNonEmpty([manifest.sourceAppPath, manifest.sourceResourcesPath, manifest.sourceAsarPath]);
}

function codexAppCandidates({ officialBundleDir }) {
  // 优先复用官方 bundle 缓存里已经解析过的来源路径；没有缓存时再走环境变量和系统默认安装位。
  return uniqueNonEmpty([
    process.env.CODEX_DESKTOP_APP_PATH,
    ...manifestCodexAppCandidates(officialBundleDir),
    ...defaultCodexAppCandidates(),
  ]).map((candidate) => path.resolve(expandHome(candidate)));
}

function inferAppRootFromResources(resourcesDir) {
  if (path.basename(resourcesDir) === "Resources" && path.basename(path.dirname(resourcesDir)) === "Contents") {
    return path.dirname(path.dirname(resourcesDir));
  }
  if (path.basename(resourcesDir).toLowerCase() === "resources") return path.dirname(resourcesDir);
  return null;
}

function inferAppRootFromCandidate(rawCandidate) {
  const candidate = realpathSafe(rawCandidate);
  if (isFile(candidate) && path.basename(candidate) === "app.asar") {
    return inferAppRootFromResources(path.dirname(candidate));
  }
  if (!isDirectory(candidate)) return null;
  if (path.basename(candidate).endsWith(".app")) return candidate;
  if (isFile(path.join(candidate, "app.asar"))) return inferAppRootFromResources(candidate);
  if (isFile(path.join(candidate, "Contents", "Resources", "app.asar"))) return candidate;
  if (isFile(path.join(candidate, "Resources", "app.asar"))) return path.dirname(candidate);
  return null;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readBundleExecutable(appRoot) {
  const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
  try {
    const text = fs.readFileSync(infoPlistPath, "utf8");
    const match = text.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return decodeXmlText(match[1]);
  } catch {}
  if (process.platform === "darwin" && isFile("/usr/bin/plutil")) {
    try {
      /**
       * Codex.app 的 Info.plist 可能是二进制 plist。直接读 XML 正则不一定可靠，
       * 这里用系统 plutil 兜底读取 CFBundleExecutable，避免未来官方包结构变化时误判可执行文件路径。
       */
      const output = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlistPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output) return output;
    } catch {}
  }
  return path.basename(appRoot, ".app") || RUNNER_EXECUTABLE_NAME;
}

function officialRuntimeLayoutFromAppRoot(appRoot, logger = null) {
  const resourcesDir = path.join(appRoot, "Contents", "Resources");
  const frameworksDir = path.join(appRoot, "Contents", "Frameworks");
  const asarPath = path.join(resourcesDir, "app.asar");
  const executablePath = path.join(appRoot, "Contents", "MacOS", readBundleExecutable(appRoot));
  const asar = statSummary(asarPath);
  const frameworks = statSummary(frameworksDir);
  const executable = statSummary(executablePath);
  if (!asar.isFile || !frameworks.isDirectory || !executable.isFile) {
    logJsonLine(logger, "official Electron candidate layout rejected:", {
      appRoot,
      resourcesDir,
      asarPath,
      frameworksDir,
      executablePath,
      asar,
      frameworks,
      executable,
    });
    return null;
  }
  return {
    appRoot,
    resourcesDir,
    frameworksDir,
    asarPath,
    executablePath,
  };
}

function findOfficialRuntimeLayout({ officialBundleDir, logger }) {
  const tried = [];
  for (const candidate of codexAppCandidates({ officialBundleDir })) {
    tried.push(candidate);
    const candidateStat = statSummary(candidate);
    const appRoot = inferAppRootFromCandidate(candidate);
    // dist 内只看到“找不到运行时”不够排障；这里记录每个候选路径的真实 stat 结果和推断出的 appRoot。
    logJsonLine(logger, "official Electron candidate probed:", {
      candidate,
      candidateStat,
      inferredAppRoot: appRoot || "",
    });
    if (!appRoot) continue;
    const layout = officialRuntimeLayoutFromAppRoot(appRoot, logger);
    if (layout) return layout;
  }
  throw new Error(`未找到可复用的官方 Codex Electron 运行时。已尝试：${tried.join(", ")}`);
}

function escapePlistString(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runnerInfoPlist() {
  /**
   * runner 是后台 gateway 进程，不应该在 Dock 里出现第二个图标。
   * LSUIElement 会让当前官方 Electron runtime 在 ChromeMain 阶段 SIGTRAP；
   * LSBackgroundOnly 可以让进程成为真正的后台进程，同时仍能创建隐藏 webContents 承接官方 IPC。
   * 因此 agent 模式下不要再触碰 app.dock / activationPolicy，避免和系统级后台身份互相冲突。
   */
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${escapePlistString(RUNNER_EXECUTABLE_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlistString(RUNNER_BUNDLE_IDENTIFIER)}</string>
  <key>CFBundleName</key>
  <string>OpenCodex Gateway</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>AtomApplication</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
`;
}

function gatewayRunnerMainSource() {
  return `// 这个 asar 壳只负责把官方 Electron 运行时切到 OpenCodex gateway 入口。
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const entry = process.env.OPENCODEX_GATEWAY_ENTRY;
const gatewayAgentMode = process.env.OPENCODEX_GATEWAY_AGENT_MODE === "1";

if (!entry) {
  throw new Error("Missing OPENCODEX_GATEWAY_ENTRY for OpenCodex gateway runtime runner");
}

function hideGatewayDockIcon() {
  if (process.platform !== "darwin") return;
  if (gatewayAgentMode) return;
  try {
    // runner 是后台 IPC 宿主，禁止作为前台 App 激活，避免 Dock / Cmd+Tab 出现第二个图标。
    if (typeof app.setActivationPolicy === "function") app.setActivationPolicy("prohibited");
  } catch {}
  try {
    if (app.dock && typeof app.dock.hide === "function") app.dock.hide();
  } catch {}
  try {
    if (typeof app.hide === "function") app.hide();
  } catch {}
}

function installDockVisibilityGuard() {
  if (process.platform !== "darwin" || app.__opencodexDockVisibilityGuardInstalled) return;
  if (gatewayAgentMode) return;
  app.__opencodexDockVisibilityGuardInstalled = true;
  if (app.dock && typeof app.dock.show === "function") {
    const originalShow = app.dock.show.bind(app.dock);
    app.dock.__opencodexOriginalShow = originalShow;
    app.dock.show = () => {
      // 官方 main 偶尔会按桌面应用路径触发 dock.show；后台 runner 一律吞掉并维持隐藏。
      hideGatewayDockIcon();
      return undefined;
    };
  }
  if (typeof app.setActivationPolicy === "function") {
    const originalSetActivationPolicy = app.setActivationPolicy.bind(app);
    app.__opencodexOriginalSetActivationPolicy = originalSetActivationPolicy;
    app.setActivationPolicy = (policy) => originalSetActivationPolicy(policy === "regular" ? "prohibited" : policy);
  }
  if (typeof app.show === "function") {
    const originalShowApp = app.show.bind(app);
    app.__opencodexOriginalShowApp = originalShowApp;
    app.show = () => {
      // 后台 runner 没有需要展示的应用级 UI；任何 show 都保持为隐藏状态。
      hideGatewayDockIcon();
      return undefined;
    };
  }
}

function scheduleDockHideRetries() {
  if (gatewayAgentMode) return;
  let remaining = 20;
  const timer = setInterval(() => {
    hideGatewayDockIcon();
    remaining -= 1;
    if (remaining <= 0) clearInterval(timer);
  }, 500);
  if (timer.unref) timer.unref();
}

if (!gatewayAgentMode) {
  installDockVisibilityGuard();
  hideGatewayDockIcon();
  scheduleDockHideRetries();
  app.on("will-finish-launching", hideGatewayDockIcon);
  app.whenReady().then(hideGatewayDockIcon).catch(() => {});
  app.on("ready", hideGatewayDockIcon);
  app.on("activate", hideGatewayDockIcon);
  app.on("browser-window-created", hideGatewayDockIcon);
}

// 尽早隔离隐藏 runtime 的 Chromium profile；核心数据仍然通过 CODEX_HOME 与官方 Codex 共享。
const userDataPath =
  process.env.CODEX_WEB_OFFICIAL_USER_DATA_DIR ||
  process.env.CODEX_ELECTRON_USER_DATA_PATH ||
  (process.env.CODEX_WEB_RUNTIME_DIR ? path.join(process.env.CODEX_WEB_RUNTIME_DIR, "official-user-data") : "");
if (userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  process.env.CODEX_ELECTRON_USER_DATA_PATH = userDataPath;
  try {
    // --user-data-dir 需要尽早进入 Chromium 命令行；外层 spawn 也会传一份，这里作为 runner 入口兜底。
    app.commandLine.appendSwitch("user-data-dir", userDataPath);
  } catch {}
  try {
    app.setPath("userData", userDataPath);
  } catch {}
}

// 这条日志用于区分“Electron 启动前崩溃”和“gateway JS 初始化后崩溃”。
console.log("[official-electron-runner] loading gateway entry", entry);
require(entry);
`;
}

function officialFrameworksFingerprint(layout) {
  const entries = [];
  try {
    for (const entry of fs.readdirSync(layout.frameworksDir, { withFileTypes: true })) {
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(path.join(layout.frameworksDir, entry.name)),
      });
    }
  } catch {}
  return {
    source: realpathSafe(layout.frameworksDir),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function sameFrameworksFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath, logger }) {
  const nextFingerprint = officialFrameworksFingerprint(layout);
  const previous = readJsonIfPresent(markerPath);
  if (
    previous &&
    sameFrameworksFingerprint(previous.fingerprint, nextFingerprint) &&
    isDirectory(runnerFrameworksDir)
  ) {
    logLine(logger, `official Electron Frameworks cache hit: ${runnerFrameworksDir}`);
    return { copied: false };
  }

  /**
   * 不能把 Contents/Frameworks 做成指向 /Applications 的符号链接：官方 helper 进程会按 runner
   * 内部路径回溯加载 framework，macOS sandbox 会拒绝跨 bundle symlink。这里复制到运行态 cache。
   */
  fs.rmSync(runnerFrameworksDir, { recursive: true, force: true });
  fs.cpSync(layout.frameworksDir, runnerFrameworksDir, { recursive: true, force: true });
  writeJson(markerPath, {
    fingerprint: nextFingerprint,
    copiedAt: new Date().toISOString(),
  });
  logLine(logger, `official Electron Frameworks copied: ${layout.frameworksDir} -> ${runnerFrameworksDir}`);
  return { copied: true };
}

async function writeGatewayAsar({ runnerResourcesDir, workDir }) {
  const sourceDir = path.join(workDir, "app-src");
  const asarPath = path.join(runnerResourcesDir, "app.asar");
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "package.json"), `${JSON.stringify({ name: "opencodex-gateway-runner", main: "main.cjs" }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(sourceDir, "main.cjs"), gatewayRunnerMainSource(), "utf8");
  await asar.createPackage(sourceDir, asarPath);
}

function signRunnerExecutable(executablePath) {
  if (process.platform !== "darwin") return;
  /**
   * 官方主二进制复制到 runner 后原签名会失效；只重签这个入口壳。
   * Frameworks 保留官方签名副本，避免 deep 签名破坏 Chromium framework 的封装结构。
   */
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executablePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function createMacRunner({ layout, runtimeDir, logger }) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerAppPath = path.join(workDir, RUNNER_APP_NAME);
  const contentsDir = path.join(runnerAppPath, "Contents");
  const runnerMacosDir = path.join(contentsDir, "MacOS");
  const runnerResourcesDir = path.join(contentsDir, "Resources");
  const runnerFrameworksDir = path.join(contentsDir, "Frameworks");
  const frameworksMarkerPath = path.join(workDir, "frameworks-manifest.json");
  const runnerExecutablePath = path.join(runnerMacosDir, RUNNER_EXECUTABLE_NAME);

  // 官方升级后 framework/ABI 可能变化，Frameworks 由 fingerprint 控制；入口和 app.asar 每次重写。
  fs.rmSync(runnerMacosDir, { recursive: true, force: true });
  fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  fs.mkdirSync(runnerMacosDir, { recursive: true });
  fs.mkdirSync(runnerResourcesDir, { recursive: true });

  fs.copyFileSync(layout.executablePath, runnerExecutablePath);
  fs.chmodSync(runnerExecutablePath, 0o755);
  ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath: frameworksMarkerPath, logger });
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), runnerInfoPlist(), "utf8");
  fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");
  await writeGatewayAsar({ runnerResourcesDir, workDir });
  signRunnerExecutable(runnerExecutablePath);

  logLine(logger, `prepared official Electron runner: app=${runnerAppPath}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    executablePath: runnerExecutablePath,
    runnerAppPath,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger }) {
  if (process.platform !== "darwin") {
    throw new Error("当前 official Electron runner 仅支持 macOS；Windows/Linux 需要补充对应平台的官方运行时装配逻辑。");
  }
  const layout = findOfficialRuntimeLayout({ officialBundleDir, logger });
  return createMacRunner({ layout, runtimeDir, logger });
}

module.exports = {
  prepareOfficialElectronRuntime,
};
