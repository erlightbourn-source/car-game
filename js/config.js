/*
 * config.js — All tunable game constants in one place.
 *
 * The game is a first-person (pseudo-3D) endless driver. The road recedes
 * to a horizon; obstacles and coins spawn far away (small) and rush toward
 * the camera (scaling up). The player steers between fixed LANES to dodge
 * obstacles and grab coins, which are spent in the Garage on car colors and
 * upgrades (coin magnet, shields).
 *
 * Everything is authored against a fixed logical resolution and scaled to
 * the real screen by the renderer, so the feel is identical on any device.
 * Keeping the numbers here maps cleanly to a Swift struct for the iOS port.
 */
const CONFIG = {
  // --- Design resolution (logical canvas) ---
  WIDTH: 400,
  HEIGHT: 640,

  // --- Pseudo-3D camera / road projection ---
  HORIZON_Y: 232,        // screen y of the horizon line
  ROAD_HALF_NEAR: 200,   // half-width (px) of the road at the near plane
  FOCAL: 20,             // perspective focal constant (smaller = stronger curve)
  FAR_Z: 165,            // world depth where things spawn (at the horizon)
  CAM_SWAY: 64,          // how far the vanishing point shifts as you steer (px)
  CURVE_AMOUNT: 92,      // how strongly the road bends left/right ahead of you (px at horizon)

  // --- Lanes (lateral fractions of the road half-width, -1..1) ---
  LANES: [-0.62, 0, 0.62],
  PLAYER_Z: 6,           // world depth the player's car sits at (collision plane)
  LANE_LERP: 17,         // steering smoothing toward target lane (higher = snappier)

  // --- Risk/reward hook: combo + near-miss ---
  COMBO_CAP: 12,         // max per-near-miss coin bonus
  WEAVE_AT_SCORE: 12,    // score at which weaving obstacles start appearing
  WEAVE_MAX_CHANCE: 0.5, // max probability an obstacle weaves to an adjacent lane

  // --- Speed / difficulty ramp (driven by `passed` = obstacles dodged, so the
  //     ramp is consistent regardless of how the player chooses to score) ---
  START_SPEED: 30,       // world units per second
  MAX_SPEED: 92,
  SPEED_PER_PASS: 0.7,   // speed gained per obstacle dodged
  KMH_PER_SPEED: 1.7,    // cosmetic speedometer conversion

  SPAWN_GAP_START: 32,   // world-distance between obstacle rows at the start
  SPAWN_GAP_MIN: 18,     // tightest spacing in the early/mid game
  SPAWN_GAP_RAMP: 0.35,  // spacing reduction per obstacle dodged
  LEAD_IN: 20,           // empty road distance before the first obstacle

  DOUBLE_AT_SCORE: 8,    // passes at which two-obstacle rows can appear
  DOUBLE_MAX_CHANCE: 0.42, // max probability of a double row (always leaves CENTER lane free)

  // --- Endless escalation: past the early plateau the game keeps getting
  //     harder so skilled players eventually fail instead of running forever.
  //     A breather (no two blocker-rows back to back) keeps it always fair. ---
  HARD_AT_PASS: 60,         // passes after which late-game escalation kicks in
  SPAWN_GAP_MIN_LATE: 11,   // tightest spacing in the late game
  SPAWN_GAP_RAMP_LATE: 0.12,// extra spacing reduction per pass beyond HARD_AT_PASS
  WEAVE_SPEED: 0.55,        // base weave drift rate (toward adjacent lane)
  WEAVE_SPEED_LATE: 1.15,   // snappier weave late game (harder to read)
  WEAVE_MAX_CHANCE_LATE: 0.78,
  DOUBLE_MAX_CHANCE_LATE: 0.62,

  // --- Coins ---
  COIN_GAP: 14,          // world-distance between coin spawns
  COIN_VALUE: 1,
  COIN_BASE_TOL: 0.24,   // lateral pickup tolerance with no magnet (≈ same lane only)
  COIN_PULL_Z: 50,       // depth within which a magnet starts pulling coins
  MAGNET_RANGE: [0, 0.7, 1.0, 1.4],   // pickup/pull lateral reach by magnet level
  COIN_TRAIL_KEEP: 0.6,  // chance a coin reuses the previous coin's lane (forms trails)

  // --- Power-ups (one spawns every POWER_GAP; type is weighted-random) ---
  POWER_GAP: 175,        // world-distance between power-up spawns (rarer = more special)
  DOUBLER_TIME: 10,      // seconds the ×2 coin doubler lasts
  MAGNET_BOOST: 1.45,    // lateral magnet reach while ×2 is active (auto-vacuums coins)
  SLOW_TIME: 7,          // seconds slow-mo lasts
  SLOW_FACTOR: 0.55,     // world speed multiplier during slow-mo

  // --- Potholes are a SOFT hazard: they jolt + briefly slow you, they do NOT
  //     end the run (only cones / barriers / cars do). Hitting one costs your
  //     near-miss combo and a little speed, so they still sting. ---
  POTHOLE_SLOW: 1.0,        // base seconds of slowdown after clipping a pothole
  POTHOLE_SLOW_FAST_BONUS: 0.9, // extra slowdown seconds scaled by current speed (stings more when fast)
  POTHOLE_SLOW_FACTOR: 0.5, // world speed multiplier during pothole recovery

  // --- Easy mode (younger kids): clamps difficulty to a gentle, near-endless
  //     plateau — no late-game escalation, slower top speed. ---
  ASSIST_MAX_PASS: 28,

  // --- Upgrades (max level 3 each) ---
  MAGNET_PRICES: [0, 80, 180, 320],
  SHIELD_PRICES: [0, 100, 220, 380],
  INVULN_TIME: 0.9,      // seconds of invulnerability after a shield absorbs a hit
};

