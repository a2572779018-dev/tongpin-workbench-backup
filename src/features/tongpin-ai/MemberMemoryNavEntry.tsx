import { Brain } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import type { User } from "../../types";
import { MEMBER_MEMORY_OPEN_EVENT, memberMemoryApi, setMemoryReviewSource } from "./memberMemoryClient";
import { MemberMemoryPanel } from "./MemberMemoryPanel";

/**
 * Sidebar entry for「AI 对你的了解」. It also hosts the panel for the
 * 「已更新记忆」reply badge, which opens it through a window event so the chat
 * components do not need new props.
 */
export function MemberMemoryNavEntry({ user, showLabel = true }: { user: User; showLabel?: boolean }) {
  const { api } = useAuth();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Reply badges read review status through this account-bound source.
  useEffect(() => {
    setMemoryReviewSource(user.id, memberMemoryApi(api, user.id).reviews);
    return () => setMemoryReviewSource(null);
  }, [api, user.id]);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(MEMBER_MEMORY_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(MEMBER_MEMORY_OPEN_EVENT, onOpen);
  }, []);
  return <>
    <button ref={triggerRef} type="button" className="tp-ai-memory-nav" title="AI 对你的了解" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Brain size={18} aria-hidden="true" />{showLabel ? <span>AI 对你的了解</span> : null}
    </button>
    {open ? <MemberMemoryPanel user={user} onClose={() => { setOpen(false); window.requestAnimationFrame(() => { if (triggerRef.current?.getClientRects().length) triggerRef.current.focus(); }); }} /> : null}
  </>;
}
