let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch {}
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");

function routeIdFromPayload(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || depth > 4) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = routeIdFromPayload(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value.requestId === "string" && value.requestId) return value.requestId;
  if (value.request && typeof value.request === "object" && value.request.id != null) return String(value.request.id);
  if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) return String(value.id);
  for (const key of ["payload", "message", "response", "body"]) {
    const nested = routeIdFromPayload(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

function wsPayloadSummary(payload) {
  const summary = {};
  if (payload && typeof payload === "object") {
    if (typeof payload.channel === "string") summary.channel = payload.channel;
    if (typeof payload.portId === "string") summary.portId = shortId(payload.portId);
    const nestedPayload = payload.payload && typeof payload.payload === "object" ? payload.payload : payload.payload;
    if (nestedPayload && typeof nestedPayload === "object" && typeof nestedPayload.type === "string") {
      summary.type = nestedPayload.type;
    }
    if (payload.type && typeof payload.type === "string") summary.type = payload.type;
    const requestId = routeIdFromPayload(payload);
    if (requestId) summary.requestId = requestId;
    summary.payloadType = nestedPayload && typeof nestedPayload === "object" ? `object(${Object.keys(nestedPayload).length})` : typeof nestedPayload;
  }
  return summary;
}

// ws-hub 不理解官方 IPC 协议，只负责维护连接和按 clientId 投递 JSON 消息。
/** 创建 WebSocket hub，负责浏览器连接管理和 gateway 事件分发。 */
function createWsHub(server, { createAppHostRelay, isAuthed }) {
  if (!WebSocketServer) {
    throw new Error("The ws package is required for gateway websocket support.");
  }

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  // clientsById 是定向回包索引；clients 是广播索引，二者都需要维护。
  const clientsById = new Map();
  let lastAuthRejectLogAtMs = 0;
  let suppressedAuthRejectCount = 0;

  function safeSend(socket, payload, options = {}) {
    // 所有 WebSocket 下行都走这个出口，便于统一压日志和记录投递失败。
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      if (!options.suppressDiagnostic) {
        diagnosticLog("ws-hub", "send", wsPayloadSummary(payload));
      }
      return true;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_failed", {
        ...wsPayloadSummary(payload),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function appHostRelaysForSocket(ws) {
    // app-host MessagePort 的生命周期必须跟浏览器页面一致，不能做成跨页面共享的全局状态。
    if (!ws.__codexAppHostRelays) ws.__codexAppHostRelays = new Map();
    return ws.__codexAppHostRelays;
  }

  function closeAppHostRelays(ws, reason) {
    const relays = ws.__codexAppHostRelays;
    if (!relays || relays.size === 0) return;
    // 页面断开时主动关闭官方端口，否则官方 app-host 服务会保留无主连接。
    for (const [portId, relay] of relays.entries()) {
      relays.delete(portId);
      try {
        relay.close(reason);
      } catch {}
    }
  }

  function removeClient(ws) {
    closeAppHostRelays(ws, "client_disconnected");
    clients.delete(ws);
    if (ws.__codexWebClientId && clientsById.get(ws.__codexWebClientId) === ws) {
      clientsById.delete(ws.__codexWebClientId);
    }
  }

  function logAuthRejected(url) {
    const now = Date.now();
    if (now - lastAuthRejectLogAtMs < 10_000) {
      suppressedAuthRejectCount += 1;
      return;
    }
    // 未登录旧页面可能持续重连 WS，这里节流汇总，避免噪声盖住真实 IPC 慢链路。
    diagnosticWarn("ws-hub", "upgrade_rejected_auth", {
      suppressedCount: suppressedAuthRejectCount,
      url,
    });
    suppressedAuthRejectCount = 0;
    lastAuthRejectLogAtMs = now;
  }

  /** 向所有在线浏览器广播 gateway 消息。 */
  function broadcast(payload, options = {}) {
    const message = JSON.stringify(payload);
    let sent = 0;
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(message);
        sent += 1;
      } catch {}
    }
    if (!options.suppressDiagnostic) {
      diagnosticLog("ws-hub", "broadcast", {
        ...wsPayloadSummary(payload),
        clientCount: clients.size,
        sent,
      });
    }
    return sent;
  }

  /** 向指定 clientId 的浏览器发送 gateway 消息。 */
  function sendTo(clientId, payload, options = {}) {
    const socket = clientsById.get(clientId);
    if (!socket || socket.readyState !== socket.OPEN) {
      diagnosticWarn("ws-hub", "send_to_missing_client", {
        ...wsPayloadSummary(payload),
        clientId: shortId(clientId),
        readyState: socket ? socket.readyState : "missing",
      });
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      if (!options.suppressDiagnostic) {
        diagnosticLog("ws-hub", "send_to", {
          ...wsPayloadSummary(payload),
          clientId: shortId(clientId),
        });
      }
      return true;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_to_failed", {
        ...wsPayloadSummary(payload),
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function hasClient(clientId) {
    const socket = clientsById.get(clientId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  function normalizedWsClientId(ws, message) {
    // 控制帧允许带 clientId，但最终必须和 hello 注册到 socket 上的 clientId 一致。
    const messageClientId = message && typeof message.clientId === "string" ? message.clientId : "";
    const socketClientId = ws.__codexWebClientId || "";
    return messageClientId || socketClientId;
  }

  function validAppHostPortId(value) {
    // portId 只作为本页多条 MessagePort 的路由键，限制长度即可，不引入额外协议含义。
    return typeof value === "string" && value.length > 0 && value.length <= 160;
  }

  function handleAppHostConnect(ws, req, message) {
    // 浏览器发起 connect 后，gateway 才创建 Electron MessageChannelMain 并交给官方 listener。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_connect_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    if (typeof createAppHostRelay !== "function") {
      diagnosticWarn("ws-hub", "app_host_connect_unavailable", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
      safeSend(ws, { type: "app-host-port-error", portId, error: "App host relay is unavailable" });
      return true;
    }

    const relays = appHostRelaysForSocket(ws);
    const existing = relays.get(portId);
    if (existing) {
      // 同一个页面重复使用 portId 时以后到者为准，先关闭旧 relay 避免双写。
      try {
        existing.close("replaced");
      } catch {}
      relays.delete(portId);
    }

    try {
      const relay = createAppHostRelay({
        clientId,
        portId,
        remoteAddress: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "",
        onClose(reason) {
          if (relays.get(portId) === relay) relays.delete(portId);
          safeSend(ws, { type: "app-host-port-close", portId, reason }, { suppressDiagnostic: true });
          diagnosticLog("ws-hub", "app_host_closed", {
            clientId: shortId(clientId),
            portId: shortId(portId),
            reason,
          });
        },
        onError(error) {
          safeSend(
            ws,
            {
              type: "app-host-port-error",
              portId,
              error: error instanceof Error ? error.message : String(error),
            },
            { suppressDiagnostic: true }
          );
        },
        onMessage(data) {
          // app-host RPC 是高频字符串流，只转发不逐条写日志，避免首屏日志刷屏和拖慢关键链路。
          safeSend(ws, { type: "app-host-port-message", portId, data }, { suppressDiagnostic: true });
        },
      });
      relays.set(portId, relay);
      safeSend(ws, { type: "app-host-port-connected", portId }, { suppressDiagnostic: true });
      diagnosticLog("ws-hub", "app_host_connect", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
    } catch (error) {
      diagnosticWarn("ws-hub", "app_host_connect_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      safeSend(
        ws,
        {
          type: "app-host-port-error",
          portId,
          error: error instanceof Error ? error.message : String(error),
        },
        { suppressDiagnostic: true }
      );
    }
    return true;
  }

  function handleAppHostPortMessage(ws, message) {
    // 浏览器端 MessagePort 的后续字符串帧都从这里回写到官方 Electron port。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    const data = message ? message.data : undefined;
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_message_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    if (!(data == null || typeof data === "string")) {
      // 官方 app-host 当前只使用字符串 JSON-RPC 帧；非字符串直接拒绝，避免污染官方端口。
      diagnosticWarn("ws-hub", "app_host_non_string_message_rejected", {
        clientId: shortId(clientId),
        payloadType: typeof data,
        portId: shortId(portId),
      });
      return true;
    }
    const relays = appHostRelaysForSocket(ws);
    const relay = relays.get(portId);
    if (!relay) {
      diagnosticWarn("ws-hub", "app_host_message_missing_relay", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
      return true;
    }
    relay.postMessage(data);
    // null 是关闭信号，发送给官方后即可从索引移除，后续 close 回调再到达也不会重复处理。
    if (data == null && relays.get(portId) === relay) relays.delete(portId);
    return true;
  }

  function handleWsControlMessage(ws, req, message) {
    if (!message || typeof message !== "object") return false;
    if (message.type === "app-host-connect") return handleAppHostConnect(ws, req, message);
    if (message.type === "app-host-port-message") return handleAppHostPortMessage(ws, message);
    return false;
  }

  // 只接受 /ws 升级，并校验 gateway 访问 token。浏览器 WebSocket 不能自定义 header，所以允许 query/cookie。
  server.on("upgrade", (req, socket, head) => {
    // 先在 HTTP upgrade 阶段完成路径和 auth 校验，失败时不创建 WebSocket 对象。
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      diagnosticWarn("ws-hub", "upgrade_rejected_path", { url: req.url || "" });
      return socket.destroy();
    }
    if (!isAuthed(req, url)) {
      logAuthRejected(url.pathname);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      diagnosticLog("ws-hub", "connected", {
        clientCount: clients.size,
        remoteAddress: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "",
      });
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          const clientId = message && typeof message.clientId === "string" ? message.clientId : "";
          // hello 是浏览器接入 IPC 的握手消息，拿到 clientId 后才能定向投递事件。
          if (message && message.type === "hello" && clientId) {
            const previousClientId = ws.__codexWebClientId;
            if (previousClientId && previousClientId !== clientId && clientsById.get(previousClientId) === ws) {
              clientsById.delete(previousClientId);
            }
            // 后来重复 hello 时直接覆盖映射，保证同一 clientId 指向最新连接。
            ws.__codexWebClientId = clientId;
            clientsById.set(clientId, ws);
            diagnosticLog("ws-hub", "hello", {
              clientId: shortId(clientId),
              clientCount: clients.size,
              mappedClientCount: clientsById.size,
            });
            try {
              // ack 明确告诉浏览器：clientId 已经进入路由表，可以开始发会产生异步回包的官方 IPC。
              ws.send(JSON.stringify({ type: "hello-ack", clientId }));
              diagnosticLog("ws-hub", "hello_ack", { clientId: shortId(clientId) });
            } catch (error) {
              diagnosticWarn("ws-hub", "hello_ack_failed", {
                clientId: shortId(clientId),
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return;
          }
          if (handleWsControlMessage(ws, req, message)) return;
        } catch (error) {
          diagnosticWarn("ws-hub", "message_parse_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      ws.on("close", () => {
        // close/error 都要从两个索引里删除，避免后续 sendTo 命中过期 socket。
        const closedClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        diagnosticLog("ws-hub", "closed", {
          clientId: shortId(closedClientId),
          clientCount: clients.size,
          mappedClientCount: clientsById.size,
        });
      });
      ws.on("error", (error) => {
        // error 事件不一定随后触发 close，这里主动做一次相同清理。
        const erroredClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        diagnosticWarn("ws-hub", "error", {
          clientId: shortId(erroredClientId),
          clientCount: clients.size,
          error: error instanceof Error ? error.message : String(error),
          mappedClientCount: clientsById.size,
        });
      });
      wss.emit("connection", ws, req);
    });
  });

  return { broadcast, clients, sendTo, hasClient };
}

module.exports = { createWsHub };
