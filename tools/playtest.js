#!/usr/bin/env node
/*
 * playtest.js — headless automated playtest / balance harness for Lane Rush.
 *
 * Loads the real game logic (js/config.js + js/engine.js — both renderer-agnostic)
 * and plays thousands of simulated runs with NO browser, then prints JSON metrics.
 *
 * Two instruments:
 *   1. FAIRNESS ORACLE — a near-perfect bot. If it can't survive, a row was
 *      unwinnable. This MUST stay at (or near) 100%. It is the hard gate that
 *      protects the "always fair" design promise; never ship a change that
 *      drops it below the FAIRNESS_MIN threshold.
 *   2. COHORT SIM — bots modeling players of different ages (reaction speed,
 *      planning depth, motor speed, error rate that rises under speed pressure).
 *      Used to read the difficulty curve and whether score differentiates skill.
 *
 * Usage:
 *   node tools/playtest.js              # full run, human-readable + JSON
 *   node tools/playtest.js --json       # JSON only (for the agent to parse)
 *   node tools/playtest.js --runs 40    # override runs-per-cohort
 *
 * Exit code: 0 if fairness gate passes, 1 if it fails (so CI/agents can gate on it).
 */
"use strict";
const path = require("path");
const { CONFIG } = require(path.join(__dirname, "..", "js", "config.js"));
const { GameEngine } = require(path.join(__dirname, "..", "js", "engine.js"));

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");
const RUNS = (() => { const i = args.indexOf("--runs"); return i >= 0 ? (parseInt(args[i + 1], 10) || 30) : 30; })();
const DT = 1 / 60;
const MAXT = 300;                 // 5-minute cap per run
const FAIRNESS_MIN = 0.95;        // oracle must survive at least this fraction of runs

const c = CONFIG;
const e = new GameEngine(c);

// ---- shared helpers (operate on the live engine `e`) ----
function laneOf(frac) { return e._laneOf(frac); }
// nearest HARD hazard distance in a lane (potholes are soft → ignored)
function clearDist(lane, horizon) {
  let best = horizon;
  for (const o of e.obstacles) {
    if (o.resolved || o.z <= c.PLAYER_Z || o.type === "pothole") continue;
    if (laneOf(o.frac) === lane) { const d = o.z - c.PLAYER_Z; if (d < best) best = d; }
  }
  return best;
}
function coinIn(lane, horizon) {
  for (const k of e.coins) {
    if (k.collected || k.z <= c.PLAYER_Z || k.z - c.PLAYER_Z > horizon) continue;
    if (laneOf(k.frac) === lane) return true;
  }
  return false;
}

// ---- 1) fairness oracle: perfect planning, instant reaction, weave-aware ----
function oracleMove() {
  const n = c.LANES.length, my = e.player.lane;
  // a weaving obstacle is treated as blocking BOTH the lane it's in and its target
  const blk = Array.from({ length: n }, () => Infinity);
  for (const o of e.obstacles) {
    if (o.resolved || o.z <= c.PLAYER_Z || o.type === "pothole") continue;
    const d = o.z - c.PLAYER_Z;
    const lanes = [laneOf(o.frac)];
    if (o.weaveTarget !== undefined) { const tl = laneOf(o.weaveTarget); if (tl !== lanes[0]) lanes.push(tl); }
    for (const L of lanes) if (L >= 0 && L < n && d < blk[L]) blk[L] = d;
  }
  const opts = [{ d: 0, clear: blk[my] }];
  for (let dd = -1; dd <= 1; dd += 2) { const nl = my + dd; if (nl >= 0 && nl < n) opts.push({ d: dd, clear: blk[nl] }); }
  opts.sort((a, z) => (z.clear - a.clear) || (a.d === 0 ? -1 : z.d === 0 ? 1 : 0));
  return opts[0].d;
}
function fairness(assist, runs) {
  let survived = 0;
  for (let r = 0; r < runs; r++) {
    e.reset(); e.upgrades = { magnet: 0, shield: 0 }; e.shields = 0; e.assist = assist; e.start();
    let t = 0;
    while (e.state === "playing" && t < MAXT) { const m = oracleMove(); if (m) e.steer(m); e.update(DT); t += t < 0 ? 0 : DT; }
    if (e.state !== "dead") survived++;
  }
  return survived / runs;
}

