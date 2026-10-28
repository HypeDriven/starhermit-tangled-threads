// The browser build's DOM shell (index.html + src/ui.js + the screens
// main.js built) as starhermit:ui, built every frame over the board: the HUD
// pills (level, reeled, moves against par or the limit, the timer; wrapping
// into rows as the old flex-wrap did), the hint bar (lesson text, hints and
// rule explanations), the action tray (Reel, Undo, Hint, Pause; reversed for
// left-handed play; a column at the right on short landscape screens), the
// board mirror (every cell a button named as the old aria-labels named it:
// screen readers, keyboard focus and play scripts use it; the keyboard
// cursor's dashed ring), the toasts, and the screens (title over the live
// board, modes with the stage / challenge / practice lists, pause with the
// game's settings, results, help). The old media queries are layouts picked
// by the window's logical size (phone ≤ 480 px wide, short landscape ≤ 500 px
// tall, wide ≥ 1024 px). The HUD's window rectangles go to render.ts, which
// frames the board in the space they leave.
import { frame, openMenu } from "starhermit:engine";
import { bindings, primaryPointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content } from "./game.ts";
import { S, T, levelName, rich } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import { token } from "./style.ts";
import {
  achievementName, app, closeHelp, doHint, doUndo, fresh, invite, later, leaveRound, nextLevel, onMirrorCell, pauseGame, reelSelected,
  restart, resultsHeadline, resumeGame, selectMode, showHelp, showModes, showSettings, showTitle, signIn, startDaily, startLevel,
} from "./main.ts";
import * as audio from "./audio.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; phone: boolean; land: boolean; wide: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, phone: lw <= 480, land: lw > lh && lh <= 500, wide: lw >= 1024 };
}
const lastSize = new Map<string, ui.Rect>();
let detailFrame = -100;
function textWidth(text: string, style: string, kind?: "button" | "heading", size?: number): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: size ? [style, { text: { size } }] : [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string, size?: number): void {
  if (!text) return;
  let u = size ? ui.style(cls, { text: { size } }) : ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls, undefined, size) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; silent?: boolean;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    // a label wider than its button wraps (labels don't)
    const inner = b.width - (style === "btn-small" ? 40 : 56);
    opts.content = () => { ui.style(style === "btn" ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) {
    later(() => { if (!b.silent) audio.play("uiClick"); b.act(); });
  }
}
/** .btnrow: buttons at their own widths in centred rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gap = 12, justify: "start" | "center" = "center"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button({ ...b, width: bw(b) });
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** .mode-grid > .mode-card: auto-fit columns of at least `min` px, each row as tall as its tallest card. */
interface Card { id: string; title: string; desc: string; name: string; act: () => void; selected?: boolean }
function gridCards(label: string, items: Card[], width: number, min: number, gap = 12): void {
  const cols = Math.max(1, Math.floor((width + gap) / (min + gap)));
  const cw = (width - (cols - 1) * gap) / cols;
  const faceW = cw - 34;
  const sc = ui.preferences().scale;
  ui.column(label, () => {
    for (let r = 0; r * cols < items.length; r++) {
      const row = items.slice(r * cols, (r + 1) * cols);
      const h = Math.max(44, ...row.map((c) => (lastSize.get(`${c.id}-face`)?.height ?? 0) / sc + 34));
      ui.row(`${label}-r${r}`, () => {
        for (const c of row) {
          button({
            id: c.id, text: c.title, name: c.name, style: "btn-card", width: cw, height: h, act: c.act, ...(c.selected !== undefined ? { selected: c.selected } : {}),
            content: () => {
              ui.column(`${c.id}-box`, () => {
                lastSize.set(`${c.id}-face`, ui.column(`${c.id}-face`, () => {
                  para(c.title, faceW, "mode-name");
                  para(c.desc, faceW, "mode-desc");
                }, { spacing: 6, width: faceW }));
              }, { width: faceW, height: h - 34, justify: "start" });
            },
          });
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const chrome = shell(L);
  render.setChrome(chrome);
  overlay(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the play shell: HUD, hint bar, tray, mirror
function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function shell(L: Layout): ui.Rect[] | null {
  const s = app.session;
  if (!s || app.overlay === "results" || app.overlay === "title" || app.overlay === "modes") return null;
  const st = s.state;
  const done = st.strands.filter((x) => x.done).length;
  const rects: ui.Rect[] = [];
  // #hud: pills centred at the top, wrapping
  const pillSize = Math.max(13.6, Math.min(16.8, 0.022 * L.lw));
  const pills = [
    levelName(s.level.id),
    T("hudReeled", { done, total: st.strands.length }),
    st.moveLimit != null ? T("hudMovesLimit", { moves: st.moves, limit: st.moveLimit }) : T("hudMovesPar", { moves: st.moves, par: st.par }),
    fmtTime(s.now()),
  ];
  const hudW = L.lw - 16;
  const rows: string[][] = [[]];
  let used = 0;
  for (const p of pills) {
    const w = textWidth(p, "pill-text", undefined, pillSize) + 34;
    if (rows[rows.length - 1]!.length && used + 8 + w > hudW) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 8 : 0) + w;
    rows[rows.length - 1]!.push(p);
  }
  ui.place("hud", { anchor: "top-start", x: 8, y: 8 }, () => {
    const r = ui.column("hud-col", () => {
      rows.forEach((row, ri) => ui.row(`hud-r${ri}`, () => {
        row.forEach((p, i) => ui.row(`hud-p${ri}-${i}`, () => { ui.style("pill-text", { text: { size: pillSize } }).id(`hud-${ri}-${i}`).label(p); }, { style: "pill" }));
      }, { spacing: 8, width: hudW, justify: "center" }));
    }, { spacing: 8, width: hudW });
    // the old #hud spans the window
    rects.push({ x: 0, y: 0, width: frame().width, height: r.y + r.height + 8 * L.sc });
  });

  // #hint-bar
  const hint = app.hintText ? app.hintText() : "";
  const hintW = Math.min(L.lw - 16, 600);
  let hintH = 0;
  if (hint) {
    const where = L.land ? { anchor: "top" as const, y: 48 } : { anchor: "bottom" as const, y: 8 };
    ui.place("hint-bar", where, () => {
      const r = ui.row("hint-pill", () => para(hint, hintW - 34, "hint-pill-text", "hint-text"), { style: "pill", justify: "center" });
      lastSize.set("hint", r);
    });
    hintH = L.land ? 0 : (lastSize.get("hint")?.height ?? 40 * L.sc) / L.sc;
  }

  // #action-tray
  const btns = [
    { id: "btn-reel", text: T("btnReel"), act: reelSelected },
    { id: "btn-undo", text: T("btnUndo"), act: doUndo },
    { id: "btn-hint", text: T("btnHint"), act: doHint },
    { id: "btn-pause", text: T("btnPause"), act: () => pauseGame("button") },
  ].map((b) => ({ ...b, style: "btn-small", silent: true, disabled: s.phase !== "active" }));
  if (platform.options.leftHanded) btns.reverse();
  const gap = L.phone ? 5.6 : 8;
  if (L.land) {
    const w = Math.max(...btns.map((b) => buttonWidth(b.text, "btn-small")));
    ui.place("tray", { anchor: "bottom-end", x: 8, y: 8 }, () => {
      const r = ui.column("tray-col", () => { for (const b of btns) button({ ...b, width: w }); }, { spacing: gap, width: w });
      rects.push(r);
    });
  } else {
    const avail = L.lw - (L.phone ? 12.8 : 16);
    const natural = btns.reduce((a, b) => a + buttonWidth(b.text, "btn-small"), 0) + gap * 3;
    const each = natural > avail ? (avail - gap * 3) / 4 : null;
    ui.place("tray", { anchor: "bottom", y: hintH + 9.6 }, () => {
      const r = ui.row("tray-row", () => { for (const b of btns) button({ ...b, ...(each ? { width: each } : {}) }); }, { spacing: gap, align: "end" });
      rects.push({ x: 0, y: r.y, width: frame().width, height: r.height });
    });
  }

  // #scr-board-mirror (active rounds only: it yields to the pause dialog)
  if (s.phase === "active" && app.overlay === null) rects.push(mirror(L));
  return rects;
}

/** ui.js renderDomBoard: the board as a grid of buttons (names, glyphs and colours as the old mirror). */
function mirror(L: Layout): ui.Rect {
  const s = app.session!;
  const st = s.state;
  const cvd = platform.options.cvdPalette;
  const cellPx = L.phone ? 26 : 30, gap = 3;
  const info = new Map<number, { strand?: number; tip?: boolean; anchor?: boolean; done?: boolean; spool?: number }>();
  st.strands.forEach((x, i) => {
    x.path.forEach((cell, k) => info.set(cell, { strand: i, tip: k === x.path.length - 1, anchor: k === 0, done: x.done }));
    if (!x.done) info.set(x.spool, { ...(info.get(x.spool) || {}), spool: i });
  });
  const hex = (i: number): string => "#" + (cvd ? Content.STRAND_COLORS_CVD : Content.STRAND_COLORS)[st.strands[i]!.color % 6]!.toString(16).padStart(6, "0");
  const ink = (h: string): string => {
    const n = parseInt(h.slice(1), 16);
    const lin = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return lum > 0.4 ? "#1a1310" : "#ffffff";
  };
  const right = platform.options.leftHanded;
  let rect: ui.Rect = { x: 0, y: 0, width: 0, height: 0 };
  ui.place("mirror", { anchor: right ? "top-end" : "top-start", x: 16, y: 80 }, () => {
    rect = ui.column("mirror-panel", () => {
      ui.style("mirror-cap").label(T("boardMirror"));
      ui.column("mirror-grid", () => {
        for (let r = 0; r < st.rows; r++) {
          ui.row(`mirror-r${r}`, () => {
            for (let c = 0; c < st.cols; c++) {
              const cell = r * st.cols + c;
              const inf = info.get(cell);
              const where = T("cellWhere", { row: r + 1, col: c + 1 });
              let label: string, fill = token("pill"), border = token("panel-border"), glyph = "", glyphColor = "#ffffff", fade = false, sel = false;
              if (inf && inf.strand !== undefined) {
                const h = hex(inf.strand);
                glyph = inf.tip ? (inf.spool !== undefined ? "◉" : "●") : "—";
                fill = h; border = h; glyphColor = ink(h); fade = !!inf.done;
                const part = T(inf.tip ? "partTip" : inf.anchor ? "partAnchor" : "partBody");
                const flags = (inf.done ? T("cellReeled") : "") + (inf.spool !== undefined ? T("cellOnSpool") : "");
                label = T("cellStrand", { n: inf.strand + 1, part, flags, where });
                sel = inf.strand === app.selection;
              } else if (inf && inf.spool !== undefined) {
                const h = hex(inf.spool);
                glyph = "◉"; border = h; glyphColor = h;
                label = T("cellEmptySpool", { n: inf.spool + 1, where });
                sel = inf.spool === app.selection;
              } else label = T("cellEmpty", { where });
              const cursor = cell === app.cursorCell;
              const res = ui.id(`cell-${cell}`).widget(label, {
                role: "button", size: { width: cellPx, height: cellPx },
                draw: (rc, ws) => {
                  const k = ws.scale, rad = 6.4 * k;
                  const a = fade ? "73" : "ff";
                  if (sel) draw.roundRect(rc.x - 3 * k, rc.y - 3 * k, rc.width + 6 * k, rc.height + 6 * k, rad + 3 * k, token("accent"));
                  draw.roundRect(rc.x, rc.y, rc.width, rc.height, rad, border + a);
                  draw.roundRect(rc.x + 2 * k, rc.y + 2 * k, rc.width - 4 * k, rc.height - 4 * k, Math.max(0, rad - 2 * k), fill + a);
                  if (glyph) draw.text(glyph, rc.x + rc.width / 2, rc.y + rc.height / 2 - 7 * k, { size: 12.8 * k, color: glyphColor, align: "center", weight: "bold" });
                  if (cursor) dashed(rc.x - 4 * k, rc.y - 4 * k, rc.width + 8 * k, rc.height + 8 * k, 3 * k, token("focus"));
                },
              });
              if (res.activated && fresh()) later(() => { ui.setFocus(null); onMirrorCell(cell); });
            }
          }, { spacing: gap });
        }
      }, { spacing: gap });
    }, { style: "mirror", spacing: 5.6, align: "center" });
  });
  return rect;
}
/** outline: 3px dashed (the keyboard cursor). */
function dashed(x: number, y: number, w: number, h: number, t: number, color: string): void {
  const dash = 3 * t, step = dash * 2;
  for (let i = 0; i < w; i += step) { const d = Math.min(dash, w - i); draw.rect(x + i, y, d, t, color); draw.rect(x + i, y + h - t, d, t, color); }
  for (let i = 0; i < h; i += step) { const d = Math.min(dash, h - i); draw.rect(x, y + i, t, d, color); draw.rect(x + w - t, y + i, t, d, color); }
}

// ------------------------------------------------------------------ toasts (#sh-toast)
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw * 0.92, 544);
  const where = app.overlay ? { anchor: "top" as const, y: 8 } : { anchor: "bottom" as const, y: 16 };
  ui.place("toast-stack", where, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text, w - 38, "toast-text", `toast-${i}-text`), { style: "toast" }));
    }, { spacing: 6, align: "center" });
  });
}

