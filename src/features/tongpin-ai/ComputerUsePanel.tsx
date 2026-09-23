import {
  Eye,
  Keyboard,
  LoaderCircle,
  MonitorUp,
  MousePointer2,
  Pause,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ComputerUseBridge,
  ComputerUseProbeResult,
  ComputerUseWindow,
  ComputerUseWindowState,
} from "../../../shared/computerUse";
import {
  actionableComputerElements,
  buildComputerUsePlan,
  computerUseResultMessage,
  editableComputerElements,
  validateComputerUseModelPlan,
  type ComputerUseDraft,
  type ComputerUseModelPlan,
} from "./computerUseFlow";
import { getComputerUseBridge } from "../../lib/computerUseBridge";
import { runComputerUseTask, type ComputerTaskProgress } from "./computerUseTask";
import "./computer-use.css";

interface ComputerUsePanelProps {
  requestId: string;
  originalPrompt: string;
  onPlan: (originalPrompt: string, state: ComputerUseWindowState) => Promise<ComputerUseModelPlan>;
  onClose: () => void;
  onResult: (message: string) => void;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function stoppedDraft(kind: ComputerUseDraft["kind"]): ComputerUseDraft {
  if (kind === "type") return { kind: "type", elementToken: "", text: "" };
  if (kind === "scroll") return { kind: "scroll", elementToken: "", direction: "down", amount: 1 };
  if (kind === "key") return { kind: "key", elementToken: "", key: "escape" };
  return { kind: "click", elementToken: "" };
}

export function ComputerUsePanel({
  requestId,
  originalPrompt,
  onPlan,
  onClose,
  onResult,
}: ComputerUsePanelProps) {
  const bridge: ComputerUseBridge | undefined = getComputerUseBridge();
  const mountedRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const operationRef = useRef(0);
  const taskControllerRef = useRef<AbortController | null>(null);
  const [taskProgress, setTaskProgress] = useState<ComputerTaskProgress | null>(null);
  const [probe, setProbe] = useState<ComputerUseProbeResult | null>(null);
  const [windows, setWindows] = useState<ComputerUseWindow[]>([]);
  const [targetKey, setTargetKey] = useState("");
  const [state, setState] = useState<ComputerUseWindowState | null>(null);
  const [modelPlan, setModelPlan] = useState<ComputerUseModelPlan | null>(null);
  const [draft, setDraft] = useState<ComputerUseDraft>({ kind: "click", elementToken: "" });
  const [busy, setBusy] = useState<"probe" | "start" | "windows" | "observe" | "plan" | "confirm" | "verify" | "task" | "stop" | null>("probe");
  const [notice, setNotice] = useState("正在检查本机能力…");
  const [error, setError] = useState("");

  const target = windows.find((window) => `${window.pid}:${window.windowId}` === targetKey);
  const elements = useMemo(() => state ? actionableComputerElements(state) : [], [state]);
  const editableElements = useMemo(() => state ? editableComputerElements(state) : [], [state]);
  const plan = useMemo(() => state ? buildComputerUsePlan(state, draft) : null, [state, draft]);

  async function checkCapability() {
    const operation = ++operationRef.current;
    setBusy("probe");
    setProbe(null);
    setError("");
    setNotice("正在检查本机能力…");
    if (!bridge) {
      setBusy(null);
      setNotice("");
      setError("电脑控制只在安装版同频桌面端中提供；当前环境不会降级为网页模拟。");
      return;
    }
    try {
      const result = await bridge.probe();
      if (!mountedRef.current || operation !== operationRef.current) return;
      setProbe(result);
      setBusy(null);
      setNotice(result.available ? "能力检查通过。开始会话前，系统会再次向你确认。" : result.message);
    } catch (reason) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setBusy(null);
      setNotice("");
      setError(errorMessage(reason, "无法检查本机电脑控制能力"));
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void checkCapability();
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      sessionStartedRef.current = false;
      taskControllerRef.current?.abort();
      // stopSession waits for an in-flight start, so this also closes a native
      // session whose consent dialog resolves after the panel was unmounted.
      void bridge?.stopSession().catch(() => undefined);
    };
  }, [bridge, requestId]);

  useEffect(() => {
    const stopForTakeover = (event: KeyboardEvent) => {
      if (event.key === "Escape" && taskControllerRef.current) pauseTask();
    };
    const stopWhenHidden = () => {
      if (document.hidden && taskControllerRef.current) pauseTask();
    };
    document.addEventListener("keydown", stopForTakeover);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      document.removeEventListener("keydown", stopForTakeover);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [bridge]);

  function pauseTask() {
    taskControllerRef.current?.abort();
    void bridge?.stopSession().catch(() => undefined);
    setNotice("正在停止本机任务；已提交动作不会自动重试。");
  }

  async function executeTask() {
    if (!bridge || !state || !modelPlan || busy || taskControllerRef.current) return;
    const operation = operationRef.current;
    const controller = new AbortController();
    taskControllerRef.current = controller;
    setBusy("task");
    setError("");
    setTaskProgress(null);
    const result = await runComputerUseTask({
      bridge, goal: originalPrompt, initialState: state, initialPlan: modelPlan,
      planNext: onPlan, signal: controller.signal,
      onProgress: progress => {
        if (!mountedRef.current || operationRef.current !== operation) return;
        setTaskProgress(progress);
        setNotice(progress.summary);
      },
    });
    if (taskControllerRef.current === controller) taskControllerRef.current = null;
    if (!mountedRef.current || operationRef.current !== operation) return;
    sessionStartedRef.current = false;
    setBusy(null);
    setTaskProgress(null);
    setState(null);
    setModelPlan(null);
    setDraft({ kind: "click", elementToken: "" });
    setNotice(result.message);
    if (result.status === "failed" || result.status === "unknown") setError(result.message);
    onResult(result.message);
  }

  async function loadWindows(currentBridge: ComputerUseBridge) {
    setBusy("windows");
    setError("");
    const result = await currentBridge.listWindows();
    if (!mountedRef.current) return false;
    if (!result.ok) {
      setBusy(null);
      setError(result.error.message);
      return false;
    }
    setWindows(result.value.windows);
    setTargetKey((current) => result.value.windows.some(window => `${window.pid}:${window.windowId}` === current) ? current : "");
    setState(null);
    setModelPlan(null);
    setDraft({ kind: "click", elementToken: "" });
    setBusy(null);
    setNotice(result.value.windows.length ? "请选择一个精确窗口，然后读取有界快照。" : "当前没有可操作的屏幕窗口。可刷新后重试。");
    return true;
  }

  async function startSession() {
    if (!bridge || !probe?.available || busy) return;
    setBusy("start");
    setError("");
    setNotice("请在系统弹窗中确认是否开启本次只读观察会话…");
    try {
      const result = await bridge.startSession();
      if (!mountedRef.current) return;
      if (!result.ok) {
        setBusy(null);
        setError(result.error.message);
        setNotice("会话未开启，未读取任何窗口。");
        return;
      }
      sessionStartedRef.current = true;
      setNotice("本机会话已开启；尚未读取窗口。");
      await loadWindows(bridge);
    } catch (reason) {
      if (!mountedRef.current) return;
      setBusy(null);
      setError(errorMessage(reason, "本机操作会话启动失败"));
    }
  }

  async function observeTarget() {
    if (!bridge || !target || busy) return;
    setBusy("observe");
    setError("");
    setNotice("正在读取所选窗口的有界快照；其中内容只作为不可信观察数据。 ");
    try {
      const result = await bridge.getWindowState({ pid: target.pid, windowId: target.windowId });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setBusy(null);
        setState(null);
        setModelPlan(null);
        setError(result.error.message);
        return;
      }
      setState(result.value);
      setModelPlan(null);
      setDraft({ kind: "click", elementToken: "" });
      await requestModelPlan(result.value);
    } catch (reason) {
      if (!mountedRef.current) return;
      setBusy(null);
      setState(null);
      setModelPlan(null);
      setError(errorMessage(reason, "无法读取目标窗口"));
    }
  }

  async function requestModelPlan(snapshot: ComputerUseWindowState) {
    if (busy === "plan") return;
    setBusy("plan");
    setError("");
    setNotice("正在让同频 AI 基于最小化的不可信元素摘要规划 1 个动作；不上传截图、辅助树或字段值…");
    try {
      const proposed = await onPlan(originalPrompt, snapshot);
      if (!mountedRef.current) return;
      const validated = validateComputerUseModelPlan(proposed, originalPrompt, snapshot);
      if (!validated) throw new Error("同频 AI 返回的动作未通过本机安全校验，请重新读取后再试");
      setModelPlan(validated);
      setDraft(validated.action);
      setBusy(null);
      setNotice("同频 AI 已提出 1 个受限动作。你可以人工修正，然后再进入原生确认。");
    } catch (reason) {
      if (!mountedRef.current) return;
      setBusy(null);
      setModelPlan(null);
      setDraft({ kind: "click", elementToken: "" });
      setError(errorMessage(reason, "同频 AI 暂时无法生成安全动作"));
      setNotice("没有可执行方案，未打开原生确认，也未执行操作。");
    }
  }

  async function executePlan() {
    if (!bridge || !state || !plan || busy) return;
    const approvedPlan = plan;
    setBusy("confirm");
    setError("");
    setNotice("请在原生确认框中核对这一个动作；默认选择为取消。");
    try {
      const approval = await bridge.requestActionApproval(approvedPlan.action);
      if (!mountedRef.current) return;
      if (!approval.ok) {
        setBusy(null);
        setError(approval.error.message);
        setNotice("动作未执行。");
        return;
      }

      setBusy("verify");
      setNotice("一次性令牌已获确认，正在执行且不会自动重试…");
      const execution = await bridge.executeApprovedAction(approval.value.token);
      if (!mountedRef.current) return;
      const observed = await bridge.getWindowState(state.target);
      if (!mountedRef.current) return;
      const observedAfter = observed.ok;
      if (observed.ok) setState(observed.value);
      else setState(null);
      setModelPlan(null);
      setDraft(stoppedDraft(draft.kind));
      setBusy(null);

      const executionOk = execution.ok;
      const outcome = execution.ok
        ? execution.value.state === "delivered"
          ? "原生驱动已确认发送"
          : "原生驱动已发送，但效果无法完整验证"
        : execution.error.message;
      const message = computerUseResultMessage({
        plan: approvedPlan,
        executionOk,
        executionMessage: outcome,
        observedAfter,
      });
      setNotice(message);
      if (!executionOk || !observedAfter) setError(message);
      onResult(message);
    } catch (reason) {
      if (!mountedRef.current) return;
      setBusy(null);
      const message = `${approvedPlan.summary}：${errorMessage(reason, "本机操作失败")}。不会自动重试。`;
      setError(message);
      setNotice("本次动作未被确认完成。");
      onResult(message);
    }
  }

  async function closeSession() {
    taskControllerRef.current?.abort();
    if (!bridge) { onClose(); return; }
    operationRef.current += 1;
    setBusy("stop");
    sessionStartedRef.current = false;
    try {
      await bridge.stopSession();
    } finally {
      onClose();
    }
  }

  return (
    <section className="tp-ai-computer" aria-label="安全电脑控制" aria-busy={Boolean(busy)}>
      <header>
        <span><ShieldCheck size={18} />安全电脑控制</span>
        <button type="button" aria-label="关闭电脑控制并停止会话" onClick={() => void closeSession()} disabled={busy === "stop"}>
          {busy === "stop" ? <LoaderCircle size={16} className="is-spinning" /> : <X size={16} />}
        </button>
      </header>

      <p className="tp-ai-computer__boundary">仅在你选择的一个窗口中逐步单击、输入、有限滚动或按 Esc/方向键，最多 6 步、3 分钟，每步需系统确认，可按 Esc 暂停。不含回车、组合快捷键、Shell、文件或剪贴板权限。规划会消耗同频点；原始截图、辅助树和字段值不上传，只发送当前任务、窗口名称及最多 60 个控件标签。窗口内容不作为指令。</p>
      <p className="tp-ai-computer__goal"><strong>任务目标</strong> {originalPrompt}</p>
      {taskProgress ? <div className="tp-ai-computer__task-progress"><span><LoaderCircle size={15} className="is-spinning" />第 {taskProgress.step} / 6 步 · {taskProgress.phase === "awaiting_approval" ? "等待你确认" : taskProgress.phase === "planning" ? "规划下一步" : taskProgress.phase === "verifying" ? "核验结果" : "执行中"}</span><button type="button" onClick={pauseTask}><Pause size={15} />暂停任务</button></div> : null}
      {notice ? <p className="tp-ai-computer__notice" role="status">{notice}</p> : null}
      {error ? <p className="tp-ai-computer__error" role="alert">{error}</p> : null}

      {!bridge ? null : !probe ? (
        busy === "probe" ? <div className="tp-ai-computer__loading"><LoaderCircle size={17} className="is-spinning" />检查能力</div>
          : <button type="button" onClick={() => void checkCapability()}><RefreshCw size={16} />重新检查</button>
      ) : !probe.available ? (
        <>
        <dl className="tp-ai-computer__probe">
          <div><dt>系统</dt><dd>{probe.platform} / {probe.arch} / {probe.osVersion}</dd></div>
          <div><dt>辅助功能</dt><dd>{probe.permissions.accessibility}</dd></div>
          <div><dt>屏幕录制</dt><dd>{probe.permissions.screenRecording}</dd></div>
        </dl>
        <button type="button" onClick={() => void checkCapability()} disabled={Boolean(busy)}><RefreshCw size={16} />重新检查</button>
        </>
      ) : !sessionStartedRef.current ? (
        <button type="button" className="tp-ai-computer__primary" onClick={() => void startSession()} disabled={Boolean(busy)}>
          {busy === "start" ? <LoaderCircle size={17} className="is-spinning" /> : <MonitorUp size={17} />}
          在系统弹窗中开启本次会话
        </button>
      ) : (
        <>
          <div className="tp-ai-computer__target">
            <label>目标窗口
              <select value={targetKey} disabled={Boolean(busy)} onChange={(event) => { setTargetKey(event.target.value); setState(null); setDraft({ kind: "click", elementToken: "" }); }}>
                <option value="">请选择窗口</option>
                {windows.map(window => <option key={`${window.pid}:${window.windowId}`} value={`${window.pid}:${window.windowId}`}>{window.appName} — {window.title}</option>)}
              </select>
            </label>
            <button type="button" title="刷新窗口列表" aria-label="刷新窗口列表" disabled={Boolean(busy)} onClick={() => void loadWindows(bridge)}>
              {busy === "windows" ? <LoaderCircle size={16} className="is-spinning" /> : <RefreshCw size={16} />}
            </button>
            <button type="button" disabled={!target || Boolean(busy)} onClick={() => void observeTarget()}>
              {busy === "observe" ? <LoaderCircle size={16} className="is-spinning" /> : <Eye size={16} />}读取此窗口
            </button>
          </div>

          {state ? <div className="tp-ai-computer__state">
            <div className="tp-ai-computer__snapshot">
              {state.screenshot ? <img src={`data:${state.screenshot.mimeType};base64,${state.screenshot.dataBase64}`} alt={`${state.appName} — ${state.windowTitle} 的当前窗口快照`} /> : <p>当前没有可显示的窗口图像。</p>}
              <small>{state.degraded || state.truncated ? "快照不完整，操作会失败关闭或要求重新读取。" : "有界快照仅保存在当前界面内存中。"}</small>
            </div>

            {modelPlan ? <fieldset className="tp-ai-computer__actions" disabled={Boolean(busy)}>
              <legend>同频 AI 任务</legend>
              <div className="tp-ai-computer__model-plan"><strong>同频 AI 方案</strong><p>{modelPlan.summary}</p></div>
              <button type="button" className="tp-ai-computer__primary" disabled={Boolean(busy)} onClick={() => void executeTask()}><ShieldCheck size={17} />开始逐步执行并核验</button>
              <details><summary>高级：查看或修正单步操作</summary>
              <div className="tp-ai-computer__kind">
                <button type="button" className={draft.kind === "click" ? "is-active" : ""} onClick={() => setDraft({ kind: "click", elementToken: "" })}><MousePointer2 size={15} />单击控件</button>
                <button type="button" className={draft.kind === "type" ? "is-active" : ""} onClick={() => setDraft({ kind: "type", elementToken: "", text: "" })}><Keyboard size={15} />输入文字</button>
                <button type="button" className={draft.kind === "scroll" ? "is-active" : ""} onClick={() => setDraft({ kind: "scroll", elementToken: "", direction: "down", amount: 1 })}>滚动控件</button>
                <button type="button" className={draft.kind === "key" ? "is-active" : ""} onClick={() => setDraft({ kind: "key", elementToken: "", key: "escape" })}>安全按键</button>
              </div>
              {draft.kind === "click" ? <label>精确控件
                <select value={draft.elementToken} onChange={event => setDraft({ kind: "click", elementToken: event.target.value })}>
                  <option value="">选择快照中的控件</option>
                  {elements.map(element => <option key={element.elementToken} value={element.elementToken}>{element.label} · {element.role}</option>)}
                </select>
              </label> : draft.kind === "type" ? <div className="tp-ai-computer__type-fields">
                <label>精确可编辑控件
                  <select value={draft.elementToken} onChange={event => setDraft({ ...draft, elementToken: event.target.value })}>
                    <option value="">选择快照中的输入框</option>
                    {editableElements.map(element => <option key={element.elementToken} value={element.elementToken}>{element.label} · {element.role}</option>)}
                  </select>
                </label>
                <label>输入内容（最多 200 字，不允许换行）
                  <textarea rows={2} maxLength={200} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value.replace(/[\r\n]/g, "") })} />
                  <small>只会定向写入上面所选控件，不使用未知当前焦点。请勿输入密码、验证码、API 密钥或其他敏感信息。聊天和执行结果只记录字符数，但 AI 规划时仍需处理你的当前请求。</small>
                </label>
              </div> : <div className="tp-ai-computer__type-fields">
                <label>精确控件
                  <select value={draft.elementToken} onChange={event => setDraft({ ...draft, elementToken: event.target.value })}>
                    <option value="">选择快照中的控件</option>
                    {elements.map(element => <option key={element.elementToken} value={element.elementToken}>{element.label} · {element.role}</option>)}
                  </select>
                </label>
                {draft.kind === "scroll" ? <>
                  <label>方向<select value={draft.direction} onChange={event => setDraft({ ...draft, direction: event.target.value as "up" | "down" | "left" | "right" })}>
                    <option value="up">上</option><option value="down">下</option><option value="left">左</option><option value="right">右</option>
                  </select></label>
                  <label>幅度<select value={draft.amount} onChange={event => setDraft({ ...draft, amount: Number(event.target.value) as 1 | 2 | 3 })}>
                    <option value={1}>1 格</option><option value={2}>2 格</option><option value={3}>3 格</option>
                  </select></label>
                </> : <label>按键<select value={draft.key} onChange={event => setDraft({ ...draft, key: event.target.value as "escape" | "up" | "down" | "left" | "right" })}>
                  <option value="escape">Esc</option><option value="up">上方向键</option><option value="down">下方向键</option><option value="left">左方向键</option><option value="right">右方向键</option>
                </select></label>}
              </div>}
              {plan ? <div className="tp-ai-computer__plan"><strong>将只执行 1 个动作</strong><p>{plan.summary}</p><small>下一步会打开原生确认框；取消即不执行。</small></div> : <p className="tp-ai-computer__empty-plan">请选择完整的单动作，确认按钮才会启用。</p>}
              <button type="button" className="tp-ai-computer__primary" disabled={!plan || Boolean(busy)} onClick={() => void executePlan()}>
                {busy === "confirm" || busy === "verify" ? <LoaderCircle size={17} className="is-spinning" /> : <ShieldCheck size={17} />}
                在系统确认并执行这 1 个动作
              </button>
              </details>
            </fieldset> : <div className="tp-ai-computer__actions tp-ai-computer__replan">
              <strong>{busy === "plan" ? "同频 AI 正在规划…" : "当前没有通过校验的 AI 方案"}</strong>
              <button type="button" disabled={Boolean(busy)} onClick={() => void requestModelPlan(state)}>
                {busy === "plan" ? <LoaderCircle size={16} className="is-spinning" /> : <RefreshCw size={16} />}让同频 AI 基于此快照规划 1 个动作
              </button>
            </div>}
          </div> : null}
        </>
      )}
    </section>
  );
}
