import { useEffect, useMemo, useRef } from "react";
import { Circle, Minus } from "lucide-react";
import loginBot from "../assets/tongpin-login-bot-simple.png";
import loginBotPrivacy from "../assets/tongpin-login-bot-privacy.png";
import {
  getAuthCompanionView,
  type AuthCompanionAction,
  type AuthCompanionField,
  type AuthCompanionMode,
} from "../lib/authCompanion";

export function AuthCompanion({
  mode,
  activeField,
  fieldLength,
  email,
  loading,
  error,
  notice,
  action,
}: {
  mode: AuthCompanionMode;
  activeField: AuthCompanionField;
  fieldLength: number;
  email: string;
  loading: boolean;
  error: string;
  notice: string;
  action: AuthCompanionAction;
}) {
  const motionRef = useRef<HTMLDivElement>(null);
  const view = useMemo(
    () =>
      getAuthCompanionView({
        mode,
        activeField,
        email,
        loading,
        error,
        notice,
        action,
      }),
    [action, activeField, email, error, loading, mode, notice],
  );

  useEffect(() => {
    const motion = motionRef.current;
    if (!motion) return;

    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let frame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;

    const setMotion = (
      x: number,
      y: number,
      rotateX: number,
      rotateY: number,
      eyeX: number,
      eyeY: number,
    ) => {
      motion.style.setProperty("--bot-x", `${x.toFixed(2)}px`);
      motion.style.setProperty("--bot-y", `${y.toFixed(2)}px`);
      motion.style.setProperty("--bot-rx", `${rotateX.toFixed(2)}deg`);
      motion.style.setProperty("--bot-ry", `${rotateY.toFixed(2)}deg`);
      motion.style.setProperty("--bot-eye-x", `${eyeX.toFixed(2)}px`);
      motion.style.setProperty("--bot-eye-y", `${eyeY.toFixed(2)}px`);
    };

    const resetMotion = () => setMotion(0, 0, 0, 0, 0, 0);

    if (reducedMotion.matches || !finePointer.matches || view.privateMode) {
      resetMotion();
      return;
    }

    if (activeField) {
      const progress = Math.min(Math.max(fieldLength / 24, 0), 1);
      const horizontal = -1 + progress * 2;
      setMotion(
        horizontal * 1.8,
        0,
        -3.5,
        horizontal * 5,
        horizontal * 5,
        3,
      );
      return;
    }

    const paint = () => {
      frame = 0;
      const rect = motion.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = Math.max(-1, Math.min(1, (pointerX - centerX) / 280));
      const dy = Math.max(-1, Math.min(1, (pointerY - centerY) / 220));
      setMotion(dx * 2.5, 0, -dy * 3.5, dx * 7, dx * 7, dy * 5);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };

    const handlePointerLeave = (event: PointerEvent) => {
      if (event.relatedTarget === null) resetMotion();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("pointerout", handlePointerLeave);
    window.addEventListener("blur", resetMotion);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerout", handlePointerLeave);
      window.removeEventListener("blur", resetMotion);
    };
  }, [activeField, fieldLength, view.privateMode]);

  return (
    <div
      className="auth-login-bot"
      data-mood={view.mood}
      data-action={action}
      data-private={view.privateMode ? "true" : "false"}
      aria-label="同频登录机器人"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {view.message}
      </span>

      <div className="auth-login-bot__motion" ref={motionRef}>
        <img
          className="auth-login-bot__base-pose"
          src={loginBot}
          alt=""
          draggable="false"
          aria-hidden="true"
        />
        <img
          className="auth-login-bot__privacy-pose"
          src={loginBotPrivacy}
          alt=""
          draggable="false"
          aria-hidden="true"
        />
        <div className="auth-login-bot__eyes" aria-hidden="true">
          <Circle size={15} strokeWidth={3} fill="currentColor" />
          <Circle size={15} strokeWidth={3} fill="currentColor" />
        </div>
        <Minus
          className="auth-login-bot__mouth"
          size={20}
          strokeWidth={3}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