// ---- Customization catalogs (all coin-priced; price 0 = owned by default) ----

// PAINT — body colour. (Kept as `CARS` for back-compat.)
const CARS = [
  { id: "red",    name: "Ruby",   price: 0,   body: "#ff5b6e", roof: "#ff7286", bumper: "#e8485b" },
  { id: "blue",   name: "Sky",    price: 40,  body: "#4aa3ff", roof: "#6fb6ff", bumper: "#3b86db" },
  { id: "green",  name: "Mint",   price: 90,  body: "#3ec98a", roof: "#5fd9a1", bumper: "#33a873" },
  { id: "white",  name: "Pearl",  price: 150, body: "#eef2f7", roof: "#ffffff", bumper: "#cfd6df" },
  { id: "black",  name: "Onyx",   price: 220, body: "#3a3f49", roof: "#4a505c", bumper: "#2a2e36" },
  { id: "purple", name: "Grape",  price: 300, body: "#9b6cff", roof: "#b288ff", bumper: "#7f53db" },
  { id: "gold",   name: "Goldie", price: 450, body: "#ffcf3f", roof: "#ffe07a", bumper: "#e0ad1f" },
  { id: "galaxy", name: "Galaxy", price: 900, body: "#6a3fb0", roof: "#8b5fd6", bumper: "#3f2470" },
];

// DESIGN — car body shape (drawn procedurally by the renderer per id).
const DESIGNS = [
  { id: "hatch",    name: "Hatch",    price: 0 },
  { id: "sport",    name: "Sport",    price: 180 },
  { id: "pickup",   name: "Pickup",   price: 280 },
  { id: "van",      name: "Van",      price: 320 },
  { id: "classic",  name: "Classic",  price: 360 },
  { id: "roadster", name: "Roadster", price: 440 },
];

// LIGHTS — taillight colour (base colour + emissive glow colour).
const LIGHTS = [
  { id: "red",    name: "Classic", price: 0,   color: 0xff2e2e, emissive: 0xff2020 },
  { id: "ice",    name: "Ice",     price: 60,  color: 0x53d2ff, emissive: 0x33b8ff },
  { id: "amber",  name: "Amber",   price: 90,  color: 0xffc24a, emissive: 0xff9e1f },
  { id: "lime",   name: "Lime",    price: 120, color: 0x9bff5a, emissive: 0x6fdd2f },
  { id: "violet", name: "Violet",  price: 160, color: 0xc36bff, emissive: 0xa23cff },
  { id: "pearl",  name: "Pearl",   price: 220, color: 0xffffff, emissive: 0xfff2d0 },
];

