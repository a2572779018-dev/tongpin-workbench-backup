import type { ComputerUseBridge, ComputerUseWindowState } from "../../../shared/computerUse";
import { buildComputerUsePlan, validateComputerUseModelPlan, type ComputerUseModelPlan } from "./computerUseFlow";

export interface ComputerTaskProgress {
  phase: "planning" | "awaiting_approval" | "executing" | "verifying";
  step: number;
  summary: string;
}
export interface ComputerTaskResult {
  status: "completed" | "paused" | "failed" | "unknown";
  steps: number;
  message: string;
  observation: ComputerUseWindowState | null;
}
interface ComputerTaskOptions {
  bridge: ComputerUseBridge;
  goal: string;
  initialState: ComputerUseWindowState;
  initialPlan?: ComputerUseModelPlan | null;
  planNext: (goal: string, state: ComputerUseWindowState) => Promise<ComputerUseModelPlan>;
  signal?: AbortSignal;
  onProgress?: (progress: ComputerTaskProgress) => void;
  maxSteps?: number;
  maxDurationMs?: number;
  now?: () => number;
}
class TaskPaused extends Error {}
function semantics(state: ComputerUseWindowState) {
  // Ephemeral native tokens rotate on every observation; they are not progress.
  // This stays local and is never sent to the planner or persisted.
  return JSON.stringify(state.elements.map(({ role, label, value, enabled, selected }) => ({ role, label, value, enabled, selected })));
}
function sameTarget(a: ComputerUseWindowState, b: ComputerUseWindowState) {
  return a.target.pid === b.target.pid && a.target.windowId === b.target.windowId && a.appName === b.appName && a.windowTitle === b.windowTitle;
}

/** Supervised, local-only loop. Every action still needs a one-use native
 * approval and fresh-state validation. It is not a background cloud grant. */
