// Public surface of the AI-employee office visualization. Everything else in
// this directory (scene controller, seating/diff/visual-state logic, the
// procedural portrait engine, etc.) is an implementation detail — import it
// from here, not from the individual files, so the adapter that wires real
// Pro multi-agent run data in can depend on a small, stable surface.

export { AgentOfficeView, type AgentOfficeViewProps } from "./AgentOfficeView";
export { AgentOfficePanel, type AgentOfficePanelProps } from "./AgentOfficePanel";
export { AgentOfficeFallback, type AgentOfficeFallbackProps } from "./AgentOfficeFallback";
export type {
  AgentOfficePhase,
  AgentOfficeSnapshot,
  AgentOfficeStatus,
  AgentOfficeWorker,
} from "./types";
