import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IS_HOSTED } from "./api";
import { hashForRepoPath } from "./hostedRepo";
// Fonts are self-hosted so the offline and demo builds ship them.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";

// The hosted build opens a repository at a path (/owner/repo) by moving it to the hash route before the router reads it.
if (IS_HOSTED) {
  const next = hashForRepoPath(window.location.pathname, window.location.hash);
  if (next !== undefined) window.history.replaceState(null, "", next);
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
