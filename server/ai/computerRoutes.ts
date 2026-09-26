import type { AiService } from "./service";

/**
 * One framework-neutral route table for the computer executor, mounted by the
 * Express router (server/routes/ai.ts) and the Worker handler
 * (cloudflare/src/ai/routes.ts) so both deployments expose identical behavior.
 * Authentication, account binding and role checks happen before this table.
 */
export interface ComputerApiRequest {
  method: string;
  /** Absolute path, e.g. `/api/ai/computer/tasks` or `/api/admin/ai/computer`. */
  path: string;
  userId: string;
  readBody: () => Promise<unknown>;
}

export async function handleComputerApi(service: AiService, request: ComputerApiRequest): Promise<{ status: number; body: unknown } | null> {
  const { method, path, userId, readBody } = request;
  const ok = (body: unknown) => ({ status: 200, body });
  if (path === "/api/admin/ai/computer" && method === "GET") return ok({ settings: service.computer.settings() });
  if (path === "/api/admin/ai/computer" && method === "PUT") return ok({ settings: await service.computer.saveSettings(await readBody()) });
  if (path === "/api/admin/ai/computer/test" && method === "POST") return ok(await service.computer.testSettings());
  if (path === "/api/ai/computer/tasks" && method === "POST") return ok(await service.computer.createTask(userId, await readBody()));
  const run = /^\/api\/ai\/computer\/runs\/([^/]{1,80})(\/decide|\/finish)?$/.exec(path);
  if (run) {
    const runId = decodeURIComponent(run[1]);
    if (!run[2] && method === "GET") return ok({ run: service.computer.get(userId, runId) });
    if (run[2] === "/decide" && method === "POST") return ok(await service.computer.decide(userId, runId, await readBody()));
    if (run[2] === "/finish" && method === "POST") return ok({ run: service.computer.finish(userId, runId, await readBody()) });
  }
  return null;
}