// BACKGROUND — the world/theme. Each carries lighting + colour parameters that
// the renderer applies to the sky, fog, sun, ambient light, sun glow and grass.
const BACKGROUNDS = [
  { id: "day", name: "Sunny Day", price: 0,
    sky: [0x2f86d8, 0x8fc6f0, 0xd7eef8], fog: 0x9fc8e6, fogNear: 48, fogFar: 195,
    hemiSky: 0xbfe0ff, hemiGround: 0x6a8f4e, hemiInt: 0.55,
    sun: 0xfff1cf, sunInt: 2.5, sunDir: [-0.45, 0.62, -0.7], grass: 0x6bbf4f, glow: "#fff6c6" },
  { id: "sunset", name: "Sunset", price: 120,
    sky: [0xff7330, 0xffa867, 0xffe1b4], fog: 0xffac7a, fogNear: 38, fogFar: 175,
    hemiSky: 0xffc59a, hemiGround: 0x5a4030, hemiInt: 0.5,
    sun: 0xff8a45, sunInt: 2.3, sunDir: [-0.75, 0.2, -0.55], grass: 0x9a9a52, glow: "#ffce86" },
  { id: "desert", name: "Desert", price: 170,
    sky: [0x3f9fe0, 0x9fd0ef, 0xf0e6c8], fog: 0xe6d6a8, fogNear: 44, fogFar: 200,
    hemiSky: 0xe9dcae, hemiGround: 0x7a6440, hemiInt: 0.6,
    sun: 0xfff0c0, sunInt: 2.7, sunDir: [-0.5, 0.6, -0.65], grass: 0xd9c489, glow: "#fff3c8" },
  { id: "snow", name: "Winter", price: 220,
    sky: [0x6f9bca, 0xaecbe8, 0xe7f2fc], fog: 0xdde9f6, fogNear: 40, fogFar: 175,
    hemiSky: 0xe2efff, hemiGround: 0xa6b6c6, hemiInt: 0.7,
    sun: 0xfdfaf2, sunInt: 2.2, sunDir: [-0.4, 0.55, -0.7], grass: 0xeaf2fb, glow: "#ffffff" },
  { id: "dusk", name: "Dusk", price: 260,
    sky: [0x2b2b5e, 0x7a5a9c, 0xe8a8a0], fog: 0x8a6a8a, fogNear: 36, fogFar: 165,
    hemiSky: 0x8a7ab0, hemiGround: 0x2a2440, hemiInt: 0.45,
    sun: 0xff9a7a, sunInt: 1.4, sunDir: [-0.7, 0.18, -0.6], grass: 0x4a4566, glow: "#ffb38a" },
  { id: "night", name: "Night", price: 320,
    sky: [0x081130, 0x162250, 0x2c3a66], fog: 0x141e3a, fogNear: 32, fogFar: 150,
    hemiSky: 0x44548a, hemiGround: 0x0f1320, hemiInt: 0.4,
    sun: 0xaebfff, sunInt: 0.8, sunDir: [0.4, 0.55, -0.6], grass: 0x29463a, glow: "#cdd8ff" },
  { id: "candy", name: "Candy", price: 380,
    sky: [0xff7ec4, 0xffa8d8, 0xffe0f0], fog: 0xffc4e2, fogNear: 44, fogFar: 195,
    hemiSky: 0xffd4ec, hemiGround: 0x5aa0a0, hemiInt: 0.6,
    sun: 0xfff0f6, sunInt: 2.4, sunDir: [-0.45, 0.6, -0.7], grass: 0x4fd0c0, glow: "#ffd0ec" },
  { id: "aurora", name: "Aurora", price: 480,
    sky: [0x06112e, 0x123c57, 0x2bd49a], fog: 0x163a48, fogNear: 34, fogFar: 158,
    hemiSky: 0x6fe0bd, hemiGround: 0x10202a, hemiInt: 0.45,
    sun: 0xbfe6ff, sunInt: 0.95, sunDir: [0.4, 0.55, -0.6], grass: 0x254a3e, glow: "#7dffcf" },
];

// Export for the headless playtest harness (Node). Browsers ignore this.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CONFIG, CARS, DESIGNS, LIGHTS, BACKGROUNDS };
}
