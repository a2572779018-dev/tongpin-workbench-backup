import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  ApiRequestError,
  isNetworkUnavailable,
  publicRequest,
} from "../lib/api";
import { normalizeSession, normalizeUser } from "../lib/user";
import type { Session, User } from "../types";

const SESSION_KEY = "tongpin.session.v1";

interface AuthContextValue {
  loading: boolean;
  session: Session | null;
  startupError: string | null;
  login(
    email: string,
    password: string,
    rememberPassword?: boolean,
  ): Promise<void>;
  logout(): Promise<void>;
  retryStartup(): Promise<void>;
  api<T>(path: string, init?: RequestInit): Promise<T>;
  updateUser(user: User): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadPersistedSession(): Promise<Session | null> {
  try {
    const raw = window.tongpin
      ? await window.tongpin.session.load()
      : localStorage.getItem(SESSION_KEY);
    return raw ? normalizeSession(JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

async function persistSession(session: Session | null): Promise<void> {
  if (window.tongpin) {
    if (session) {
      await window.tongpin.session.save(JSON.stringify(session));
    } else {
      await window.tongpin.session.clear();
    }
    return;
  }
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [loading, setLoading] = useState(true);
  const [session, setSessionState] = useState<Session | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const refreshInFlight = useRef<Promise<Session | null> | null>(null);

  const setSession = useCallback(async (next: Session | null) => {
    await persistSession(next);
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const refresh = useCallback(async (): Promise<Session | null> => {
    const current = sessionRef.current;
    if (!current) return null;
    if (refreshInFlight.current) return refreshInFlight.current;

    refreshInFlight.current = publicRequest<Session>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    })
      .then(async (next) => {
        const normalized = normalizeSession(next);
        await setSession(normalized);
        return normalized;
      })
      .catch(async (error) => {
        if (isNetworkUnavailable(error)) throw error;
        await setSession(null);
        return null;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });

    return refreshInFlight.current;
  }, [setSession]);

  const api = useCallback(
    async function requestWithSession<T>(
      path: string,
      init: RequestInit = {},
    ): Promise<T> {
      let current = sessionRef.current;
      if (!current) {
        throw new ApiRequestError(401, "AUTH_REQUIRED", "请先登录");
      }

      try {
        return await publicRequest<T>(path, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${current.accessToken}`,
          },
        });
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 401) {
          throw error;
        }
        current = await refresh();
        if (!current) throw error;
        return publicRequest<T>(path, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${current.accessToken}`,
          },
        });
      }
    },
    [refresh],
  );

  const retryStartup = useCallback(async () => {
    setLoading(true);
    setStartupError(null);
    const saved = sessionRef.current ?? (await loadPersistedSession());
    sessionRef.current = saved;
    setSessionState(saved);
    try {
      if (!saved) return;
      try {
        const result = await publicRequest<{ user: User }>("/api/auth/me", {
          headers: { Authorization: `Bearer ${saved.accessToken}` },
        });
        await setSession({ ...saved, user: normalizeUser(result.user) });
      } catch (error) {
        if (isNetworkUnavailable(error)) throw error;
        await refresh();
      }
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        setStartupError(error.message);
        return;
      }
      await setSession(null);
    } finally {
      setLoading(false);
    }
  }, [refresh, setSession]);

  useEffect(() => {
    void retryStartup();
  }, [retryStartup]);

  const login = useCallback(
    async (
      email: string,
      password: string,
      rememberPassword = true,
    ) => {
      const next = await publicRequest<Session>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (window.tongpin?.credentials) {
        try {
          await window.tongpin.credentials.save({
            email,
            password,
            rememberPassword,
          });
        } catch {
          // 安全存储失败不能阻止用户登录，也绝不降级为明文保存。
        }
      }
      await setSession(normalizeSession(next));
    },
    [setSession],
  );

  const logout = useCallback(async () => {
    const current = sessionRef.current;
    if (window.tongpin?.relationshipGraph) {
      try {
        const flushed = await window.tongpin.relationshipGraph.flushCurrent();
        if (!flushed) return;
      } catch {
        return;
      }
    }
    if (current) {
      try {
        await publicRequest("/api/auth/logout", {
          method: "POST",
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
      } catch {
        // 即使服务器不可达，也必须清理本地会话。
      }
    }
    await setSession(null);
  }, [setSession]);

  const updateUser = useCallback(
    async (user: User) => {
      const current = sessionRef.current;
      if (!current) return;
      await setSession({ ...current, user: normalizeUser(user) });
    },
    [setSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      session,
      startupError,
      login,
      logout,
      retryStartup,
      api,
      updateUser,
    }),
    [
      api,
      loading,
      login,
      logout,
      retryStartup,
      session,
      startupError,
      updateUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return context;
}
