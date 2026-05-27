# OpenCodex

[中文](../README.md) | **English**

OpenCodex is a lightweight implementation of a Codex runtime environment. It runs the official Codex Renderer in a standard Web environment, allowing users to remotely access and operate Codex running on a target machine from any device and network.

In one line:

```text
browser -> web-shell -> official Codex renderer -> bridge polyfill -> official-gateway -> hidden official Electron runtime
```

---

Bad timing: just as this project was about to be open sourced, ChatGPT App added Codex support.

OpenCodex still has several advantages compared with the official mobile path:

1. No proxy setup required.
2. No Google Play account required.
3. Full Codex feature support, including file tree, terminal, review, and other workflows that make AI coding practical anytime and anywhere.

> This software is currently a beta version and may still have issues. If you find a problem, please report it through an issue so the developer can fix it.

<p align="center">
  <img src="image/start.jpg" alt="OpenCodex start" width="23%" />
  &nbsp;
  <img src="image/settings.jpg" alt="OpenCodex settings" width="23%" />
  &nbsp;
  <img src="image/home.jpg" alt="OpenCodex home" width="23%" />
  &nbsp;
  <img src="image/new.jpg" alt="OpenCodex new session" width="23%" />
</p>

## Core Components

The project has four main parts:

| Module | Purpose |
| --- | --- |
| `web-shell/` | Browser entry point for loading the official renderer and providing the renderer runtime environment. |
| `official-gateway/` | Current runtime entry point. It provides HTTP, WebSocket, auth, and forwards browser IPC into the hidden official Electron runtime. |
| `gateway/src/official/` | Scanning, identification, caching, and renderer working-copy extraction for the official Codex `app.asar`. |
| `desktop/` | Launcher shell for configuration, gateway startup, and process monitoring. |

This software **does not modify** Codex code. It only uses the corresponding Renderer artifacts.

When the Gateway starts, it automatically checks whether the local Codex installation has been updated. If an update is found, it automatically refreshes the Renderer artifacts used by OpenCodex, which means it follows the corresponding Codex version.

## Architecture Overview

```mermaid
flowchart TB
  L1["Access Layer<br/>Remote device browser<br/>Starts access and displays the interactive UI"]

  L2["Web Host Layer<br/>web-shell<br/>Hosts the official Renderer in a standard Web environment"]

  L3["Renderer Compatibility Layer<br/>codex-bridge-polyfill<br/>Fills Electron Renderer runtime dependencies<br/>and converts Renderer calls into Web IPC"]

  L4["Gateway Layer<br/>official-gateway<br/>Handles auth, HTTP / WebSocket<br/>and acts as the unified target-machine entry point"]

  L5["Official Electron Runtime<br/>Hidden BrowserWindow + official IPC handlers<br/>Reuse Desktop host semantics and local capabilities"]

  L6["Codex Business Capability Layer<br/>Codex app-server<br/>Provides sessions, models, config, MCP, task execution, and other core capabilities"]

  L7["Official Artifact Layer<br/>Codex Desktop / Renderer Bundle<br/>Provides the official Renderer artifact and version source"]

  L1 --> L2
  L2 --> L3
  L3 --> L4
  L4 --> L5
  L5 --> L6

  L7 -.provides Renderer artifact.-> L2
```

Core principles:

- Reuse the official Renderer instead of rewriting the main UI.
- Keep browser-side code focused on host-environment compatibility.
- Keep gateway responsibilities limited to auth, transport, and official IPC hooks; sessions, terminal, Git, plugins, MCP, and similar business semantics continue to run through official handlers.
- The app-server is started by the hidden official runtime using the official flow. OpenCodex only constrains that launch to the resolved Codex Desktop CLI.
- IPC exceptions and unroutable official outbound messages are written to `reports/unknown-ipc.jsonl` for compatibility diagnostics.

## Requirements

- Node.js 20 or newer
- pnpm
- Codex Desktop installed locally, recommended, or explicit environment variables pointing to the Codex Desktop app or official bundle.
- macOS / Windows. Launcher build commands are provided for both macOS and Windows.

