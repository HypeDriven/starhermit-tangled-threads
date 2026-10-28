# Tangled Threads — specification

Tangled Threads is a single-player routing puzzle on a cozy fiber-art worktable. You route coloured strands across a grid without crossings, then reel each one into the spool of its colour. It is a StarHermit engine **script game**: one package (`starhermit.txt`: `engine.version=1.22.0`, `engine.minor=23`, entry `native/main.ts`). The StarHermit client plays it natively, and browsers play it through the engine's web runtime (the loader `index.html` that `npm run package` writes).

## Rules (src/rules.js — pure, deterministic)

- A board is `cols × rows` cells. Each strand has an **anchor** (where its path starts) and a **spool** cell. A strand's path starts as `[anchor]`.
- **Extend** moves a strand's tip into an edge-adjacent cell that no strand occupies. A spool cell belonging to another, unreeled strand is blocked (`wrong-spool`). Strands never share or cross a cell.
- **Retract** pulls the tip back one cell. **Reel** is allowed when the tip rests on the strand's own spool, and the strand is then done.
- The board is complete when every strand is reeled. A Challenge also ends at its move limit (`move-limit`).
- Moves count extends and reels, but not retracts. Rejected actions count as invalid. Hints count as hints.
- **Score**, all integers:
  - completion = 1000 × reeled / strands;
  - efficiency = max(0, 500 − 25 × moves over par);
  - independence = max(0, 200 − 50 × hints);
  - discipline = max(0, 100 − 10 × invalid);
  - the total is their sum (at most 1800).
- Ties break on completion, then total, then fewer invalid actions, then elapsed time, then session id.
- Replays, state hashes, snapshots and validated commands live in src/session.js: undo by replay, a hint from the authored solution, and crash-recovery snapshots.

## Content (src/content.js)

Every level is generated deterministically from its id:

- `tutorial` (First Stitches, 3×3);
- `stage-1` to `stage-40` (Journey: size, strand count and path lengths grow by tier; every 8th stage is a mastery stage);
- `practice-easy|medium|hard`;
- `challenge-1` to `challenge-12` (move limit = par + 2);
- `daily-YYYY-MM-DD`.

The generator grows each solution path by a random walk from its spool, so a solution always exists. The validator replays that solution through the rules, and par is the solution's move count.

