#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Windows 不使用 Unix 可执行位；Linux/macOS 等平台的 spawn-helper 需要 +x。
if (process.platform === "win32") {
  process.exit(0);
}

function chmodExecutableIfPresent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if ((stat.mode & 0o111) !== 0o111) {
      fs.chmodSync(filePath, stat.mode | 0o755);
      console.log(`[postinstall] fixed executable bit: ${filePath}`);
    }
    return true;
  } catch {
    return false;
  }
}

// 覆盖源码构建、当前平台预编译包，以及包内可能存在的其他 Unix 预编译目录。
function listNodePtySpawnHelperPaths(nodePtyRoot) {
  const helperPaths = [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "build", "Debug", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  const prebuildsDir = path.join(nodePtyRoot, "prebuilds");
  try {
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        helperPaths.push(path.join(prebuildsDir, entry.name, "spawn-helper"));
      }
    }
  } catch {}
  return [...new Set(helperPaths)];
}

let nodePtyRoot;
try {
  nodePtyRoot = path.resolve(path.dirname(require.resolve("node-pty")), "..");
} catch {
  process.exit(0);
}

for (const helperPath of listNodePtySpawnHelperPaths(nodePtyRoot)) {
  chmodExecutableIfPresent(helperPath);
}