Install dependencies:

```bash
pnpm install
```

## How To Use

### Desktop One-Click Launcher Package

A Launcher packaging entry point is currently available. On startup, it automatically starts the gateway and shows:

- Local access address, gateway process, and listening port.
- Current Codex version, build, Codex installation path, `app.asar` path, and CLI path.
- Config file, logs, reports, and official renderer cache directories.
- Current official runtime / app-server connection status.
- Access password settings. Authentication is disabled when the password is empty.
- Startup address settings. Local mode listens on `127.0.0.1`; LAN mode listens on `0.0.0.0` and shows accessible LAN addresses.
- Port settings. On first startup, the Launcher randomly chooses an available port and persists it. You can manually set the port later.

After installing dependencies and building, you can debug the Launcher locally:

```bash
pnpm run desktop:dev
```

Build macOS installer artifacts:

```bash
pnpm run desktop:dist:mac
```

Build Windows installer artifacts:

```bash
pnpm run desktop:dist:win
```

Artifacts are written to `release/`. The Launcher listens on `127.0.0.1` by default, chooses a random available port on first startup, and stores runtime data in the system user data directory instead of the installation directory. After changing the listening address, port, or access password, the Launcher restarts the gateway so the configuration takes effect.

> Codex Desktop still needs to be installed locally before packaging. The Launcher reuses the official renderer and app-server capabilities from the local Codex Desktop installation.

#### Build A macOS Installer

Build macOS artifacts from a clean repository:

```bash
git clone xxx
cd OpenCodex
pnpm install
pnpm run build
pnpm run desktop:dist:mac
```

`desktop:dist:mac` first compiles `gateway/src/official`, then uses `electron-builder` to generate `.dmg` and `.zip` artifacts. Outputs are written to `release/`:

```text
release/OpenCodex-<version>-arm64.dmg
release/OpenCodex-<version>-arm64-mac.zip
```

If you only need to verify the current local architecture, specify the architecture directly. For example, on Apple Silicon:

```bash
pnpm run build
pnpm exec electron-builder --mac dmg zip --arm64
```

Debug an unpacked `.app`:

```bash
pnpm run build
pnpm exec electron-builder --mac --dir --arm64
```

The generated `.app` creates a user data directory on startup and stores Launcher settings, access password configuration, gateway logs, and the official renderer cache there.

#### Build A Windows Installer

Build Windows artifacts from a clean repository:

```powershell
git clone xxx
cd OpenCodex
pnpm install
pnpm run build
pnpm run desktop:dist:win
```

`desktop:dist:win` first compiles `gateway/src/official`, then uses `electron-builder` to generate an x64 NSIS installer and `.zip`. Outputs are written to `release/`.

Debug an unpacked Windows application directory:

```powershell
pnpm run build
pnpm run desktop:pack:win
```

### Command-Line Startup

Build first:

```bash
pnpm build
```

Start the service:

**Setting an access password is strongly recommended**. You can copy the example config and edit the password:

```bash
cp config.example.yaml config.yaml
```

You can also create `config.yaml` manually in the current working directory:

```yaml
auth:
  password: "your-password"
```

On the first startup, the gateway rewrites this field to `sha256-v1:<hash>` so the plaintext password is not kept in the config file. If `config.yaml` is missing, `auth.password` is missing, or the field is empty, password authentication stays disabled.
Only the block-style YAML form shown above is supported; inline forms such as `auth: { password: "..." }` are rejected.

```bash
HOST=0.0.0.0 PORT=3737 pnpm run web:dev
```

Health check:

```text
curl http://127.0.0.1:3737/api/health
```

Remote access:

