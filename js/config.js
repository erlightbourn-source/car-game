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
  LANE_LERP: 12,         // steering smoothing toward target lane (higher = snappier)

  // --- Speed / difficulty ramp ---
  START_SPEED: 30,       // world units per second
  MAX_SPEED: 84,
  SPEED_PER_PASS: 0.7,   // speed gained per obstacle dodged
  KMH_PER_SPEED: 1.7,    // cosmetic speedometer conversion

  SPAWN_GAP_START: 32,   // world-distance between obstacle rows at the start
  SPAWN_GAP_MIN: 18,     // tightest spacing at high difficulty
  SPAWN_GAP_RAMP: 0.35,  // spacing reduction per obstacle dodged
  LEAD_IN: 20,           // empty road distance before the first obstacle

  DOUBLE_AT_SCORE: 8,    // score at which two-obstacle rows can appear
  DOUBLE_MAX_CHANCE: 0.42, // max probability of a double row (always leaves CENTER lane free)

  // --- Coins ---
  COIN_GAP: 14,          // world-distance between coin spawns
  COIN_VALUE: 1,
  COIN_BASE_TOL: 0.24,   // lateral pickup tolerance with no magnet (≈ same lane only)
  COIN_PULL_Z: 50,       // depth within which a magnet starts pulling coins
  MAGNET_RANGE: [0, 0.7, 1.0, 1.4],   // pickup/pull lateral reach by magnet level
  COIN_TRAIL_KEEP: 0.6,  // chance a coin reuses the previous coin's lane (forms trails)

  // --- Upgrades (max level 3 each) ---
  MAGNET_PRICES: [0, 80, 180, 320],
  SHIELD_PRICES: [0, 100, 220, 380],
  INVULN_TIME: 0.9,      // seconds of invulnerability after a shield absorbs a hit
};

// Selectable car bodies. Cosmetic only; `price` 0 means owned by default.
const CARS = [
  { id: "red",    name: "Ruby",   price: 0,   body: "#ff5b6e", roof: "#ff7286", bumper: "#e8485b" },
  { id: "blue",   name: "Sky",    price: 60,  body: "#4aa3ff", roof: "#6fb6ff", bumper: "#3b86db" },
  { id: "green",  name: "Mint",   price: 120, body: "#3ec98a", roof: "#5fd9a1", bumper: "#33a873" },
  { id: "purple", name: "Grape",  price: 220, body: "#9b6cff", roof: "#b288ff", bumper: "#7f53db" },
  { id: "gold",   name: "Goldie", price: 450, body: "#ffcf3f", roof: "#ffe07a", bumper: "#e0ad1f" },
];
