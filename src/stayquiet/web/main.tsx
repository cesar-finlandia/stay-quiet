// StayQuiet — browser entry point. Identity first, then the app.
//
// Stylesheet order is load-bearing:
//   1. the chassis token contract (defaults),
//   2. the StayQuiet identity, which re-points that contract at --sq-* values,
//   3. the motion vocabulary,
//   4. the component stylesheet, which also styles the three platform/ui
//      components through their public class hooks.
//
// The chassis's own themes (minimal/editorial/operator) are intentionally not
// loaded: StayQuiet ships one identity in two colour modes, and mixing the two
// axes would let a data-theme rule outrank the identity. See theme.ts.
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initColorMode } from "./theme.js";

import "src/platform/ui/tokens.css";
import "./design/tokens.css";
import "./design/motion.css";
import "./stayquiet.css";

initColorMode();

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
