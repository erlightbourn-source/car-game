# 🚗 Zippy's Lane Dash

A bright, kid-friendly **first-person endless driving** game in the style of
Subway Surfers — but on the road. You look out down a road that recedes to the
horizon, and steer a cheerful cartoon car between **three lanes** to dodge the
"issues" rushing toward you: traffic cones, potholes, construction barriers, and
other cars — while scooping up coins to spend in the **Garage** on new car
colours, a coin magnet, and shields. Survive as long as you can while the speed
ramps up!

It now runs as a **real-time 3D game** (Three.js / WebGL): true perspective,
dynamic sun shadows, reflective car paint (image-based lighting), atmospheric
fog and a gradient sky dome. The pure game logic is unchanged and stays
renderer-agnostic, so it's still designed to port to native iOS — now mapping to
**SceneKit** (3D) rather than SpriteKit. See *Porting notes* below.

---

## 🌐 Public hosting (free) & security

The whole game is static files, so it hosts anywhere with no build step.

**Easiest — Netlify Drop (no account needed):**
1. Go to **https://app.netlify.com/drop**
2. Drag the **`car-game` folder** (or the `zippy-lane-dash.zip`) onto the page.
3. You get an instant public `*.netlify.app` URL. (Sign in free to keep/rename it.)

Other one-drag hosts that work the same way: **tiiny.host**, **GitHub Pages**
(drop the files in a repo), **Cloudflare Pages**.

**Security package (applied to the public site):**
- A strict **Content-Security-Policy** (`<meta>` in `index.html` + the `_headers`
  file): everything is locked to same-origin, no external/CDN scripts (Three.js is
  vendored), no inline `<script>`, no `eval`.
- `_headers` adds **X-Frame-Options: DENY**, **X-Content-Type-Options: nosniff**,
  **Referrer-Policy**, a restrictive **Permissions-Policy** (camera/mic/geo/… all
  off), **HSTS**, and cross-origin isolation headers. Netlify/Cloudflare apply
  `_headers` automatically; the CSP `<meta>` protects other hosts too.

## ▶️ How to open & play

**Easiest:** just double-click `index.html` — it runs straight in any modern
browser, no build step, no server required. (Three.js is **vendored locally** in
`js/vendor/`, so it works offline too; a WebGL-capable browser is required.)

**Or via a local server** (nice for mobile testing on the same Wi-Fi):

```bash
cd car-game
python3 -m http.server 4188
# then open http://localhost:4188
```

### Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Move left a lane  | `←` or `A` | Swipe left (or tap left side) |
| Move right a lane | `→` or `D` | Swipe right (or tap right side) |
| Start / restart   | `Space` / `Enter` / click **Play** | Tap |
| Mute / unmute     | `M` | Tap the 🔊 button |
| Close the Garage  | `Esc` | **Back** button |

The car snaps between the 3 lanes with a quick smooth tween — no free-roaming,
no jumping. Dodge everything; one hit ends the run (unless you have a shield).

### Coins & the Garage 🔧

- Grab the gold coins on the road — they bank automatically and persist between
  sessions.
- Open the **Garage** (from the start or game-over screen) to spend them:
  - **Car colours** — Ruby (free), Sky, Mint, Grape, Goldie. Buy once, then equip.
  - **🧲 Coin Magnet** (3 levels) — pulls coins in from neighbouring lanes.
  - **🛡️ Shield** (3 levels) — each level lets you absorb one crash per run and
    keep driving (with a brief flash of invulnerability).

---

## 🎮 What's implemented

- **True real-time 3D (Three.js / WebGL)** — a real perspective camera chases the
  car down an actual 3D road into the distance, with **dynamic sun shadows**,
  **reflective car paint & coins** (image-based lighting), **atmospheric fog**, a
  gradient **sky dome**, and tone-mapped HDR-style lighting.
- **Cinematic post-processing** — an `EffectComposer` pipeline adds **bloom**
  (glowing sun, brake lights, coins, lamps) and a gamma pass, topped with a CSS
  **vignette** for a filmic frame.
- **3D world** — detailed car (body, cabin, glass, **rolling rimmed wheels**, side
  mirrors, emissive brake lights), 3D cones/barriers/potholes/"issue" cars,
  spinning gold coins, and pooled roadside trees & lamp posts; **bump-mapped**
  asphalt & grass; everything casts/receives shadows.
