import { useMemo } from "react";
import { BellRing, CheckCheck, X } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import type { BossWorkReportBundle, BossWorkReportSection } from "../types";
import {
  automaticWorkReportKind,
  automaticWorkReportLabel,
} from "../lib/workReportSchedule";

function readableDate(value: string) {
  const [, month, day] = value.split("-").map(Number);
  return `${month}月${day}日`;
}

function fullReadableDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function periodLabel(section: BossWorkReportSection) {
  if (section.period.startDate === section.period.endDate) {
    return fullReadableDate(section.period.startDate);
  }
  return `${readableDate(section.period.startDate)} — ${readableDate(section.period.endDate)}`;
}

function Donut({ value, label }: { value: number; label: string }) {
  const normalized = Math.max(0, Math.min(100, value));
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dash = (normalized / 100) * circumference;
  return (
    <div className="work-report-donut" aria-label={`${label} ${normalized}%`}>
      <svg viewBox="0 0 96 96" role="img">
        <circle className="work-report-donut__track" cx="48" cy="48" r={radius} />
        <circle
          className="work-report-donut__value"
          cx="48"
          cy="48"
          r={radius}
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      <span>
        <b>{normalized}%</b>
        <small>{label}</small>
      </span>
    </div>
  );
}

export function BossWorkReportModal({
  report,
  busy,
  error,
  onClose,
  onRead,
  onNudge,
  nudgingMemberId,
  nudgedMemberIds,
}: {
  report: BossWorkReportBundle;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRead: () => void;
  onNudge: (memberId: string) => void;
  nudgingMemberId: string;
  nudgedMemberIds: ReadonlySet<string>;
}) {
  const kind = automaticWorkReportKind(report.reportDate);
  const section = report[kind];
  const reportLabel = automaticWorkReportLabel(report.reportDate);
  const participation = section.summary.people
    ? Math.round((section.summary.activePeople / section.summary.people) * 100)
    : 0;
  const maxActivity = useMemo(
    () =>
      Math.max(
        1,
        ...section.members.map(
          (member) =>
            member.selfCreated + member.carriedOver + member.assigned + member.completed,
        ),
      ),
    [section.members],
  );

  return (
    <div className="work-report-layer">
      <div className="work-report-backdrop" />
      <section
        className="work-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-report-title"
      >
        <header className="work-report-header">
          <div>
            <span className="work-report-eyebrow">{reportLabel}</span>
            <h2 id="work-report-title">BOSS，早上好</h2>
            <p>
              以下是员工{kind === "daily" ? "昨日" : kind === "weekly" ? "上周" : "上月"}
              （{periodLabel(section)}）工作进度{kind === "daily" ? "汇报" : "总结"}
            </p>
          </div>
          <button
            className="work-report-close"
            type="button"
            aria-label="关闭并留存在铃铛"
            title="关闭并留存在铃铛"
            disabled={busy}
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>

        <div className="work-report-content">
          <section className="work-report-overview" aria-label="汇报总览">
            <div className="work-report-kpis">
              <article><span>员工新建</span><b>{section.summary.selfCreated}</b></article>
              <article><span>老板派发</span><b>{section.summary.assigned}</b></article>
              <article><span>完成工作</span><b>{section.summary.completed}</b></article>
              <article><span>进行中</span><b>{section.summary.doing}</b></article>
            </div>
            <div className="work-report-charts">
              <Donut value={section.summary.completionRate} label="计划完成率" />
              <Donut value={participation} label="员工参与率" />
            </div>
          </section>

          <section className="work-report-members" aria-label="员工工作明细">
            <div className="work-report-members__head">
              <b>员工工作进度</b>
              <span>{section.summary.people} 位员工</span>
            </div>
            {section.members.length === 0 ? (
              <div className="work-report-empty">暂无员工数据</div>
            ) : (
              <div className="work-report-member-list">
                {section.members.map((member) => {
                  const activity =
                    member.selfCreated +
                    member.carriedOver +
                    member.assigned +
                    member.completed;
                  return (
                    <article key={member.user.id} className="work-report-member">
                      <div className="work-report-member__person">
                        <UserAvatar user={member.user} className="work-report-avatar" />
                        <span><b>{member.user.name}</b><small>{member.user.jobTitle || "成员"}</small></span>
                      </div>
                      <div className="work-report-member__numbers">
                        <span>新建 <b>{member.selfCreated}</b></span>
                        <span>完成 <b>{member.completed}</b></span>
                        <span>进行中 <b>{member.doing}</b></span>
                      </div>
                      <div className="work-report-member__bar" aria-hidden="true">
                        <i style={{ width: `${Math.max(4, (activity / maxActivity) * 100)}%` }} />
                      </div>
                      <strong>{member.completionRate}%</strong>
                      <button
                        className="work-report-member__nudge"
                        type="button"
                        disabled={
                          nudgingMemberId === member.user.id ||
                          nudgedMemberIds.has(member.user.id)
                        }
                        onClick={() => onNudge(member.user.id)}
                      >
                        <BellRing size={15} />
                        {nudgingMemberId === member.user.id
                          ? "发送中"
                          : nudgedMemberIds.has(member.user.id)
                            ? "已催办"
                            : "催办"}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <footer className="work-report-footer">
          <span>{error || "关闭后会留存在铃铛中"}</span>
          <button type="button" disabled={busy} onClick={onRead}>
            <CheckCheck size={18} />
            {busy ? "正在确认…" : "我已阅读"}
          </button>
        </footer>
      </section>
    </div>
  );
}