// ---- 2) cohort sim: realistic players (error rises with speed) ----
const COHORTS = [
  { key: "toddler_3_5", planH: 22, actThresh: 16, inputDelay: 0.50, miss: 0.22, pressure: 0.22, coinSeek: 0.04 },
  { key: "young_6_8",   planH: 40, actThresh: 24, inputDelay: 0.32, miss: 0.10, pressure: 0.14, coinSeek: 0.12 },
  { key: "tween_9_12",  planH: 62, actThresh: 30, inputDelay: 0.20, miss: 0.04, pressure: 0.09, coinSeek: 0.22 },
  { key: "teen_13plus", planH: 95, actThresh: 34, inputDelay: 0.14, miss: 0.012, pressure: 0.05, coinSeek: 0.32 },
];
function cohortDecide(b) {
  const n = c.LANES.length, my = e.player.lane, myC = clearDist(my, b.planH);
  const miss = b.miss + (e.speed / c.MAX_SPEED) * b.pressure;   // pressure rises with speed
  const opts = [{ d: 0, lane: my, clr: myC }];
  for (let dd = -1; dd <= 1; dd += 2) { const nl = my + dd; if (nl >= 0 && nl < n) opts.push({ d: dd, lane: nl, clr: clearDist(nl, b.planH) }); }
  opts.sort((a, z) => (z.clr - a.clr) || (a.d === 0 ? -1 : z.d === 0 ? 1 : 0) || (Math.abs(a.lane - 1) - Math.abs(z.lane - 1)));
  if (myC < b.actThresh) { return Math.random() < miss ? 0 : opts[0].d; }
  if (opts[0].d !== 0 && opts[0].clr >= myC * 1.6 && myC < b.planH * 0.6) { return Math.random() < miss ? 0 : opts[0].d; }
  if (Math.random() < b.coinSeek) {
    for (let d2 = -1; d2 <= 1; d2 += 2) { const l2 = my + d2; if (l2 >= 0 && l2 < n && coinIn(l2, b.planH) && clearDist(l2, b.planH) >= b.planH * 0.8) return d2; }
  }
  return 0;
}
function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function runCohort(b, runs) {
  const times = [], scores = []; let survived = 0, potholes = 0;
  for (let r = 0; r < runs; r++) {
    e.reset(); e.upgrades = { magnet: 0, shield: 0 }; e.shields = 0; e.assist = false; e.start();
    let t = 0, last = -1;
    while (e.state === "playing" && t < MAXT) {
      if (t - last >= b.inputDelay) { const mv = cohortDecide(b); if (mv) { e.steer(mv); last = t; } }
      const ev = e.update(DT);
      for (const x of ev) if (x.type === "bump") potholes++;
      t += DT;
    }
    times.push(+t.toFixed(1)); scores.push(e.score); if (e.state !== "dead") survived++;
  }
  return {
    cohort: b.key,
    medianSurvivalSec: +median(times).toFixed(1),
    maxSurvivalSec: Math.max(...times),
    reached5minPct: Math.round(survived / runs * 100),
    medianScore: median(scores),
    maxScore: Math.max(...scores),
    potholeHitsPerRun: +(potholes / runs).toFixed(1),
  };
}

// ---- run everything ----
const oracleNormal = fairness(false, 20);
const oracleEasy = fairness(true, 20);
const cohorts = COHORTS.map((b) => runCohort(b, RUNS));
const easyToddler = (() => { e.assist = true; const b = COHORTS[0]; const r = runCohort({ ...b }, RUNS); e.assist = false; return r; })();

// crude skill-spread signal: ratio of teen median score to young median score
const young = cohorts.find((x) => x.cohort === "young_6_8");
const teen = cohorts.find((x) => x.cohort === "teen_13plus");
const skillSpread = young && teen && young.medianScore ? +(teen.medianScore / young.medianScore).toFixed(1) : null;

const report = {
  runsPerCohort: RUNS,
  fairness: { oracleNormalPct: Math.round(oracleNormal * 100), oracleEasyPct: Math.round(oracleEasy * 100), gateMinPct: FAIRNESS_MIN * 100 },
  cohorts,
  easyModeToddler: { medianSurvivalSec: easyToddler.medianSurvivalSec, reached5minPct: easyToddler.reached5minPct, medianScore: easyToddler.medianScore },
  signals: {
    skillSpread_teenVsYoung: skillSpread,   // >1.5 = score meaningfully rewards skill
    averagePlayerCanLose: (young ? young.reached5minPct < 50 : null), // young players should mostly lose
  },
  verdict: {
    fairnessPass: oracleNormal >= FAIRNESS_MIN && oracleEasy >= FAIRNESS_MIN,
  },
};

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log("=== Lane Rush — headless playtest ===");
  console.log(`Fairness oracle (must be >= ${FAIRNESS_MIN * 100}%):  normal ${report.fairness.oracleNormalPct}%  |  easy ${report.fairness.oracleEasyPct}%  -> ${report.verdict.fairnessPass ? "PASS" : "FAIL"}`);
  console.log("");
  console.log("Cohort                median survival   reaches 5min   median score   max score   potholes/run");
  for (const x of cohorts) {
    console.log(
      x.cohort.padEnd(20),
      String(x.medianSurvivalSec + "s").padStart(12),
      String(x.reached5minPct + "%").padStart(13),
      String(x.medianScore).padStart(14),
      String(x.maxScore).padStart(11),
      String(x.potholeHitsPerRun).padStart(13)
    );
  }
  console.log("");
  console.log(`Easy-mode toddler: median ${report.easyModeToddler.medianSurvivalSec}s, reaches 5min ${report.easyModeToddler.reached5minPct}%`);
  console.log(`Skill spread (teen/young median score): ${skillSpread}x  (>1.5 = score rewards skill)`);
  console.log(`Average player can lose (young reaches 5min < 50%): ${report.signals.averagePlayerCanLose}`);
  console.log("");
  console.log(JSON.stringify(report));
}

process.exit(report.verdict.fairnessPass ? 0 : 1);