// ------------------------------------------------------------------ screens (.screen)
type Overlay = NonNullable<typeof app.overlay>;
function overlay(L: Layout): void {
  const o = app.overlay;
  if (!o) return;
  const pad = 16;
  const full = o === "title" || o === "modes";
  const panelW = Math.min(L.lw - 2 * pad, 736);
  const w = full ? L.lw - 2 * pad : panelW;
  const padIn = full ? 0 : (L.phone ? 16 : 24);
  const inner = w - 2 * padIn;
  const maxH = L.lh - 2 * pad;
  const key = `screen-${o}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc + 2 * (full ? 0 : 20) > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  // a mode picked: scroll its detail panel (Start / the level list) into view
  const detailAge = frame().frame - detailFrame;
  let scrollTo: { top: number } | undefined = opening && !app.focusNext && detailAge > 8 ? { top: 0 } : undefined;
  if (o === "modes" && detailAge >= 1 && detailAge <= 8) {
    const d = lastSize.get("mode-detail"), top = lastSize.get(key);
    if (d && top) scrollTo = { top: Math.max(0, (d.y - top.y) / L.sc - 8) };
  }
  const build = (): void => {
    ui.column("screen", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildScreen(o, iw, L), { spacing: 16, width: iw, align: full || o === "results" ? "center" : "start" })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + (full ? 0 : 6), height: maxH - (full ? 0 : 40) }, body, scrollTo ? { scrollTo } : undefined);
      else body();
    }, full ? { width: w, spacing: 0 } : { style: "panel", width: w, spacing: 0, padding: { top: 20, bottom: 20, start: padIn, end: padIn } });
  };
  const label = screenLabel(o);
  const isOpen = o === "title" ? ui.style("dlg-title").dialog(label, "", true, build) : ui.dialog(label, "", true, build);
  if (!isOpen && fresh()) {
    // Escape / the backdrop: pause resumes, help closes, modes go back to the title
    if (o === "pause") later(resumeGame);
    else if (o === "help") later(closeHelp);
    else if (o === "modes") later(showTitle);
  }
}
function screenLabel(o: Overlay): string {
  switch (o) {
    case "title": return "Tangled Threads";
    case "modes": return T("chooseMode");
    case "pause": return T("paused");
    case "results": return resultsHeadline();
    case "help": return T("howToPlay");
  }
}
function buildScreen(o: Overlay, w: number, L: Layout): void {
  switch (o) {
    case "title": titleScreen(w, L); break;
    case "modes": modesScreen(w, L); break;
    case "pause": pauseScreen(w); break;
    case "results": resultsScreen(w); break;
    case "help": helpScreen(w); break;
  }
}

function syncLabel(): string | null {
  switch (platform.syncState()) {
    case "synced": return T("syncSynced");
    case "saving": return T("syncSaving");
    case "offline": return T("syncOffline");
    case "error": return T("syncError");
    default: return null;
  }
}
function titleScreen(w: number, L: Layout): void {
  const size = L.land ? 28.8 : Math.max(32, Math.min(64, 0.07 * L.lw));
  const tw = Math.min(w, 600);
  ui.style("title-h", { text: { size, letterSpacing: size * 0.12 } }).id("title-h").label("Tangled Threads");
  para(T("tagline"), tw, "tagline", "title-tag");
  const row: Btn[] = [
    { id: "btn-play", text: T("play"), act: showModes },
    { id: "btn-title-help", text: T("help"), style: "btn-ghost", act: () => showHelp("title") },
    { id: "btn-title-settings", text: T("settings"), style: "btn-ghost", act: showSettings },
  ];
  if (!platform.signedIn()) row.push({ id: "btn-signin", text: S("signIn"), style: "btn-ghost", act: signIn });
  else if (platform.inviteLink()) row.push({ id: "btn-invite", text: S("invite"), style: "btn-ghost", act: invite });
  flow("title-row", row, w, 12);
  const done = Object.keys(platform.progress().stagesDone).length;
  para(done > 0 ? T("titleProgress", { done, total: Content.STAGE_COUNT }) : T("titleIntro"), tw, "tagline", "title-progress");
  if (platform.signedIn()) {
    const sync = syncLabel();
    const name = platform.displayName() || T("playerFallback", { id: "" }).trim();
    para(sync ? `${name} · ${sync}` : name, tw, "tagline", "player-line");
  }
}

const MODES: [string, string, string][] = [
  ["learn", "modeLearn", "modeLearnDesc"], ["journey", "modeJourney", "modeJourneyDesc"], ["daily", "modeDaily", "modeDailyDesc"],
  ["practice", "modePractice", "modePracticeDesc"], ["challenge", "modeChallenge", "modeChallengeDesc"],
];
const INFO: Record<string, [string, string]> = {
  learn: ["modeLearn", "infoLearn"], journey: ["modeJourney", "infoJourney"], daily: ["nameDaily", "infoDaily"],
  practice: ["modePractice", "infoPractice"], challenge: ["modeChallenge", "infoChallenge"],
};
function modesScreen(w: number, L: Layout): void {
  ui.style("h2c").id("modes-h").label(T("chooseMode"));
  const gw = Math.min(w, 1152);
  const items: Card[] = MODES.map(([id, name, desc]) => ({
    id: `mode-${id}`, title: T(name), desc: T(desc), name: `${T(name)}. ${T(desc)}`, selected: app.pendingMode === id,
    act: () => {
      selectMode(id);
      detailFrame = frame().frame;
      if (primaryPointer() !== "coarse") { app.focusNext = id === "learn" || id === "daily" ? "btn-mode-start" : firstLevel(id); app.openedFrame = frame().frame; }
    },
  }));
  gridCards("mode-grid", items, gw, L.phone ? 150 : 192);
  const m = app.pendingMode;
  if (!m) return;
  const pw = Math.min(w, 736);
  lastSize.set("mode-detail", ui.column("mode-detail", () => {
    const iw = pw - 48;
    para(T(INFO[m]![0]), iw, "h2", "mode-detail-name");
    para(T(INFO[m]![1]), iw, "tagline-l", "mode-detail-info");
    const ids = levelIds(m);
    if (!ids.length) {
      flow("mode-detail-row", [
        { id: "btn-mode-start", text: T("start"), act: () => (m === "learn" ? startLevel("tutorial") : startDaily()) },
        { id: "btn-mode-back", text: T("back"), style: "btn-secondary", act: showModes },
      ], iw, 12);
      return;
    }
    flow("mode-detail-row", [{ id: "btn-mode-back", text: T("back"), style: "btn-secondary", act: showModes }], iw, 12);
    const prog = platform.progress();
    const doneMap = m === "journey" ? prog.stagesDone : m === "challenge" ? prog.challengesDone : {};
    gridCards("journey-list", ids.map((id) => {
      const best = doneMap[id];
      const sub = best != null ? T("best", { n: best }) : m === "practice" ? T("freshBoard") : T("notCompleted");
      return { id: `lvl-${id}`, title: levelName(id), desc: sub, name: `${levelName(id)}, ${sub}`, act: () => startLevel(id) };
    }), iw, L.phone ? 130 : 192);
  }, { style: "panel", width: pw, spacing: 12, padding: { top: 20, bottom: 20, start: 24, end: 24 } }));
}
function levelIds(mode: string): string[] {
  const ids: string[] = [];
  if (mode === "journey") for (let n = 1; n <= Content.STAGE_COUNT; n++) ids.push(Content.stageId(n));
  if (mode === "challenge") for (let n = 1; n <= 12; n++) ids.push("challenge-" + n);
  if (mode === "practice") ids.push("practice-easy", "practice-medium", "practice-hard");
  return ids;
}
function firstLevel(mode: string): string { return `lvl-${levelIds(mode)[0]}`; }
/** A check box row (.setting-row; a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w - 60, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 44 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 6.4 * s, on ? "#a8d1ff" : token("pill"));
        draw.strokeRoundRect(bx, by, box, box, 6.4 * s, token("panel-border"), 1 * s);
        if (on) draw.text("✓", bx + box / 2, by + 6 * s, { size: 30 * s, color: "#2a2a2a", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { style: "setting-row", width: w, align: "center", spacing: 8 });
}
function settingRow(id: string, label: string, w: number, btn: Btn): void {
  ui.row(`${id}-row`, () => {
    const bw = Math.min(w * 0.55, buttonWidth(btn.text, btn.style ?? "btn"));
    para(label, w - bw - 16, "text", `${id}-label`);
    ui.spacer();
    button({ ...btn, width: bw });
  }, { style: "setting-row", width: w, align: "center", spacing: 8 });
}
function pauseScreen(w: number): void {
  const fromTitle = app.settingsFromTitle;
  para(fromTitle ? T("settings") : T("paused"), w, "h2", "pause-h");
  const row: Btn[] = [{ id: "btn-resume", text: fromTitle ? T("back") : T("resume"), act: resumeGame }];
  if (!fromTitle) {
    row.push({ id: "btn-restart", text: T("restart"), style: "btn-secondary", act: restart });
    row.push({ id: "btn-leave", text: T("leaveRound"), style: "btn-ghost", act: leaveRound });
  }
  flow("pause-row", row, w, 12);
  const o = platform.options;
  ui.column("settings-block", () => {
    toggleRow("chk-cvd", T("cvdPalette"), o.cvdPalette, w, (v) => platform.setOption("cvdPalette", v));
    toggleRow("chk-left", T("leftHanded"), o.leftHanded, w, (v) => platform.setOption("leftHanded", v));
    settingRow("tut", T("tutorial"), w, { id: "btn-replay-tut", text: T("replayTutorial"), style: "btn-secondary", act: () => startLevel("tutorial") });
    ui.column("runtime-opts", () => {
      para(T("optRuntime"), w, "dim", "opt-runtime");
      flow("runtime-row", [
        { id: "btn-options", text: T("openOptions"), style: "btn-ghost", act: () => openMenu() },
        { id: "btn-rebind", text: T("keyBindings"), style: "btn-ghost", act: () => requestRebind() },
      ], w, 12, "start");
    }, { spacing: 8, width: w, padding: { top: 8 } });
  }, { spacing: 0, width: w });
}
function scoreRow(id: string, k: string, v: number, w: number, total = false): void {
  ui.row(id, () => {
    ui.style(total ? "total-k" : "score-k").label(k);
    ui.spacer();
    ui.style(total ? "total-v" : "score-v").id(`${id}-v`).label(String(v));
  }, { style: "score-row", width: w, align: "center" });
}
function resultsScreen(w: number): void {
  const r = app.results, s = app.session;
  if (!r || !s) return;
  const score = s.state.terminal!.score;
  ui.row("results-h-row", () => { ui.style("h2c").id("results-h").label(resultsHeadline()); }, { width: w, justify: "center" });
  para(T("resultsSub", { name: levelName(s.level.id), moves: r.moves, par: s.level.par, hints: r.hints, secs: r.secs }), w, "tagline", "results-sub");
  ui.column("score-rows", () => {
    scoreRow("sc-completion", T("scCompletion"), score.completion, w);
    scoreRow("sc-efficiency", T("scEfficiency"), score.efficiency, w);
    scoreRow("sc-independence", T("scIndependence"), score.independence, w);
    scoreRow("sc-discipline", T("scDiscipline"), score.discipline, w);
    scoreRow("sc-total", T("scTotal"), score.total, w, true);
  }, { spacing: 0, width: w });
  if (r.compare) para(T("cmpOffline"), w, "tagline", "results-compare");
  if (r.lb) para(S(r.lb.key, r.lb.vars), w, "tagline", "results-lb");
  if (r.unlocked.length) para(T("achievementUnlocked", { list: r.unlocked.map(achievementName).join(", ") }), w, "tagline", "results-achievements");
  flow("results-row", [
    { id: "btn-next", text: T("next"), act: nextLevel },
    { id: "btn-retry", text: T("retry"), style: "btn-secondary", act: restart },
    { id: "btn-results-home", text: T("home"), style: "btn-ghost", act: showTitle },
  ], w, 12);
}

const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
function helpScreen(w: number): void {
  para(T("howToPlay"), w, "h2", "help-h");
  const cards = ["ruleGoal", "ruleNoCross", "ruleRouting", "ruleReeling", "ruleScoring"].map((k) => rich(k));
  cards.push(rich("keysHelp", {
    move: keysFor("left") + keysFor("right") + keysFor("up") + keysFor("down"), select: keysFor("select"), reel: keysFor("reel"),
    undo: keysFor("undo"), hint: keysFor("hint"), pause: keysFor("pause"), camera: keysFor("camera"),
  }));
  ui.column("rule-cards", () => {
    cards.forEach((c, i) => ui.column(`rule-${i}`, () => {
      if (c.head) para(c.head, w - 32, "card-h", `rule-${i}-h`);
      para(c.body, w - 32, "text", `rule-${i}-p`);
    }, { style: "rule-card", width: w, spacing: 4 }));
  }, { spacing: 8, width: w });
  ui.row("help-row", () => button({ id: "btn-help-close", text: T("close"), act: closeHelp }), { width: w, justify: "center" });
}
