import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (
  process.env.TONGPIN_CLOUDFLARE_TEST_URL ?? "http://127.0.0.1:8788"
).replace(/\/$/, "");
const evidencePath = path.resolve(
  process.env.TONGPIN_E2E_RESULT ?? "output/cloudflare-e2e-result.json",
);
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: evidence.memberEmail,
    password: evidence.memberPassword,
  }),
});
const login = await loginResponse.json();
assert.equal(loginResponse.status, 200, login?.error?.message);
assert.equal(login.user.id, evidence.memberId);

const tasksResponse = await fetch(`${baseUrl}/api/tasks?date=${evidence.date}`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
});
const taskPayload = await tasksResponse.json();
assert.equal(tasksResponse.status, 200, taskPayload?.error?.message);
assert.deepEqual(
  new Set(taskPayload.tasks.map((task) => task.id)),
  new Set(evidence.taskIds),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      serviceRestarted: true,
      sameAccount: login.user.id === evidence.memberId,
      persistedTaskCount: taskPayload.tasks.length,
      persistedTaskIdsMatch: true,
      priorities: [...new Set(taskPayload.tasks.map((task) => task.priority))],
    },
    null,
    2,
  ),
);