- **Procedural textures** — asphalt grain + lane lines, grass, and hazard stripes
  are generated on canvases at runtime (no image files), and the road/grass
  textures **scroll** with travelled distance for motion.
- **Camera life** — the chase cam trails the car into turns, the body leans &
  bobs, and a subtle speed-shake kicks in at high speed.
- **Three lanes** with discrete, tweened lane changes.
- **Obstacles** (`cone`, `pothole`, `barrier`, `car`) spawn small at the horizon
  in random lanes and scale up as they rush toward you. Spawns are **guaranteed
  dodgeable** — single rows leave two lanes open, and double rows *always block
  only the two outer lanes* so the centre lane is reachable from anywhere.
- **Coins + Garage economy** — collect coins, then buy/equip car colours, a coin
  **magnet**, and **shields**. Coins, owned items, equipped car, upgrade levels
  and best score all **persist via `localStorage`** (safe in-memory fallback).
- **Endless difficulty ramp** — speed increases and spacing tightens as your
  score climbs; live **km/h speedometer** in the HUD.
- **Game states**: Start → Garage → Playing → Game Over, with friendly pop-in
  cards and a "Swipe or tap to play again" restart.
- **Juice & sound**: car leans into turns, dust on lane changes, coin sparkles,
  a shield bubble + whoomph, a crash burst, milestone dings, and a **live engine
  drone that pitches with your speed** — all behind a **mute toggle**.
- **Responsive** to desktop and mobile screen sizes (aspect-preserving canvas,
  retina-crisp via `devicePixelRatio`).
- **100% original art** — everything is drawn with Canvas paths; no external or
  copyrighted assets.

### Mobile hardening & 3D bug fixes (latest pass)

- **Mobile-safe rendering** — phones/tablets now auto-detect and run a lighter,
  more robust path: bloom post-processing **off**, antialiasing off, half-size
  shadow maps, and a capped pixel ratio. This prevents the GPU overload that can
  crash the WebGL context on mobile.
- **WebGL context-loss recovery** — if the GPU drops the context, the game catches
  it and reloads instead of showing a hard browser error; a per-frame render
  fallback drops bloom rather than crashing.
- **Graceful WebGL failure** — if 3D can't start at all, a friendly message shows
  instead of a blank/broken page.
- **No more pop-in** — fog was retuned so obstacles, coins and scenery now fade in
  through the haze at the horizon instead of appearing mid-road.
- **Tall-screen camera** — the field of view widens on portrait phone screens so
  side-lane obstacles stay visible as they approach.
- **Long-session stability** — scrolling road/grass textures are wrapped to avoid
  float-precision jitter over very long runs.

> Note: "Safari couldn't connect to the server" was **not a game bug** — it's a
> network issue. On a phone, open the Mac's LAN address (e.g. `http://<mac-ip>:8000`)
> on the same Wi-Fi, not `localhost`.

### Earlier gameplay bug fixes

- **Fairer collisions** — crashes now use the *committed* target lane, so swiping
  away from an obstacle as it arrives reliably saves you instead of clipping you
  mid-tween.
- **No impossible walls** — double obstacle rows can no longer block a path
  (centre lane is always left open).
- **Restart race fixed** — restarting during the post-crash beat can no longer
  pop the Game Over card on top of a fresh run.
- **Input gating** — steering/▶ inputs are ignored while the Garage is open.

---

## 🗂️ Project structure

The code is deliberately split so the **game logic is independent of rendering,
input, and audio** — this is what makes the iOS port clean.

```
car-game/
├── index.html        # markup + UI overlays (start / HUD / Garage / game-over), loads scripts
├── style.css         # all UI/overlay styling (the game itself is canvas-drawn)
├── README.md
└── js/
    ├── vendor/            # Three.js r128 + post-processing scripts (bloom), vendored
    ├── config.js     # ALL tunable constants + the CARS list (colours/prices)
    ├── audio.js      # Sfx: procedural Web Audio SFX, engine drone + mute
    ├── engine.js     # GameEngine: PURE game logic — no WebGL/DOM/audio
    ├── renderer.js   # Renderer: the Three.js 3D scene (camera, lights, meshes)
    ├── shop.js       # Shop: coin economy, save/persistence, Garage UI
    └── main.js       # wiring: game loop, input (swipe+keys), UI state, audio
```