The generator shuffles with a random comparator. Its sort is therefore named (`v8Sort`: Chrome's binary-insertion sort, comparator call for comparator call, checked against recorded Chrome traces in tests/fixtures/chrome-sort.json). This makes every engine — natively, in browsers, in Node — generate the boards the browser build's players saw on a fresh page. Challenge 11 and a few Daily dates have no board under Chrome's sort in 64 salts, and the browser build threw on them. Those ids fall back to the first board that Node's sort (`v8RunSort`) gives.

There are five board themes (Walnut Worktable, Rosewood Studio, Sage Sunroom, Indigo Night, Birch Morning) and six strand colours, plus a colour-vision-safe palette (Okabe-Ito). The five lesson steps and five achievements are listed in content.js.

## Modes

- **Learn** — the First Stitches board with five lesson steps in the hint bar: select, extend, reach the spool, reel, then finish alone. Finishing it marks the tutorial done. Not ranked.
- **Journey** — 40 stages, picked from a list that shows each stage's best score. **Next** on the results starts the following stage. Ranked.
- **Daily** — one board per UTC day. The date comes from the platform clock (`serverNow`), or the device clock when offline. Undo is not available. Ranked.
- **Practice** — easy, medium or hard. Undo is allowed. Not ranked.
- **Challenge** — 12 boards with tight move limits. Ranked.

## Screens and layout (native/screens.ts, starhermit:ui)

The board is always visible behind the UI. The HUD's window rectangles are passed to the renderer, which frames the board in the space left free with a view offset (render.js `applyPlayFrame`, unchanged).

- **Title** — over the live board: a demo board mid-solve under a darkened radial scrim, with a slow camera drift. It shows the title, the tagline, and the **Play**, **Help** and **Settings** buttons. Guests see **Sign in with StarHermit**; signed-in players see **Invite a friend** when there is a link. Below these come Journey progress (or the intro line) and, when signed in, the player's name with the cloud-sync state.
- **Choose a mode** — five mode cards in auto-fit columns. Picking one opens its detail panel: name and info, then **Start** and **Back** (Learn, Daily) or **Back** and the level list (Journey, Practice, Challenge). The panel scrolls into view. Escape returns to the title.
- **Play**:
  - The HUD pills (level, Reeled n/N, Moves n (par p) or Moves n/limit, timer) are centred at the top and wrap into rows.
  - The **board mirror** sits at the top left (top right when left-handed). Each cell is a button named as the old aria-labels named it, for example "Strand 1 tip, on its spool, row 3 column 1" or "Empty cell, row 2 column 3", and draws as the old mirror did, including the keyboard cursor's dashed ring.
  - The **action tray** holds Reel (R), Undo (U), Hint (H) and Pause (Esc), reversed when left-handed. It sits above the hint bar, or forms a column at the right on short landscape screens. On phones its buttons share the width and wrap their labels.
  - The **hint bar** shows lesson text, hints and rule explanations. It sits at the bottom, or at the top on short landscape screens.
- **Pause** (Escape, the tray, or a hidden window) — Resume, Restart, Leave round. It also holds the game's settings:
  - Colour-vision-safe palette, Left-handed controls, Tutorial (Replay tutorial);
  - a note that volumes, graphics, language, larger text, high contrast, reduced motion and vibration are in the StarHermit Options, with **Open Options** and **Key bindings** buttons.
  - Opened from the title as **Settings**, it has **Back** only.
- **Results** — Board complete! or Out of moves, then the summary line (level · moves (par) · hints · seconds), the score breakdown table, and the leaderboard line or "Offline — score kept locally" (ranked, signed out). Unlocked achievements follow, then **Next**, **Retry** and **Home**.
- **Help** — the five rule cards and the keyboard card, built from the current bindings. **Close** returns.

Layouts follow the old media queries:

- phone: at most 480 px wide (26 px mirror cells, tighter tray);
- short landscape: wider than tall and at most 500 px tall (tray column, hint bar at the top);
- the HUD pill text scales between 13.6 and 16.8 px.

Toasts (sign-out, invite copied) show at the bottom, or at the top over a screen.

## Controls

| Action | Keys (default) | Gamepad | Pointer / touch |
|---|---|---|---|
| Cursor left/right/up/down | Arrows | D-pad, left stick | — |
| Select / extend at the cursor | Enter, Space | South | Tap or click a strand to select it. Tap a free neighbouring cell, or drag through cells, to extend. |
| Reel | R | East | Tap the strand's spool when the tip is on it |
| Undo | U | West | Undo (U) button |
| Hint | H | North | Hint (H) button |
| Pause / back | Escape | Start | Pause (Esc) button |
| Reset camera | C | Right stick press | — |

- Tapping the cell behind the tip pulls the strand back. Reaching for another strand switches the selection, and that is not a foul.
- With the mouse, hovering shows the ghost bead on the cell under the pointer: legal targets are opaque, others faint.
- Presses on UI widgets never reach the board (`ui.pointerCaptured()`).
- Players rebind keys and pads in the runtime's Options. Tab moves the UI focus, so the mirror cells and buttons are reachable by keyboard.
- Extending vibrates for 12 ms and reeling for 70 ms (`vibrate`, which the runtime's vibration setting governs).

## Look (native/render.ts, starhermit:scene) and sound (native/audio.ts)

The scene is the browser build's three.js r185 scene, ported almost line for line:

- the camera: 42°, pulled back 1.45× in portrait;
- the table, felt pad and checkered cells (bevelled when detailed);
- the spools: lathe-turned bobbins with wound thread and a label disc when detailed, cylinders when plain;
- each strand: an anchor bead, a yarn tube (Catmull-Rom tube with a stretched twist texture) and an emissive tip bead, lifted when selected, with the breathing selection ring;
- the props: needle cushion; pins, brass thimble, yarn ball and the running stitch when detailed;
- dust motes, reel sparks (over-bright, so they bloom), the event shake and the title drift.

At minor 23 the engine follows three r185:

- light intensities are the old page's (key 2.4, rim 0.45, hemisphere 0.85 / 0.5 and ambient 0.25 / 0.08 without / with reflections, no ÷π);
- the key light's shadow uses the old shadow camera (fitShadow: a square box half the board plus 2.2, near 4, far 26), bias −0.0004, normal bias 0.02, radius 3 and PCF;
- reflections are the old page's PMREM RoomEnvironment (sigma 0.04) as `scene.environment` at `environmentIntensity` 0.42. r185's `RoomEnvironment()` is the 900-candela room lowered 3.5, so the port passes the renderer and sets `position.y = -3.5`.

ACES tone mapping runs at exposure 1.05. The procedural textures are baked from render.js's own noise into assets/tex (`npm run textures`) at each texture budget.

Quality follows the runtime's tier (`frame().quality`, native/quality.ts = src/gfx.js TABLE/BUDGETS):

| Tier | Shadows | AO | Bloom | Grade | Antialiasing | Reflections | Detail | Particles | Shading |
|---|---|---|---|---|---|---|---|---|---|
| Low | none | off | off | off | MSAA | off | plain | low | Lambert |
| Balanced | 1024 | off | on | on | FXAA | on | detailed | low | Standard |
| High | 2048 | on | on | on | SMAA | on | detailed | high | Physical |
| Ultra | 4096 | high | on | on | MSAA | on | detailed | high | Physical |

- Bloom is 0.5 / 0.45 / threshold 0.88.
- GTAO uses radius 0.5 and 8/16 samples.
- The grade is the old display-space S-curve and tints with a vignette.
- Sparks and motes scale within a tier by `levelIndex` (at most 2×).
- Ambient motion (lamp shimmer, ring breathing, spool pulse, motes, the title drift) runs from Balanced up, unless reduced motion is on.
- The runtime owns render scale, adaptive resolution, the frame-rate limit and its readout.

Sound:

- The authored one-shots in sfx/ map to events per sfx/manifest.json (select, deselect, extend, retract, invalid, reel, complete, fail, uiClick), and each event picks a clip with the old seeded stream.
- The ambience (82 + 123.5 Hz sines with a slow sway) is rendered into a seamless 14-second loop on the music bus at the old ambience-to-music ratio.
- The music stem (pentatonic plucks) runs on the old timer and gets denser as strands are reeled.
- The runtime owns the volumes and the mute.

## Platform (native/platform.ts)

- **Save**: the engine save (schema 1, on the device and in the cloud slot) is `{ v, progress, tutorialDone }` (src/save.js).
  - Two devices' saves merge as the browser build merged them: best score per board, union of days played, earliest unlock per achievement.
  - The browser build's cloud slot (game:<slug>, `{ v, data: { settings, progress }, check }`, djb2 checksum) shows as a foreign save. It is merged in once and replaced, and its palette and handedness options are adopted.
  - The old settings KV keys (volumes, graphics, reduced motion, high contrast, colour-vision palette, larger text, left-handed, haptics, tutorialDone) are read once and then removed: the palette, handedness and tutorial flag carry over, and the rest are runtime Options now.
- **Interrupted round**: a snapshot of the round in progress is kept in device storage (`tt-session-v1`, as before). Starting the game restores it straight into play with "Round restored".
- **Options**: the colour-vision-safe palette and the left-handed tray are engine settings, synced with the account.
- **Scores**: a finished ranked round (Journey, Daily, Challenge) posts its total to the `high-score` board through score-script.js when signed in. The client opens a practice session and sends `{ type: 'result', scores }`; the script range-checks the score (0–1800) and posts it. The results then show the rank. Solo scores are client totals range-checked by the script, as before (user decision). Achievements and progress are local and cloud-saved, as before.
- **Other**: sign-in request, invite link (copied to the clipboard) and the sign-out toast.

## Checks

- `npm run test:unit` — node:test:
  - the rules, content and session tests (tests/rules.test.js);
  - the save model, the foreign slot and the generator's sort against Chrome's traces, with every level id and ten years of Dailies generating and validating (tests/save.test.mjs);
  - every client string in all nine locales with matching placeholders (tests/i18n.test.mjs);
  - the dev server (tests/server.test.mjs).
- `npm run test:native` (tests/native.mjs):
  - the web index is up to date, tsc passes, and `starhermit check .` has zero warnings;
  - the play scripts from `npm run plays` (tools/gen-plays.mjs): Journey 1–2 by keyboard, Learn by finger on a DPR-3 phone, a Challenge lost at its limit, Practice sideways with undo, hint and the pause panel, and the menus (help, settings, Daily);
  - hand-measured board scripts: stage 1 by mouse drags and by finger swipes on the 3D board.
- `npm run test:browser` (tools/browser-play.mjs) plays the packaged loader in GPU Chrome:
  - desktop: stage 1 by mouse on the board, pause, stage 2 on the mirror;
  - phone at DPR 3: Learn on the mirror, then stage 1 by swipes;
  - landscape at DPR 3: Practice on the mirror.
- `npm run package` rewrites index.html and starhermit-files.json after every change.

## Known limitations

- The engine does not draw MeshPhysicalMaterial's sheen, so the yarn, felt and thread lose their grazing-angle fibre sheen on High/Ultra.
- The browser build's own Graphics tab (per-effect overrides, render scale, FPS meter) and its sound sliders are replaced by the runtime's Options.
- The haptics toggle is replaced by the runtime's vibration setting.
- Old browser-local (guest) progress in localStorage cannot migrate. Cloud saves do.
- Kept from the browser build:
  - undo replays the command log, so hints and invalid presses before an undo are forgotten (and score as unused);
  - the Daily's ranking is local only for guests.
- Chrome itself does not always run the old shuffle the same way in a long session (about 16% of boards in a loop of 4,000 generations came out differently from a fresh page), so a browser player may have seen a different board for a few Dailies. The port fixes the fresh-page boards for every engine.
- server.cjs is the old development server (static files and replay-validating /api routes). The client never calls it, and it is not in the package.
