import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";

interface RelationshipMapErrorBoundaryProps {
  children: ReactNode;
  onReturn: () => void;
  resetKey: string;
}

interface RelationshipMapErrorBoundaryState {
  failed: boolean;
}

export class RelationshipMapErrorBoundary extends Component<
  RelationshipMapErrorBoundaryProps,
  RelationshipMapErrorBoundaryState
> {
  state: RelationshipMapErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RelationshipMapErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Relationship map failed", error, info.componentStack);
  }

  componentDidUpdate(previous: RelationshipMapErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="relationship-map-error" role="alert">
        <AlertTriangle size={28} />
        <strong>关系图暂时无法打开</strong>
        <button type="button" onClick={this.props.onReturn}>
          <ArrowLeft size={17} />
          返回我的任务
        </button>
      </section>
    );
  }
}
