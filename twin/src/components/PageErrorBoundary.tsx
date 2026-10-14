import { Component, Fragment, type PropsWithChildren } from "react";
import { Button } from "./Button";
import "./page-error.css";

/** Only owns a page subtree. Shell/navigation/store remain mounted on failure. */
export class PageErrorBoundary extends Component<
  PropsWithChildren,
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  private retry = () =>
    this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  render() {
    if (this.state.failed)
      return (
        <section className="page-error" role="alert" aria-label="页面加载失败">
          <h2>该页面加载失败</h2>
          <Button variant="primary" onClick={this.retry}>
            重试
          </Button>
        </section>
      );
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
