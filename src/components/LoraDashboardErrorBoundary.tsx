import { Component, Fragment, type ErrorInfo, type PropsWithChildren } from "react";
import { Copy, RefreshCw } from "lucide-react";

interface State { failed: boolean; generation: number; diagnostic: string; copied: string }

/** Keep the app shell and other boss functions usable if this view fails. */
export class LoraDashboardErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = { failed: false, generation: 0, diagnostic: "", copied: "" };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[lora-dashboard] Render failed", error, info);
    const detail = error instanceof TypeError || error instanceof RangeError ? error.message.slice(0, 300) : error.name;
    this.setState({ diagnostic: [
      "LORA_VIEW_RENDER_FAILED", new Date().toISOString(),
      `Tongpin ${window.tongpin?.versions?.app ?? "web"}`,
      `${error.name}: ${detail}`, info.componentStack?.slice(0, 2000) ?? "",
    ].join("\n") });
  }

  private copyDiagnostic = async () => {
    try {
      await navigator.clipboard.writeText(this.state.diagnostic);
      this.setState({ copied: "故障信息已复制" });
    } catch {
      this.setState({ copied: "复制失败，请重试" });
    }
  };

  render() {
    if (!this.state.failed) return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
    return (
      <section className="lora-dashboard-page" role="alert">
        <h1>LORA 驾驶舱暂时无法显示</h1>
        <p>请重新加载驾驶舱，也可以从上方导航切换其他功能。</p>
        <div>
          <button className="primary-button" type="button" onClick={() => this.setState(state => ({
            failed: false, generation: state.generation + 1, diagnostic: "", copied: "",
          }))}><RefreshCw size={18} />重新加载驾驶舱</button>
          <button className="secondary-button" type="button" onClick={() => void this.copyDiagnostic()} disabled={!this.state.diagnostic}>
            <Copy size={18} />复制故障信息
          </button>
        </div>
        <p role="status">{this.state.copied}</p>
      </section>
    );
  }
}
