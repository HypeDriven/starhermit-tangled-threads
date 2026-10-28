// The look of the HUD pills, the action tray, the board mirror, the hint bar
// and the screens: the browser build's index.html <style>, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (scroll bars, focus rings, selects) take.
// The runtime's high contrast option is the old body.high-contrast tokens.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#2b2320", panel: "#140e0ad1", "panel-border": "#6b5540", text: "#f5efe6", accent: "#e8b54a",
  "accent-text": "#241d18", pill: "#3a2f28", focus: "#ffffff", head: "#ffe9c0", secondary: "#6f6a63",
};
/** body.high-contrast. */
const CONTRAST: Tokens = { bg: "#000000", panel: "#000000", text: "#ffffff", accent: "#ffd700", pill: "#111111", "panel-border": "#ffffff" };

let current: Tokens = { ...BASE };
let key = "";
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "system-ui" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 26, padding: 8, spacing: 8, radius: 10,
    text: BASE.text!, muted: BASE.text!, panel: "#140e0a", control: BASE.pill!, hovered: "#4a3d34",
    pressed: "#56473c", field: BASE.pill!, accent: BASE.accent!, focus: BASE.focus!, outline: BASE["panel-border"]!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$head" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$panel-border", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$text" }, radius: 6, padding: 6 },
    // .screen: rgba(20, 14, 10, .45) behind every screen, the panels themselves are .panel
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#140e0a73" } } },
    // the title over the live board: darker in the centre (body.webgl-3d #scr-title)
    ".dlg-title": {
      background: "#00000000", padding: 0,
      parts: { backdrop: { background: { type: "radial", radius: { x: 0.6, y: 0.55 }, stops: ["#140e0ac7", "#140e0a66"] } } },
    },
    // the pause dialog left the board mirror hidden and the board dimmed; the results too
  });
  key = "";
  applyTokens(false);
}

/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({
    text: current.text!, muted: current.text!, control: current.pill!, field: current.pill!,
    accent: current.accent!, focus: current.focus!, outline: current["panel-border"]!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
