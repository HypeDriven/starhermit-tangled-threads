// Localization: the browser build's tables (src/strings.js: keyed strings in
// the nine StarHermit locales; the account strings in src/sh-i18n.js) in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replace the game's own
// Language setting (sh-language.js) and the DOM re-labelling (data-i18n):
// every string is drawn through T() each frame, so a change shows on the
// next frame and never restarts the round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { STRINGS } from "../src/strings.js";
import { shLocale, shText } from "../src/sh-i18n.js";

type Table = Record<string, string>;
const TABLES = STRINGS as unknown as Record<string, Table>;
const EN = TABLES["en-US"]!;
let locale = "";
let dict: Table = EN;

function apply(tag: string): void {
  const next = shLocale(String(tag || "en-US")) as string;
  const loc = TABLES[next] ? next : "en-US";
  if (loc === locale) return;
  locale = loc;
  dict = TABLES[loc]!;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
/** i18n.js t(): the key's string with {name} placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const s = dict[key] ?? EN[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : s;
}
/** The account strings (signIn, invite, copied, copyFail, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string { return shText(key, vars ?? {}, locale) as string; }
/** Rule-card markup ("<strong>Goal.</strong> Route…") as plain text: { head, body }. */
export function rich(key: string, vars?: Vars): { head: string; body: string } {
  const s = T(key, vars).replace(/<kbd>(.*?)<\/kbd>/g, "$1");
  const m = /^<strong>(.*?)<\/strong>\s*(.*)$/s.exec(s);
  const strip = (x: string): string => x.replace(/<[^>]+>/g, "");
  return m ? { head: strip(m[1]!), body: strip(m[2]!) } : { head: "", body: strip(s) };
}
/** i18n.js levelName: the display name of a level id. */
export function levelName(id: string): string {
  let m: RegExpExecArray | null;
  if (id === "tutorial") return T("lvlTutorial");
  if ((m = /^stage-(\d+)$/.exec(id))) return T("lvlStage", { n: m[1]! });
  if ((m = /^practice-(easy|medium|hard)$/.exec(id))) return T("lvlPractice", { level: T("diff" + m[1]![0]!.toUpperCase() + m[1]!.slice(1)) });
  if ((m = /^challenge-(\d+)$/.exec(id))) return T("lvlChallenge", { n: m[1]! });
  if ((m = /^daily-(.+)$/.exec(id))) return T("lvlDaily", { date: m[1]! });
  return id;
}
