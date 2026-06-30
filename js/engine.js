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
// Small deterministic PRNG (mulberry32) for the seeded Daily Challenge. When no
// seed is set the engine uses Math.random, so normal play is unchanged.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class GameEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.best = 0;
    this.upgrades = { magnet: 0, shield: 0 };
    this.assist = false;           // Easy mode (set by the host before a run; persists across resets)
    this.seed = null;              // set to an integer for a deterministic (Daily) course; null = random
    this.reset();
  }

  // Effective difficulty progression. Easy mode clamps it to a gentle plateau.
  _diff() {
    return this.assist ? Math.min(this.passed, this.cfg.ASSIST_MAX_PASS) : this.passed;
  }

  reset() {
    const c = this.cfg;
    // Seeded RNG for deterministic (Daily) runs; falls back to Math.random.
    this._rand = (this.seed != null) ? mulberry32(this.seed >>> 0) : Math.random;
    const mid = Math.floor(c.LANES.length / 2);
    this.state = "ready";          // "ready" | "playing" | "dead"
    this.player = {
      lane: mid,                   // target lane index (committed)
      laneFrac: c.LANES[mid],      // current lateral fraction (smoothly tweened)
    };
    this.obstacles = [];           // {lane, z, type, resolved, frac, weaveTarget}
    this.coins = [];               // {lane, frac, z, collected}
    this.score = 0;                // risk-weighted, player-facing score
    this.passed = 0;               // obstacles dodged — drives difficulty (style-independent)
    this._lastRowDouble = false;   // guard: never two blocker-rows back to back (fair breather)
    this.runCoins = 0;             // coins collected this run
    this.combo = 0;                // consecutive near-miss dodges (risk/reward)
    this.bestCombo = 0;            // best combo this run (for missions)
    this.nearMisses = 0;           // total near-misses this run (for missions)
    this.distance = 0;             // cosmetic odometer (world units)
    this.speed = c.START_SPEED;
    this.shields = this.upgrades.shield | 0;
    this.invuln = 0;               // seconds of post-shield invulnerability
    this.sinceSpawn = c.SPAWN_GAP_START - c.LEAD_IN; // brief empty-road intro
    this.sinceCoin = 0;
    this.powerups = [];            // {lane, frac, z, collected, type}
    this.sincePower = 0;
    this.doubler = 0;              // seconds remaining of ×2 coin doubler
    this.slow = 0;                 // seconds remaining of slow-mo
    this.nmSlow = 0;               // brief near-miss-combo slow-mo
    this.bump = 0;                 // brief slowdown after clipping a pothole (soft hazard)
    this.magnetBoost = 0;          // seconds remaining of boosted magnet (from ×2)
    this.curSpeed = c.START_SPEED; // effective world speed this frame (after slow-mo)
    this.scroll = 0;               // for the renderer's road animation
    this.events = [];
    this._lastCoinLane = -1;
  }

  // Nearest lane index to a lateral fraction.
  _laneOf(frac) {
    const L = this.cfg.LANES;
    let best = 0, bd = Infinity;
    for (let i = 0; i < L.length; i++) {
      const d = Math.abs(frac - L[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // The lane index the car visually occupies right now.
  currentLane() { return this._laneOf(this.player.laneFrac); }

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
    const all = ["cone", "pothole", "barrier", "car"];
    const hard = ["cone", "barrier", "car"];          // potholes are soft, so doubles use real blockers
    const pick = () => all[(this._rand() * all.length) | 0];
    const pickHard = () => hard[(this._rand() * hard.length) | 0];
    const P = this._diff();                           // difficulty progression (clamped in Easy mode)

    // Never two blocker-rows in a row → guarantees a reachable breather (fair).
    const canDouble = P >= c.DOUBLE_AT_SCORE && !this._lastRowDouble;
    const dMax = P > c.HARD_AT_PASS ? c.DOUBLE_MAX_CHANCE_LATE : c.DOUBLE_MAX_CHANCE;
    const dChance = Math.min(dMax, P * 0.012);

    if (canDouble && n === 3 && this._rand() < dChance) {
      this._lastRowDouble = true;
      // Block the two OUTER lanes, leaving the CENTER open. The center is
      // reachable from any lane in a single move, so a double row is ALWAYS
      // survivable — this is what keeps the escalating game provably fair.
      // (We deliberately do NOT leave an outer lane open: that can require a
      // two-lane move and, combined with weaving, produces unwinnable rows.)
      this.obstacles.push({ lane: 0, z: c.FAR_Z, type: pickHard(), resolved: false, frac: c.LANES[0] });
      this.obstacles.push({ lane: 2, z: c.FAR_Z, type: pickHard(), resolved: false, frac: c.LANES[2] });
    } else {
      this._lastRowDouble = false;
      const lane = (this._rand() * n) | 0;
      const o = { lane, z: c.FAR_Z, type: pick(), resolved: false, frac: c.LANES[lane] };
      // Escalation: single obstacles may WEAVE to an adjacent lane as they
      // approach, forcing the player to read their final position. (Singles
      // only — keeps the fairness guarantee that ≥1 lane is always clear.)
      const wMax = P > c.HARD_AT_PASS ? c.WEAVE_MAX_CHANCE_LATE : c.WEAVE_MAX_CHANCE;
      if (P >= c.WEAVE_AT_SCORE && this._rand() < Math.min(wMax, P * 0.015)) {
        const adj = [];
        if (lane - 1 >= 0) adj.push(lane - 1);
        if (lane + 1 < n) adj.push(lane + 1);
        o.weaveTarget = c.LANES[adj[(this._rand() * adj.length) | 0]];
        o.weaveSpeed = P > c.HARD_AT_PASS ? c.WEAVE_SPEED_LATE : c.WEAVE_SPEED;
      }
      this.obstacles.push(o);
    }
  }

  _spawnCoin() {
    const c = this.cfg;
    const n = c.LANES.length;
    const occupied = this._lanesOccupiedNearFar();

    let lane;
    // Prefer continuing the previous coin's lane to form satisfying trails.
    if (this._lastCoinLane >= 0 && !occupied.has(this._lastCoinLane) &&
        this._rand() < c.COIN_TRAIL_KEEP) {
      lane = this._lastCoinLane;
    } else {
      const free = [];
      for (let i = 0; i < n; i++) if (!occupied.has(i)) free.push(i);
      if (free.length === 0) return; // no safe lane this cycle
      lane = free[Math.floor(this._rand() * free.length)];
    }

    this.coins.push({ lane, frac: c.LANES[lane], z: c.FAR_Z, collected: false });
    this._lastCoinLane = lane;
  }

  _spawnPower() {
    const c = this.cfg, n = c.LANES.length, occupied = this._lanesOccupiedNearFar();
    const free = [];
    for (let i = 0; i < n; i++) if (!occupied.has(i)) free.push(i);
    const lane = free.length ? free[Math.floor(this._rand() * free.length)]
      : Math.floor(this._rand() * n);
    // Weighted-random type: ×2 most common, then slow-mo, then shield.
    const r = this._rand();
    const type = r < 0.5 ? "x2" : r < 0.8 ? "slow" : "shield";
    this.powerups.push({ lane, frac: c.LANES[lane], z: c.FAR_Z, collected: false, type });
  }

  _die() {
    if (this.state === "dead") return;
    this.state = "dead";
    this.combo = 0;
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
      for (const k of this.powerups) k.z -= this.speed * dt;
      return this.events;
    }

    // ---- state === "playing" ----
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    if (this.doubler > 0) {
      this.doubler = Math.max(0, this.doubler - dt);
      if (this.doubler === 0) this.events.push({ type: "doublerend" });
    }
    if (this.slow > 0) this.slow = Math.max(0, this.slow - dt);
    if (this.nmSlow > 0) this.nmSlow = Math.max(0, this.nmSlow - dt);   // brief near-miss slow-mo
    if (this.bump > 0) this.bump = Math.max(0, this.bump - dt);         // brief pothole recovery
    if (this.magnetBoost > 0) this.magnetBoost = Math.max(0, this.magnetBoost - dt);

    const D = this._diff();
    this.speed = Math.min(c.MAX_SPEED, c.START_SPEED + D * c.SPEED_PER_PASS);
    const moveSpeed = this.nmSlow > 0 ? this.speed * 0.45
      : (this.bump > 0 ? this.speed * c.POTHOLE_SLOW_FACTOR
      : (this.slow > 0 ? this.speed * c.SLOW_FACTOR : this.speed));
    this.curSpeed = moveSpeed;
    const ds = moveSpeed * dt;     // slow-mo slows the world without affecting difficulty
    this.distance += ds;
    this.scroll += ds;

    // Advance world toward the camera; weaving obstacles drift to their target lane.
    for (const o of this.obstacles) {
      o.z -= ds;
      if (o.weaveTarget !== undefined && o.frac !== o.weaveTarget) {
        o.frac += (o.weaveTarget - o.frac) * Math.min(1, dt * (o.weaveSpeed || c.WEAVE_SPEED));
      }
    }
    for (const k of this.coins) k.z -= ds;
    for (const k of this.powerups) k.z -= ds;

    // Spawn obstacle rows by distance (fair, speed-independent).
    this.sinceSpawn += ds;
    let gap = Math.max(c.SPAWN_GAP_MIN, c.SPAWN_GAP_START - D * c.SPAWN_GAP_RAMP);
    if (D > c.HARD_AT_PASS) {                      // late game keeps compressing past the mid floor
      gap = Math.max(c.SPAWN_GAP_MIN_LATE, gap - (D - c.HARD_AT_PASS) * c.SPAWN_GAP_RAMP_LATE);
    }
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

    // Spawn ×2 power-ups on a rarer cadence.
    this.sincePower += ds;
    if (this.sincePower >= c.POWER_GAP) {
      this._spawnPower();
      this.sincePower = 0;
    }

    // Magnet: pull nearby coins (and power-ups) toward the car as they approach.
    // The ×2 power-up temporarily boosts the reach so it auto-vacuums coins.
    const range = Math.max(this.magnetRange(), this.magnetBoost > 0 ? c.MAGNET_BOOST : 0);
    const pf = this.player.laneFrac;
    if (range > 0) {
      for (const k of this.coins) {
        if (!k.collected && k.z < c.COIN_PULL_Z && Math.abs(k.frac - pf) <= range) {
          k.frac += (pf - k.frac) * Math.min(1, dt * 6);
        }
      }
      for (const k of this.powerups) {
        if (!k.collected && k.z < c.COIN_PULL_Z && Math.abs(k.frac - pf) <= range) {
          k.frac += (pf - k.frac) * Math.min(1, dt * 6);
        }
      }
    }

    const pickTol = Math.max(c.COIN_BASE_TOL, range);

    // Resolve power-ups crossing the player's plane → apply effect by type.
    for (const k of this.powerups) {
      if (!k.collected && k.z <= c.PLAYER_Z) {
        k.collected = true;
        if (Math.abs(k.frac - pf) <= pickTol) {
          if (k.type === "x2") {
            this.doubler = c.DOUBLER_TIME;
            this.magnetBoost = c.DOUBLER_TIME;      // ×2 also auto-vacuums coins
          } else if (k.type === "slow") {
            this.slow = c.SLOW_TIME;
          } else if (k.type === "shield") {
            this.shields += 1;
          }
          this.events.push({ type: "powerup", kind: k.type });
        }
      }
    }
    this.powerups = this.powerups.filter((k) => !k.collected && k.z > -8);

    // Resolve coins crossing the player's plane (doubled while the ×2 is active).
    for (const k of this.coins) {
      if (!k.collected && k.z <= c.PLAYER_Z) {
        k.collected = true;
        if (Math.abs(k.frac - pf) <= pickTol) {
          const gain = c.COIN_VALUE * (this.doubler > 0 ? 2 : 1);
          this.runCoins += gain;
          this.events.push({ type: "coin", value: this.runCoins, gain, x: k.frac });
        }
      }
    }
    this.coins = this.coins.filter((k) => !k.collected && k.z > -8);

    // Resolve obstacles crossing the player's plane. The obstacle's EFFECTIVE
    // lane is wherever it is now (handles weaving). Dodging an *adjacent* lane
    // is a near-miss → builds combo + bonus coins; dodging from far loses combo.
    for (const o of this.obstacles) {
      if (o.resolved || o.z > c.PLAYER_Z) continue;
      o.resolved = true;
      const oLane = this._laneOf(o.frac !== undefined ? o.frac : c.LANES[o.lane]);
      if (oLane === this.player.lane) {
        if (o.type === "pothole") {
          // Potholes are a SOFT hazard: a jolt that kills your combo and slows
          // you for a moment, but never ends the run. Always survivable. The
          // jolt costs more the faster you're going, so it still stings late.
          this.combo = 0;
          this.bump = c.POTHOLE_SLOW + (this.speed / c.MAX_SPEED) * c.POTHOLE_SLOW_FAST_BONUS;
          o.z = -20;
          this.events.push({ type: "bump" });
        } else if (this.invuln > 0) {
          o.z = -20;                       // already protected; shrug it off
        } else if (this.shields > 0) {
          this.shields -= 1;
          this.invuln = c.INVULN_TIME;
          this.combo = 0;
          o.z = -20;
          this.events.push({ type: "shieldhit", shields: this.shields });
        } else {
          this._die();
          return this.events;
        }
      } else {
        this.passed += 1;                  // difficulty progression (style-independent)
        if (Math.abs(oLane - this.player.lane) === 1) {
          this.combo += 1;
          this.bestCombo = Math.max(this.bestCombo, this.combo);
          this.nearMisses += 1;
          let bonus = Math.min(this.combo, c.COMBO_CAP);
          let gain = 1 + bonus;            // risk-weighted: bold near-misses score big
          const milestone = this.combo % 5 === 0;     // every 5th = dramatic moment
          if (milestone) { bonus += 10; gain += 10; this.nmSlow = 0.45; }
          this.runCoins += bonus;
          this.score += gain;
          this.events.push({ type: "nearmiss", combo: this.combo, bonus, milestone });
        } else {
          this.combo = 0;                  // played it safe → streak resets
          this.score += 1;                 // safe pass = small, steady reward
        }
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