export async function runComputerUseTask(options: ComputerTaskOptions): Promise<ComputerTaskResult> {
  const { bridge, signal, onProgress } = options;
  const maxSteps = Math.max(1, Math.min(6, Math.floor(options.maxSteps ?? 6)));
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(1000, Math.min(180_000, options.maxDurationMs ?? 180_000));
  const origin = options.initialState;
  let snapshot = origin;
  let steps = 0;
  let executing = false;
  const attempted = new Set<string>();
  const result = (status: ComputerTaskResult["status"], message: string): ComputerTaskResult => ({ status, steps, message, observation: snapshot });
  function checkActive() {
    if (signal?.aborted) throw new TaskPaused("任务已暂停，未继续提交后续动作。");
    if (now() >= deadline) throw new TaskPaused("已达到本次任务时长上限，后续动作已停止。");
  }
  async function bounded<T>(run: () => Promise<T>): Promise<T> {
    checkActive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const output = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          abort = () => reject(new TaskPaused("任务已暂停，未继续提交后续动作。"));
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new TaskPaused("已达到本次任务时长上限，后续动作已停止。")), Math.max(1, deadline - now()));
        }),
      ]);
      checkActive();
      return output;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  try {
    while (steps < maxSteps) {
      checkActive();
      if (!snapshot.snapshotId || snapshot.degraded || snapshot.truncated || !sameTarget(origin, snapshot)) {
        return result("paused", "目标窗口或观察范围发生变化，已暂停。请重新选择并读取窗口。");
      }
      let proposed = steps === 0 ? options.initialPlan : null;
      if (!proposed) {
        onProgress?.({ phase: "planning", step: steps + 1, summary: `正在根据最新窗口规划第 ${steps + 1} 步` });
        proposed = await bounded(() => options.planNext(options.goal, snapshot));
      }
      const validated = validateComputerUseModelPlan(proposed, options.goal, snapshot);
      const plan = validated ? buildComputerUsePlan(snapshot, validated.action) : null;
      if (!plan) return result("failed", "下一步未通过本机安全校验，未执行操作。");
      const element = snapshot.elements.find(item => item.elementToken === plan.action.elementToken);
      const identity = JSON.stringify([plan.action.kind, element?.role, element?.label,
        plan.action.kind === "type" ? plan.action.text : plan.action.kind === "scroll" ? [plan.action.direction, plan.action.amount] : plan.action.kind === "key" ? plan.action.key : null]);
      if (attempted.has(identity)) return result("paused", "下一步重复了已尝试的动作，已暂停，避免重复输入或重复提交。");
      onProgress?.({ phase: "awaiting_approval", step: steps + 1, summary: plan.summary });
      const approval = await bounded(() => bridge.requestActionApproval(plan.action));
      if (!approval.ok) return result("paused", `${approval.error.message}；动作未执行。`);
      attempted.add(identity);
      onProgress?.({ phase: "executing", step: steps + 1, summary: plan.summary });
      checkActive();
      executing = true;
      steps += 1;
      const execution = await bounded(() => bridge.executeApprovedAction(approval.value.token));
      executing = false;
      if (!execution.ok) return result(execution.error.code === "action_outcome_unknown" ? "unknown" : "failed", `${execution.error.message}；不会自动重试。`);
      onProgress?.({ phase: "verifying", step: steps, summary: "正在重新读取授权窗口，核对动作结果" });
      const observed = await bounded(() => bridge.getWindowState(origin.target));
      if (!observed.ok) return result("unknown", `${observed.error.message}；无法确认结果，已停止。`);
      const previous = snapshot;
      snapshot = observed.value;
      // Native delivery and the target app's accessibility repaint are not
      // atomic. Allow a short, read-only settling window; never resend input.
      for (let retry = 0; retry < 2 && sameTarget(origin, snapshot) && semantics(previous) === semantics(snapshot); retry += 1) {
        await bounded(() => new Promise(resolve => setTimeout(resolve, 150)));
        const settled = await bounded(() => bridge.getWindowState(origin.target));
        if (!settled.ok) return result("unknown", `${settled.error.message}；无法确认结果，已停止。`);
        snapshot = settled.value;
      }
      if (!sameTarget(origin, snapshot)) return result("paused", "目标窗口发生变化，已暂停，未向其他窗口规划或输入。");
      if (snapshot.degraded || snapshot.truncated) return result("unknown", "动作后快照不完整，不能确认结果，已停止。");
      if (plan.action.kind === "type") {
        const expectedText = plan.action.text;
        const matches = snapshot.elements.filter(item => item.role === element?.role && item.label === element?.label);
        const verified = matches.length === 1 && matches[0].value !== element?.value && matches[0].value?.includes(expectedText);
        // Only a narrowly defined literal-input goal has a machine-verifiable
        // end condition. Arbitrary business tasks are never marked completed.
        const literalTail = options.goal.slice(options.goal.indexOf(expectedText) + expectedText.length).replace(/[”"'’。.!！\s]/gu, "");
        if (verified && literalTail === "" && /输入|键入|填写|\btype\b/iu.test(options.goal)) {
          return result("completed", `已完成 ${steps} 步，并在授权窗口中核验指定文字已输入。`);
        }
        return result("paused", verified ? "已核验本次文字输入；其余任务目标需你确认，已暂停。" : "已发送输入，但未在快照中核验到指定文字；不会重复输入。");
      }
      if (semantics(previous) === semantics(snapshot)) return result("paused", "未观察到窗口内容推进，已暂停，避免重复点击。");
    }
    return result("paused", `已达到本次 ${maxSteps} 步上限，后续操作已停止。`);
  } catch (error) {
    if (executing) return result("unknown", "动作提交过程中任务已停止，当前动作结果未知；不会自动重试。");
    return result(error instanceof TaskPaused ? "paused" : "failed", error instanceof Error ? error.message : "电脑任务失败，后续动作已停止。");
  } finally {
    // Invalidate pending approvals, including a native dialog that resolves
    // after a pause/unmount. No grant is retained for the next task.
    void bridge.stopSession().catch(() => undefined);
  }
}
