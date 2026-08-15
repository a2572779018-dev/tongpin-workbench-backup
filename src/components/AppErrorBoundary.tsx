import { Component, type ErrorInfo, type PropsWithChildren } from "react";
import { LogOut, RefreshCw, TriangleAlert } from "lucide-react";

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<
  PropsWithChildren,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[renderer] Unhandled render error", error, info);
  }

  private returnToLogin = async () => {
    try {
      if (window.tongpin) {
        await window.tongpin.session.clear();
      } else {
        localStorage.removeItem("tongpin.session.v1");
      }
    } finally {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="connectivity-page">
        <section className="connectivity-card" role="alert">
          <span className="connectivity-card__icon" aria-hidden="true">
            <TriangleAlert size={30} />
          </span>
          <h1>界面加载失败</h1>
          <p>账号资料存在旧版本数据，当前页面已停止加载。</p>
          <div>
            <button
              className="primary-button"
              type="button"
              onClick={() => window.location.reload()}
            >
              <RefreshCw size={18} />
              重新加载
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void this.returnToLogin()}
            >
              <LogOut size={18} />
              返回登录
            </button>
          </div>
        </section>
      </main>
    );
  }
}

