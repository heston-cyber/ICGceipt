import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { Logo } from "./Logo";
import "./styles.css";

// ICG's typeface (Degular) through an Adobe Fonts web project, when one is set. Falls back to the system font.
const kit = import.meta.env.VITE_TYPEKIT_ID as string | undefined;
if (kit) {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = `https://use.typekit.net/${kit}.css`;
  document.head.appendChild(l);
}

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <div className="screen center">
      <Logo />
      <p className="muted">Not connected to its backend yet.</p>
    </div>,
  );
} else {
  const convex = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
