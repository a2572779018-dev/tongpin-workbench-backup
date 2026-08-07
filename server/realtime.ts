import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "./config";
import type { RealtimeHub } from "./routes/boss";
import { verifyAccessToken } from "./security";
import { JsonStore } from "./store";

interface ClientMessage {
  type?: string;
  token?: string;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function attachRealtime(
  server: HttpServer,
  store: JsonStore,
  config: AppConfig,
): RealtimeHub {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });
  const clients = new Map<string, Set<WebSocket>>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/realtime") {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (
      origin &&
      origin !== "null" &&
      !config.clientOrigins.includes(origin)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  });

  webSockets.on("connection", (socket) => {
    let userId: string | null = null;
    const authenticationTimer = setTimeout(() => {
      if (!userId) socket.close(4401, "authentication required");
    }, 5_000);

    socket.on("message", async (raw, isBinary) => {
      if (isBinary || userId) return;
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        if (message.type !== "auth" || typeof message.token !== "string") {
          throw new Error("missing authentication");
        }
        const claims = verifyAccessToken(message.token, config);
        const user = await store.read((database) =>
          database.users.find((candidate) => candidate.id === claims.sub),
        );
        if (!user || user.status !== "active") {
          throw new Error("inactive user");
        }

        userId = user.id;
        clearTimeout(authenticationTimer);
        const userClients = clients.get(userId) ?? new Set<WebSocket>();
        userClients.add(socket);
        clients.set(userId, userClients);
        sendJson(socket, {
          type: "realtime:ready",
          data: { connected: true },
        });
      } catch {
        socket.close(4401, "unauthorized");
      }
    });

    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      if (!userId) return;
      const userClients = clients.get(userId);
      userClients?.delete(socket);
      if (userClients?.size === 0) clients.delete(userId);
    });

    socket.on("error", () => {
      // The close event performs connection cleanup.
    });
  });

  return {
    notifyUser(userId, notification, type = "notification:new") {
      for (const socket of clients.get(userId) ?? []) {
        sendJson(socket, {
          type,
          data: notification,
        });
      }
    },
    receiptUser(userId, receipt) {
      for (const socket of clients.get(userId) ?? []) {
        sendJson(socket, {
          type: "notification:receipt",
          data: receipt,
        });
      }
    },
    messageUser(userId, message, sender) {
      for (const socket of clients.get(userId) ?? []) {
        sendJson(socket, {
          type: "message:new",
          data: { message, sender },
        });
      }
    },
    pushUser(userId, type, data) {
      for (const socket of clients.get(userId) ?? []) {
        sendJson(socket, { type, data });
      }
    },
  };
}
