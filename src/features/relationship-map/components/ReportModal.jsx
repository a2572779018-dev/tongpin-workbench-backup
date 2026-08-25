import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import {
  CheckCircle,
  DownloadSimple,
  FileText,
  ShieldCheck,
  UsersThree,
  X,
} from "@phosphor-icons/react";

export function ReportModal({ people, connections, privacy, onClose, onExport }) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const contacts = people.filter((person) => person.id !== "self");
  const coreCount = contacts.filter((person) => person.level === "core").length;
  const mostActive = [...contacts].sort((a, b) => b.interactions - a.interactions)[0];
  const bridgePerson = [...contacts].sort((a, b) => b.mutual - a.mutual)[0];
  const weakCount = contacts.filter((person) => person.level === "weak").length;
  const shownName = (person) => privacy ? "一位联系人" : person?.name || "暂无人物";

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const context = gsap.context(() => {
      gsap.fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: reduceMotion ? 0 : 0.22 });
      gsap.fromTo(
        dialogRef.current,
        { y: 34, scale: 0.96, opacity: 0 },
        { y: 0, scale: 1, opacity: 1, duration: reduceMotion ? 0 : 0.4, ease: "back.out(1.35)" },
      );
    });

    return () => context.revert();
  }, []);

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialogRef} className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="report-header">
          <div className="report-title-wrap">
            <span className="report-icon"><FileText size={24} weight="duotone" /></span>
            <div>
              <p>演示分析</p>
              <h2 id="report-title">人物关系摘要</h2>
            </div>
          </div>
          <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭报告" autoFocus>
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="report-summary">
          <article>
            <UsersThree size={22} weight="duotone" />
            <strong>{people.length}</strong>
            <span>人物节点</span>
          </article>
          <article>
            <CheckCircle size={22} weight="duotone" />
            <strong>{coreCount}</strong>
            <span>核心关系</span>
          </article>
          <article>
            <ShieldCheck size={22} weight="duotone" />
            <strong>{connections.length}</strong>
            <span>关系连接</span>
          </article>
        </div>

        <div className="report-findings">
          <h3>本期关系信号</h3>
          <div className="finding-row">
            <span className="finding-index">01</span>
            <div>
              <strong>{shownName(mostActive)}是当前互动最活跃的人物</strong>
              <p>近 30 天记录 {mostActive?.interactions || 0} 次互动，可点击节点继续查看关系详情。</p>
            </div>
          </div>
          <div className="finding-row">
            <span className="finding-index">02</span>
            <div>
              <strong>{shownName(bridgePerson)}拥有较多共同联系人</strong>
              <p>共同联系人数量为 {bridgePerson?.mutual || 0}，可能是跨圈层的桥接人物。</p>
            </div>
          </div>
          <div className="finding-row">
            <span className="finding-index">03</span>
            <div>
              <strong>当前识别到 {weakCount} 位弱联系人物</strong>
              <p>可回到图谱筛选“弱联系”，再结合实际语境决定是否需要维护。</p>
            </div>
          </div>
        </div>

        <div className="report-privacy-note">
          <ShieldCheck size={18} weight="fill" />
          <span>
            {privacy
              ? "隐私模式已隐藏人物姓名；报告只在本机生成。"
              : "报告只在本机生成，不上传聊天或联系人数据。"}
          </span>
        </div>

        <div className="report-actions">
          <button className="secondary-button" type="button" onClick={onClose}>稍后查看</button>
          <button className="primary-button" type="button" onClick={onExport}>
            <DownloadSimple size={18} weight="bold" />导出报告
          </button>
        </div>
      </section>
    </div>
  );
}