Use Tailscale, ZeroTier, a company VPN, or a similar private network solution for secure **remote LAN** access. **Direct public exposure is not recommended**.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Gateway bind address. The default is intended for remote access. |
| `PORT` | `3737` | Gateway port. |
| `CODEX_WEB_AUTH_TOKEN_TTL_MS` | `43200000` | Gateway access token lifetime. The default is 12 hours. |
| `CODEX_WEB_DEBUG` | empty | Set to `1` or `true` for verbose debug logs. |
| `CODEX_WEB_SLOW_LOG_MS` | `750` | IPC slow-call logging threshold. |
| `CODEX_WEB_LOCAL_FILE_TOKEN_TTL_MS` | `300000` | Lifetime for local file preview URL tokens. |
| `CODEX_DESKTOP_APP_PATH` | auto scan | Explicit path to the Codex Desktop installation or its `app.asar`. |
| `CODEX_WEB_RUNTIME_DIR` | project directory | Gateway runtime directory. The Launcher sets this to the user data directory. |
| `CODEX_WEB_CONFIG_PATH` | `config.yaml` | Access password configuration file path. |
| `CODEX_WEB_REPORTS_DIR` | `reports` | Diagnostic reports directory. |
| `CODEX_WEB_OFFICIAL_BUNDLE_DIR` | `runtime/cache/codex-official-bundle` | Runtime cache for the extracted official working copy; it is not bundled into dist and never writes back to the official installation. |
| `CODEX_WEB_OFFICIAL_USER_DATA_DIR` | `runtime/official-user-data` | Electron profile directory for the hidden official runtime; isolated from Codex Desktop by default while still sharing `~/.codex`. |
| `CODEX_WEB_OFFICIAL_TMPDIR` | `/tmp/opencodex-official-<uid>-<hash>` | Temporary directory for the hidden official runtime; isolates the official live IPC socket from Codex Desktop while still sharing `~/.codex`. |

## Files / Directories

| Path | Description |
| --- | --- |
| `official-gateway/server.cjs` | Gateway entry point for HTTP, WebSocket, auth, and the official runtime. |
| `official-gateway/official-runtime.cjs` | Loads the hidden official Electron runtime and hooks official IPC handlers, BrowserWindow, and app-server startup. |
| `official-gateway/ws-hub.cjs` | Browser WebSocket connections, async IPC replies, and app-host MessagePort relay. |
| `gateway/src/official/` | Codex Desktop `app.asar` scanning, identification, caching, and webview extraction. |
| `web-shell/index.html` | Browser bootstrap shell for login, settings, and loading the patched official renderer. |
| `web-shell/codex-bridge-polyfill.js` | Browser-side Electron/Codex bridge polyfill. |
| `reports/unknown-ipc.jsonl` | Runtime log for unknown IPC calls. |

## pnpm Scripts

| Script | Description |
| --- | --- |
| `pnpm run build:gateway` | Clean and compile `gateway/src/official` into `gateway/dist/official`. |
| `pnpm run web:dev` | Start the compiled gateway. |
| `pnpm run desktop:dev` | Compile and start the Launcher for debugging. |
| `pnpm run desktop:pack:mac` | Generate an unpacked macOS `.app`. |
| `pnpm run desktop:dist:mac` | Generate macOS `.dmg` and `.zip` artifacts. |
| `pnpm run desktop:pack:win` | Generate an unpacked Windows application directory. |
| `pnpm run desktop:dist:win` | Generate a Windows NSIS installer and `.zip` artifact. |

## Troubleshooting

### Chat history is empty after opening a session

The first load can be slow and is affected by remote LAN bandwidth. If the history is not visible at first, wait for a while and it should appear.

### The page does not open after startup

Check whether the gateway is listening:

```bash
curl http://127.0.0.1:3737/api/health
```

If the port is already in use, start on another port:

```bash
PORT=3738 pnpm run web:dev
```

### Codex Desktop official bundle is not found

Set the Codex Desktop path explicitly:

```bash
CODEX_DESKTOP_APP_PATH="/Applications/Codex.app" pnpm run web:dev
```

You can also choose the bundle cache directory:

```bash
CODEX_WEB_OFFICIAL_BUNDLE_DIR="./cache/official-bundle" pnpm run web:dev
```

### IPC behavior is incomplete

Inspect unknown IPC logs and report them to the developer:

```bash
tail -f reports/unknown-ipc.jsonl
```

### Links

[LinuxDo](https://linux.do/)
