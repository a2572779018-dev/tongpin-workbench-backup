import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

/**
 * supertest(app) binds the wildcard address on an ephemeral port and then dials
 * 127.0.0.1:<port>. On macOS (SO_REUSEADDR, BSD more-specific-bind-wins) that port
 * can already be held on 127.0.0.1 by a server in a parallel test worker, so the
 * request silently reaches the other runtime (different JWT secret/users) and
 * returns 401/403 from the wrong app. Bind loopback explicitly so the kernel only
 * hands out a port that is free on 127.0.0.1 and requests always reach this app.
 */
export async function listenLoopback(app: Express): Promise<Server> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address() as AddressInfo | null;
  if (address?.address !== "127.0.0.1") {
    server.close();
    throw new Error(`Expected loopback test server, got ${JSON.stringify(address)}`);
  }
  return server;
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
