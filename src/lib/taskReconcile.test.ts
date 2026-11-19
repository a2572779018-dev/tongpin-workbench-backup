import { expect, it } from "vitest";
import { TaskReconcileGate } from "./taskReconcile";
it("joins concurrent reads and rechecks a change received before acknowledgement", async () => {
  const gate = new TaskReconcileGate(); let calls = 0, release!: () => void;
  const operation = async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); };
  const first = gate.ensure("account/day", operation), second = gate.ensure("account/day", operation);
  gate.invalidate(); release(); await Promise.all([first, second]);
  expect(calls).toBe(2);
  await gate.ensure("account/day", operation); expect(calls).toBe(2);
});
it("does not mark a failed correction as verified or share it across accounts", async () => {
  const gate = new TaskReconcileGate();
  await expect(gate.ensure("a/day", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  let calls = 0; const operation = async () => { calls++; };
  await gate.ensure("a/day", operation); await gate.ensure("b/day", operation);
  expect(calls).toBe(2);
});
