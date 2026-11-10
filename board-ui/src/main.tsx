import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/styles.css";
// After the scaffold styles: the Board tokens and shell win where they overlap.
import "./app/board.css";
import { applyTheme, resolveInitialTheme } from "./lib/theme";

applyTheme(resolveInitialTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