### How the pieces talk

- **`engine.js`** owns the simulation. It knows only abstract things: lane
  indices and a world depth `z` per obstacle. `update(dt)` advances the world and
  returns an **events array** (`steer`, `score`, `newbest`, `crash`, `start`).
  It has *no* knowledge of canvas, DOM, sound, or perspective.
- **`renderer.js`** reads engine state each frame and maps the abstract world
  into the 3D scene (metres):
  ```
  worldX = laneFrac * 6.0
  worldZ = -((engine_z - PLAYER_Z) * DEPTH)     // ahead of the camera is -Z
  ```
  It positions pooled 3D meshes for obstacles/coins/scenery, scrolls the road &
  grass textures by distance, drives the chase camera, and renders with shadows,
  fog and image-based reflections.
- **`main.js`** runs the `requestAnimationFrame` loop, translates input
  (swipes/taps/keys) into `engine.steer(±1)` / start / restart, reacts to engine
  events with sound + particles, and manages the HTML overlay screens.

There's a small `window.ZippyGame = { engine, renderer, cfg }` debug hook
(handy for tuning and automated testing); it's inert for players and easy to drop.

---

## 🍏 Porting notes (iOS / SceneKit)

- **`engine.js` maps almost 1:1 to a Swift model.** `CONFIG` → a `struct
  Config`, `GameEngine` → a plain class/struct with the same `reset()`,
  `steer(_:)`, `start()`, and `update(dt:) -> [Event]`. No platform APIs are used
  there, so the gameplay/feel transfers exactly.
- **Rendering**: now that it's true 3D, the natural iOS target is **SceneKit**
  (or RealityKit). `renderer.js` is the blueprint: the same scene graph (camera
  chase rig, directional light + shadows, road/grass planes with scrolling
  textures, pooled obstacle/coin/scenery nodes) maps directly to `SCNNode`s and
  `SCNMaterial`s. The engine→world mapping (`worldX`, `worldZ` above) is identical.
- **Input**: map `UISwipeGestureRecognizer` (left/right) and a tap to
  `engine.steer(±1)` / start / restart — the same surface `main.js` uses.
- **Audio**: replace `audio.js` with `SKAction.playSoundFileNamed` or AVFoundation
  tones; the call sites (`steer`, `pass`, `milestone`, `crash`) stay the same.
- **Economy / Garage**: `shop.js` is intentionally isolated — swap its
  `localStorage` read/write for `UserDefaults` and re-skin `renderGarage()` as a
  native screen; the `Shop` API (`coins`, `upgrades`, `equippedColors`,
  `addCoins`, `setBest`) is what the rest of the game depends on. The engine
  reads perks via the injected `engine.upgrades = { magnet, shield }`.
- **Tuning**: everything that affects feel lives in `config.js` — port that first
  and you can re-balance difficulty without touching logic.

---

## ✅ Verified

Opened in a browser and confirmed: the **3D scene renders** (perspective road,
sun shadows, fog, reflective paint, **bloom + vignette**) with no console errors;
the bloom `EffectComposer` is active and the car has rolling wheels; the WebGL
loop advances the world; lanes switch on swipe / arrow keys / A-D; obstacles approach
in 3D in all three lanes; dodging scores; same-lane hits trigger game over;
**coins collect only in-lane (and via magnet from adjacent lanes); shields absorb
a hit then expire; double rows always leave the centre lane free; buying/equipping
colours and upgrades works and persists**; best score persists; and the
start → garage → playing → game-over → restart flow works.

## 📝 TODO / nice-to-haves (not blocking)

- Toward photoreal: detailed glTF car/obstacle models + PBR (normal/roughness)
  textures, a real HDRI environment, and SSAO (bloom is already in).
- Road hills/elevation and banked curves in 3D.
- More power-ups (slow-mo, coin doubler, head-start boost); weather/day–night.
- Background music loop and a settings panel.
- Daily-coin reward, high-score table / share, and haptics on native.
