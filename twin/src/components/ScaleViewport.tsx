import type { PropsWithChildren } from "react";

import shell from "./DashboardShell.module.css";

export function ScaleViewport({ children }: PropsWithChildren) {
  // Layout now follows intrinsic CSS viewport dimensions; no resize scaling.

  return <div className={shell.viewport}>{children}</div>;
}
