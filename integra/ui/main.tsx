import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./kit.css";
import { isPageBoundary, Shell } from "./shell.tsx";

createRoot(document.getElementById("root")!, {
  // An error the shell's page boundary caught is reported by the boundary, as an uncaught error is (shell.tsx). React's
  // own console line for it would tell the Studio's check the same error a second time, in other words. An error some
  // other boundary caught is logged as React logs it.
  onCaughtError: (error, info) => {
    if (!isPageBoundary(info.errorBoundary)) console.error(error, info.componentStack);
  },
}).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
