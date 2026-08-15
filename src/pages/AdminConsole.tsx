import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleOff,
  Clock3,
  KeyRound,
  RefreshCw,
  Search,
  UserCog,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNoticeCenter } from "../components/NoticeCenter";
import { UserAvatar } from "../components/UserAvatar";
import { formatTime } from "../lib/date";
import { normalizeUser } from "../lib/user";
import type { User, UserRole, UserStatus } from "../types";

interface AdminUser extends User {
  taskCount: number;
}

type UserFilter = "all" | "pending" | "active" | "disabled";

const STATUS_COPY: Record<
  UserStatus,
  { label: string; className: string }
> = {
  pending_email: { label: "待验证邮箱", className: "is-muted" },
  pending_approval: { label: "待审核", className: "is-pending" },
  active: { label: "可进入", className: "is-active" },
  disabled: { label: "已停用", className: "is-disabled" },
};

export function AdminConsole() {
  const { session, api } = useAuth();
  const { notify } = useNoticeCenter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");
  const [jobDrafts, setJobDrafts] = useState<Record<string, string>>({});

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ users: AdminUser[] }>("/api/admin/users");
      setUsers(
        result.users.map((user) => ({
          ...normalizeUser(user),
          taskCount: Number.isFinite(user.taskCount) ? user.taskCount : 0,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const counts = useMemo(
    () => ({
      all: users.filter((user) => user.role !== "admin").length,
      pending: users.filter((user) => user.status === "pending_approval").length,
      active: users.filter(
        (user) => user.status === "active" && user.role !== "admin",
      ).length,
      bosses: users.filter(
        (user) => user.role === "boss" && user.status === "active",
      ).length,
      disabled: users.filter((user) => user.status === "disabled").length,
    }),
    [users],
  );

  const visibleUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return users.filter((user) => {
      const matchesFilter =
        filter === "all"
          ? true
          : filter === "pending"
            ? user.status === "pending_approval"
            : user.status === filter;
      const matchesQuery =
        !normalizedQuery ||
        (user.name ?? "").toLowerCase().includes(normalizedQuery) ||
        (user.email ?? "").toLowerCase().includes(normalizedQuery) ||
        (user.jobTitle ?? "").toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, users]);

  async function changeAccess(
    user: AdminUser,
    status: "active" | "disabled",
  ) {
    setWorkingId(user.id);
    setError("");
    try {
      const result = await api<{ user: User }>(
        `/api/admin/users/${user.id}/access`,
        {
          method: "PATCH",
          body: JSON.stringify({ status }),
        },
      );
      setUsers((current) =>
        current.map((item) =>
          item.id === user.id
            ? {
                ...normalizeUser({ ...item, ...result.user }),
                taskCount: item.taskCount,
              }
            : item,
        ),
      );
      notify({
        title: status === "active" ? "账号已启用" : "账号已停用",
        body:
          status === "active"
            ? `已允许 ${user.name} 使用同频。`
            : `${user.name} 的现有登录会话已撤销。`,
        tone: status === "active" ? "success" : "warning",
        duration: 7_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号状态更新失败");
    } finally {
      setWorkingId("");
    }
  }

  async function changeRole(user: AdminUser, role: Exclude<UserRole, "admin">) {
    setWorkingId(user.id);
    setError("");
    try {
      const result = await api<{ user: User }>(
        `/api/admin/users/${user.id}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({ role }),
        },
      );
      setUsers((current) =>
        current.map((item) =>
          item.id === user.id
            ? {
                ...normalizeUser({ ...item, ...result.user }),
                taskCount: item.taskCount,
              }
            : item,
        ),
      );
      notify({
        title: role === "boss" ? "老板权限已生效" : "成员权限已恢复",
        body:
          role === "boss"
            ? `${user.name} 下次登录可查看全员进度。`
            : `${user.name} 已恢复为普通成员。`,
        tone: "success",
        duration: 7_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "角色更新失败");
    } finally {
      setWorkingId("");
    }
  }

  async function saveJobTitle(user: AdminUser) {
    const currentJobTitle = user.jobTitle ?? "";
    const jobTitle = (jobDrafts[user.id] ?? currentJobTitle).trim();
    if (jobTitle === currentJobTitle) return;
    setWorkingId(user.id);
    setError("");
    try {
      const result = await api<{ user: User }>(
        `/api/admin/users/${user.id}/profile`,
        {
          method: "PATCH",
          body: JSON.stringify({ jobTitle }),
        },
      );
      setUsers((current) =>
        current.map((item) =>
          item.id === user.id
            ? {
                ...normalizeUser({ ...item, ...result.user }),
                taskCount: item.taskCount,
              }
            : item,
        ),
      );
      setJobDrafts((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      notify({
        title: "职位已更新",
        body: `${user.name} 的资料卡已同步。`,
        tone: "success",
        duration: 6_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "职位更新失败");
    } finally {
      setWorkingId("");
    }
  }

  return (
    <div className="admin-page">
      <section className="admin-hero bento-panel">
        <div>
          <h2>
            准入要严格，
            <span>角色要克制。</span>
          </h2>
        </div>
        <div className="admin-hero__symbol" aria-hidden="true">
          <div className="access-orbit">
            <span>
              <KeyRound size={38} />
            </span>
          </div>
        </div>
      </section>

      <section className="admin-stats" aria-label="账号统计">
        <article className="metric-tile tile-yellow">
          <span className="eyebrow">等待批准</span>
          <strong>{counts.pending}</strong>
        </article>
        <article className="metric-tile tile-blue">
          <span className="eyebrow">正常成员</span>
          <strong>{counts.active}</strong>
        </article>
        <article className="metric-tile tile-pink">
          <span className="eyebrow">老板角色</span>
          <strong>{counts.bosses}</strong>
        </article>
        <article className="metric-tile tile-green">
          <span className="eyebrow">已停用</span>
          <strong>{counts.disabled}</strong>
        </article>
      </section>

      <section className="account-registry">
        <header className="section-heading">
          <div>
            <h2>账号与权限</h2>
          </div>
          <div className="registry-tools">
            <label className="search-field">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索姓名或邮箱"
                aria-label="搜索账号"
              />
            </label>
            <button
              className="square-button"
              type="button"
              aria-label="刷新账号"
              onClick={() => void loadUsers()}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        <div className="filter-row" aria-label="筛选账号">
          {(
            [
              ["all", "全部", counts.all],
              ["pending", "待审核", counts.pending],
              ["active", "可进入", counts.active],
              ["disabled", "已停用", counts.disabled],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>

        {error && <div className="inline-error">{error}</div>}
        <div className="account-table bento-panel">
          <div className="account-table__head">
            <span>成员</span>
            <span>注册状态</span>
            <span>角色</span>
            <span>任务数</span>
            <span>操作</span>
          </div>

          {loading ? (
            Array.from({ length: 4 }, (_, index) => (
              <div className="account-row account-row--skeleton" key={index} />
            ))
          ) : visibleUsers.length === 0 ? (
            <div className="registry-empty">
              <UsersRound size={28} />
              <b>没有匹配的账号</b>
            </div>
          ) : (
            visibleUsers.map((user) => {
              const status = STATUS_COPY[user.status];
              const isProtected = user.role === "admin";
              return (
                <article className="account-row" key={user.id}>
                  <div className="account-person">
                    <UserAvatar user={user} className="square-avatar" />
                    <span>
                      <b>
                        {user.name}
                        {user.id === session!.user.id && <i>当前账号</i>}
                      </b>
                      <small>{user.email}</small>
                      {!isProtected && (
                        <label className="job-title-editor">
                          <input
                            value={jobDrafts[user.id] ?? user.jobTitle ?? ""}
                            onChange={(event) =>
                              setJobDrafts((current) => ({
                                ...current,
                                [user.id]: event.target.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveJobTitle(user);
                              }
                            }}
                            placeholder="填写职位"
                            maxLength={30}
                            disabled={workingId === user.id}
                            aria-label={`${user.name}的职位`}
                          />
                          <button
                            type="button"
                            disabled={
                              workingId === user.id ||
                              (
                                jobDrafts[user.id] ??
                                user.jobTitle ??
                                ""
                              ).trim() === (user.jobTitle ?? "")
                            }
                            onClick={() => void saveJobTitle(user)}
                          >
                            保存
                          </button>
                        </label>
                      )}
                      <em>注册于 {formatTime(user.createdAt)}</em>
                    </span>
                  </div>
                  <span className={`access-badge ${status.className}`}>
                    {user.status === "active" ? (
                      <Check size={13} />
                    ) : user.status === "disabled" ? (
                      <CircleOff size={13} />
                    ) : (
                      <Clock3 size={13} />
                    )}
                    {status.label}
                  </span>
                  <label className="role-select">
                    {isProtected ? (
                      <span>
                        <UserCog size={15} />
                        管理员
                      </span>
                    ) : (
                      <select
                        value={user.role}
                        aria-label={`${user.name}的角色`}
                        disabled={workingId === user.id}
                        onChange={(event) =>
                          void changeRole(
                            user,
                            event.target.value as "member" | "boss",
                          )
                        }
                      >
                        <option value="member">普通成员</option>
                        <option value="boss">老板</option>
                      </select>
                    )}
                  </label>
                  <span className="task-total">{user.taskCount}</span>
                  <div className="account-actions">
                    {isProtected ? (
                      <span className="protected-label">系统保护</span>
                    ) : user.status === "pending_approval" ? (
                      <>
                        <button
                          className="approve-button"
                          type="button"
                          disabled={workingId === user.id}
                          onClick={() => void changeAccess(user, "active")}
                        >
                          <UserRoundCheck size={15} />
                          允许进入
                        </button>
                        <button
                          className="reject-button"
                          type="button"
                          disabled={workingId === user.id}
                          onClick={() => void changeAccess(user, "disabled")}
                        >
                          拒绝
                        </button>
                      </>
                    ) : user.status === "active" ? (
                      <button
                        className="reject-button"
                        type="button"
                        disabled={workingId === user.id}
                        onClick={() => void changeAccess(user, "disabled")}
                      >
                        停用账号
                      </button>
                    ) : user.status === "disabled" ? (
                      <button
                        className="approve-button"
                        type="button"
                        disabled={workingId === user.id}
                        onClick={() => void changeAccess(user, "active")}
                      >
                        恢复进入
                      </button>
                    ) : (
                      <span className="protected-label">等待邮箱验证</span>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

