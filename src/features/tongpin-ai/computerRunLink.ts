import { createContext } from "react";

/**
 * The computer run a reply handed off to, while its details can be opened
 * beside the chat. The reply's "工具调用 · 电脑操作" row offers a link to them.
 */
export interface ComputerRunLink {
  /** The assistant message whose dispatch started the run. */
  messageId: string;
  running: boolean;
  open: () => void;
}

export const ComputerRunLinkContext = createContext<ComputerRunLink | null>(null);
