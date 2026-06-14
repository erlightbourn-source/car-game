/*
 * engine.js — Pure game logic. NO canvas, NO DOM, NO audio.
 *
 * First-person 3-lane endless driver. The world is described abstractly
 * (lane indices + a depth `z`); the renderer projects that into pseudo-3D.
 * This separation is what makes the Swift/SpriteKit port straightforward —
 * this file becomes a plain model.
 *
 * Depth convention: each obstacle/coin has a world depth `z`. It spawns at
 * FAR_Z (the horizon) and decreases toward 0 (the camera) as the world
 * scrolls. When it reaches the player's plane (PLAYER_Z) we resolve it.
 *
 * The engine reports what happened during a step via the returned `events`
 * array, so the host can play sounds / spawn particles without the engine
 * knowing those systems exist.
 *
 * Upgrades are injected by the host before a run via `engine.upgrades`
 * ({ magnet, shield } levels); the engine stays unaware of pricing/UI.
 */
class GameEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.best = 0;
    this.upgrades = { magnet: 0, shield: 0 };
    this.reset();
  }

  reset() {
    const c = this.cfg;
    const mid = Math.floor(c.LANES.length / 2);
    this.state = "ready";          // "ready" | "playing" | "dead"
    this.player = {
      lane: mid,                   // target lane index (committed)
      laneFrac: c.LANES[mid],      // current lateral fraction (smoothly tweened)
    };
    this.obstacles = [];           // {lane, z, type, resolved}
    this.coins = [];               // {lane, frac, z, collected}
    this.score = 0;
    this.runCoins = 0;             // coins collected this run
    this.distance = 0;             // cosmetic odometer (world units)
    this.speed = c.START_SPEED;
    this.shields = this.upgrades.shield | 0;
    this.invuln = 0;               // seconds of post-shield invulnerability
    this.sinceSpawn = c.SPAWN_GAP_START - c.LEAD_IN; // brief empty-road intro
    this.sinceCoin = 0;
    this.scroll = 0;               // for the renderer's road animation
    this.events = [];
    this._lastCoinLane = -1;
  }

  // The lane index the car visually occupies right now (nearest to laneFrac).
  currentLane() {
    const L = this.cfg.LANES;
    let best = 0, bd = Infinity;
    for (let i = 0; i < L.length; i++) {
      const d = Math.abs(this.player.laneFrac - L[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  magnetRange() {
    const m = this.cfg.MAGNET_RANGE;
    return m[Math.min(this.upgrades.magnet | 0, m.length - 1)] || 0;
  }

  // --- Input ---------------------------------------------------------------
  start() {
    if (this.state === "ready") {
      this.state = "playing";
      this.events.push({ type: "start" });
    }
  }

  // Steer one lane left (-1) or right (+1). Only meaningful while playing.
  steer(dir) {
    if (this.state !== "playing") return;
    const n = this.cfg.LANES.length;
    const next = Math.max(0, Math.min(n - 1, this.player.lane + Math.sign(dir)));
    if (next !== this.player.lane) {
      this.player.lane = next;
      this.events.push({ type: "steer", dir: Math.sign(dir) });
    }
  }

  // --- Spawning ------------------------------------------------------------
  _lanesOccupiedNearFar() {
    // Lanes with an obstacle still close to the horizon (avoid stacking coins there).
    const set = new Set();
    for (const o of this.obstacles) {
      if (o.z > this.cfg.FAR_Z - 24) set.add(o.lane);
    }
    return set;
  }

  _spawnObstacleRow() {
    const c = this.cfg;
    const n = c.LANES.length;
    const types = ["cone", "pothole", "barrier", "car"];
    const pick = () => types[Math.floor(Math.random() * types.length)];

    const canDouble = this.score >= c.DOUBLE_AT_SCORE;
    const chance = Math.min(c.DOUBLE_MAX_CHANCE, this.score * 0.012);

    if (canDouble && n === 3 && Math.random() < chance) {
      // Double row: always block the two OUTER lanes, leaving the CENTER free.
      // Center is reachable from any lane in a single move, so it's always fair.
      this.obstacles.push({ lane: 0, z: c.FAR_Z, type: pick(), resolved: false });
      this.obstacles.push({ lane: 2, z: c.FAR_Z, type: pick(), resolved: false });
    } else {
      const lane = Math.floor(Math.random() * n);
      this.obstacles.push({ lane, z: c.FAR_Z, type: pick(), resolved: false });
    }
  }

  _spawnCoin() {
    const c = this.cfg;
    const n = c.LANES.length;
    const occupied = this._lanesOccupiedNearFar();

    let lane;
    // Prefer continuing the previous coin's lane to form satisfying trails.
    if (this._lastCoinLane >= 0 && !occupied.has(this._lastCoinLane) &&
        Math.random() < c.COIN_TRAIL_KEEP) {
      lane = this._lastCoinLane;
    } else {
      const free = [];
      for (let i = 0; i < n; i++) if (!occupied.has(i)) free.push(i);
      if (free.length === 0) return; // no safe lane this cycle
      lane = free[Math.floor(Math.random() * free.length)];
    }

    this.coins.push({ lane, frac: c.LANES[lane], z: c.FAR_Z, collected: false });
    this._lastCoinLane = lane;
  }

  _die() {
    if (this.state === "dead") return;
    this.state = "dead";
    if (this.score > this.best) {
      this.best = this.score;
      this.events.push({ type: "newbest" });
    }
    this.events.push({ type: "crash" });
  }

  // --- Main step -----------------------------------------------------------
  update(dt) {
    dt = Math.min(dt, 0.05);       // clamp long frames (tab switch) so nothing teleports
    this.events = [];
    const c = this.cfg;

    // Smoothly tween the car toward its target lane in every state.
    const target = c.LANES[this.player.lane];
    this.player.laneFrac += (target - this.player.laneFrac) *
      Math.min(1, dt * c.LANE_LERP);

    if (this.state === "ready") {
      this.scroll += c.START_SPEED * 0.5 * dt;   // idle road drift
      return this.events;
    }

    if (this.state === "dead") {
      this.speed *= Math.max(0, 1 - dt * 2.2);   // coast to a stop
      this.scroll += this.speed * dt;
      for (const o of this.obstacles) o.z -= this.speed * dt;
      for (const k of this.coins) k.z -= this.speed * dt;
      return this.events;
    }

    // ---- state === "playing" ----
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    this.speed = Math.min(c.MAX_SPEED, c.START_SPEED + this.score * c.SPEED_PER_PASS);
    const ds = this.speed * dt;
    this.distance += ds;
    this.scroll += ds;

    // Advance world toward the camera.
    for (const o of this.obstacles) o.z -= ds;
    for (const k of this.coins) k.z -= ds;

    // Spawn obstacle rows by distance (fair, speed-independent).
    this.sinceSpawn += ds;
    const gap = Math.max(c.SPAWN_GAP_MIN, c.SPAWN_GAP_START - this.score * c.SPAWN_GAP_RAMP);
    if (this.sinceSpawn >= gap) {
      this._spawnObstacleRow();
      this.sinceSpawn = 0;
    }

    // Spawn coins on their own cadence.
    this.sinceCoin += ds;
    if (this.sinceCoin >= c.COIN_GAP) {
      this._spawnCoin();
      this.sinceCoin = 0;
    }

    // Magnet: pull nearby coins toward the car as they approach.
    const range = this.magnetRange();
    const pf = this.player.laneFrac;
    if (range > 0) {
      for (const k of this.coins) {
        if (!k.collected && k.z < c.COIN_PULL_Z && Math.abs(k.frac - pf) <= range) {
          k.frac += (pf - k.frac) * Math.min(1, dt * 6);
        }
      }
    }

    // Resolve coins crossing the player's plane.
    const pickTol = Math.max(c.COIN_BASE_TOL, range);
    for (const k of this.coins) {
      if (!k.collected && k.z <= c.PLAYER_Z) {
        k.collected = true;
        if (Math.abs(k.frac - pf) <= pickTol) {
          this.runCoins += c.COIN_VALUE;
          this.events.push({ type: "coin", value: this.runCoins, x: k.frac });
        }
      }
    }
    this.coins = this.coins.filter((k) => !k.collected && k.z > -8);

    // Resolve obstacles crossing the player's plane.
    // Collision uses the COMMITTED lane (player.lane) — forgiving & predictable.
    for (const o of this.obstacles) {
      if (o.resolved || o.z > c.PLAYER_Z) continue;
      o.resolved = true;
      if (o.lane === this.player.lane) {
        if (this.invuln > 0) {
          o.z = -20;                       // already protected; shrug it off
        } else if (this.shields > 0) {
          this.shields -= 1;
          this.invuln = c.INVULN_TIME;
          o.z = -20;
          this.events.push({ type: "shieldhit", shields: this.shields });
        } else {
          this._die();
          return this.events;
        }
      } else {
        this.score += 1;
        this.events.push({ type: "score", value: this.score });
      }
    }

    // Cull obstacles that have passed behind the camera.
    this.obstacles = this.obstacles.filter((o) => o.z > -8);

    return this.events;
  }
}

// Export for both browser globals and (future) module bundlers.
if (typeof module !== "undefined" && module.exports) module.exports = { GameEngine };
