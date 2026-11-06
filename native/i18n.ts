// Localization: the browser build's tables (keyed strings in the nine StarHermit
// locales) in assets/strings.json, on the engine's strings: the interface language
// the runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's), its locale chain, and the
// account lines the engine keeps (`starhermit.*`). Every string is drawn through
// T() each frame, so a change shows on the next frame and never restarts the round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** i18n.js t(): the key's string with {name} placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboardPosting, leaderboardRank, leaderboardPosted, leaderboardNotPosted). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
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
