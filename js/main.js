/*
 * main.js — Wires everything together: the game loop, input (swipe +
 * keyboard), UI screen state machine, audio, the coin economy (via Shop),
 * and the engine sound. The only file that touches the DOM, so the engine
 * and renderer stay portable.
 */
(function () {
  const canvas = document.getElementById("game");
  const engine = new GameEngine(CONFIG);

  // Build the 3D renderer. If WebGL is unavailable/blocked, show a friendly
  // message instead of a broken page or a raw error.
  let renderer;
  try {
    renderer = new Renderer(canvas, CONFIG);
  } catch (err) {
    console.error("Renderer init failed:", err);
    const wrap = document.getElementById("game-wrap");
    document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
    const msg = document.createElement("div");
    msg.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;" +
      "justify-content:center;padding:28px;text-align:center;z-index:50;background:#bfe3ff;color:#2c3e50;" +
      "font-family:'Trebuchet MS',system-ui,sans-serif;";
    msg.innerHTML =
      "<div style='font-size:52px'>🚗💨</div>" +
      "<div style='font-size:20px;font-weight:bold'>Couldn't start the 3D view</div>" +
      "<div style='font-size:14px;max-width:300px;opacity:.85'>This browser/device couldn't initialise WebGL. " +
      "Try a different browser, or turn off Low Power Mode and reload.</div>";
    wrap.appendChild(msg);
    return;
  }

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const elStart = $("screen-start"), elShop = $("screen-shop");
  const elOver = $("screen-over"), elHud = $("hud");
  const elHudScore = $("hud-score"), elHudCoins = $("hud-coins-val"), elHudSpeed = $("hud-speed-val");
  const elDoubler = $("hud-doubler"), elDoublerTime = $("hud-doubler-time");
  const elSlow = $("hud-slow"), elSlowTime = $("hud-slow-time");
  const elShieldBadge = $("hud-shield"), elShieldN = $("hud-shield-n");
  const elCombo = $("hud-combo");

  // --- Settings (persisted) ------------------------------------------------
  let reducedMotion = false, paused = false, easyMode = false;
  try {
    const s = JSON.parse(localStorage.getItem("lr_settings") || "{}");
    reducedMotion = !!s.reducedMotion;
    easyMode = !!s.easyMode;
  } catch (e) {}
  function saveSettings() { try { localStorage.setItem("lr_settings", JSON.stringify({ reducedMotion, easyMode })); } catch (e) {} }
  renderer.reducedMotion = reducedMotion;
  engine.assist = easyMode;

  // Single source of truth for difficulty — keeps the start-screen toggle, the
  // Settings checkbox, the engine, and storage all in sync.
  function setEasyMode(on) {
    easyMode = !!on;
    engine.assist = easyMode;
    reflectEasyMode();
    saveSettings();
  }
  function reflectEasyMode() {
    const me = $("mode-easy"), mc = $("mode-classic"), chk = $("set-easy");
    if (me) { me.classList.toggle("active", easyMode); me.setAttribute("aria-pressed", easyMode); }
    if (mc) { mc.classList.toggle("active", !easyMode); mc.setAttribute("aria-pressed", !easyMode); }
    if (chk) chk.checked = easyMode;
  }

  // --- Persistence / economy ----------------------------------------------
  function refreshLabels() {
    $("start-best").textContent = Shop.best;
    $("start-coins").textContent = Shop.coins;
    $("start-combo").textContent = Shop.bestCombo;
    reflectEasyMode();
  }
  // Push every equipped customization (paint, body design, lights, world) to the
  // 3D scene. Order matters: set paint/light first so a design rebuild picks them up.
  function applyCustomization() {
    renderer.setLights(Shop.equippedLight());
    renderer.setCar(Shop.equippedColors());
    renderer.setDesign(Shop.equippedDesign());
    renderer.setBackground(Shop.equippedBackground());
  }
  // onChange = cheap label refresh (fires on every coin); onSelect = re-apply the
  // 3D car/world (fires only when a customization is equipped). Split for perf.
  Shop.init({
    onChange: refreshLabels,
    onSelect: applyCustomization,
    onUnlock: (name) => { showToast("🔓 " + name + " unlocked!"); Sfx.unlock_sfx(); },
  });
  engine.best = Shop.best;
  applyCustomization();
  // Daily login bonus (after a short beat so it's noticed on the start screen).
  setTimeout(() => {
    const b = Shop.claimDailyBonus();
    if (b) { showToast(`🎁 Daily bonus +${b.amount}  ·  🔥 ${b.streak}-day streak`); Sfx.bonus(); }
  }, 700);

  // --- Screen state machine ------------------------------------------------
  let ui = "start";          // "start" | "shop" | "playing" | "over"
  let sawNewBest = false;
  let sawComboRecord = false;
  let deadAt = 0;

  function hideAll() {
    elStart.classList.add("hidden"); elShop.classList.add("hidden");
    elOver.classList.add("hidden"); elHud.classList.add("hidden");
    renderer.setShowcase(false);
  }
  function showStart() { ui = "start"; hideAll(); renderer.setShowcase(true); refreshLabels(); elStart.classList.remove("hidden"); }
  function showShop()  { ui = "shop";  hideAll(); renderer.setShowcase(true); Shop.renderGarage(); elShop.classList.remove("hidden"); }
  function showPlaying() {
    ui = "playing"; hideAll(); elHud.classList.remove("hidden");
    elHudScore.textContent = "0"; elHudCoins.textContent = "0"; elHudSpeed.textContent = "0";
    elDoubler.classList.add("hidden"); elSlow.classList.add("hidden"); elShieldBadge.classList.add("hidden");
    // First-run coaching: show a swipe hint until the player makes their first lane change ever.
    $("swipe-hint").classList.toggle("hidden", steeredEver);
  }
  function showOver() {
    ui = "over"; hideAll();
    $("over-score").textContent = engine.score;
    $("over-best").textContent = engine.best;
    $("over-coins").textContent = engine.runCoins;
    // Celebrate skill: show the best near-miss combo, but only if they built one (>=2).
    const bc = engine.bestCombo | 0;
    $("over-combo-val").textContent = bc;
    $("over-combo").classList.toggle("hidden", bc < 2);
    $("over-combo-rec").classList.toggle("hidden", !sawComboRecord);
    // Daily Challenge result line.
    if (dailyMode && lastDaily) {
      $("over-daily").textContent = "🗓️ Daily best: " + lastDaily.best + (lastDaily.isBest ? " — 🏆 new!" : "");
      $("over-daily").classList.remove("hidden");
    } else { $("over-daily").classList.add("hidden"); }
    $("new-best").classList.toggle("hidden", !sawNewBest);
    const sc = Shop.scores;
    $("over-scores").innerHTML = sc.length
      ? "<div class='lb-title'>🏁 Top runs</div>" + sc.map((s, i) => `<div class="lb-row"><span>${i + 1}</span><span>${s}</span></div>`).join("")
      : "";
    elOver.classList.remove("hidden");
  }

  // --- Actions -------------------------------------------------------------
  let dailyMode = false;          // current run is the seeded Daily Challenge
  let lastDaily = null;           // {best, isBest} from the last daily run, for the over screen
  let steeredEver = false;        // has the player ever changed lanes? (drives the first-run hint)
  try { steeredEver = !!localStorage.getItem("lr_steered"); } catch (e) {}

  function todayKey() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function todaySeed() { const d = new Date(); return (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) >>> 0; }

  function beginGame(daily) {
    dailyMode = !!daily;
    sawNewBest = false;
    sawComboRecord = false;
    engine.upgrades = Shop.upgrades;       // apply purchased perks for this run
    engine.best = Shop.best;
    engine.assist = dailyMode ? false : easyMode;   // Daily is always Classic so scores compare fairly
    engine.seed = dailyMode ? todaySeed() : null;   // deterministic course for the day, else random
    engine.reset();
    engine.start();
    applyCustomization();
    Sfx.unlock(); Sfx.engineStart();
    showPlaying();
  }

  function steer(dir) {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame(dailyMode);
    else if (engine.state === "playing") {
      const before = engine.player.lane;
      engine.steer(dir);
      if (engine.player.lane !== before) {            // a real lane change happened
        renderer.burst(0, 0, 7, "#d9d2c4", 90);       // dust kick
        renderer.kick(0.12); haptic(8);               // (engine's "steer" event is cleared by the
                                                      //  next update, so feedback lives here instead)
        if (!steeredEver) {                           // retire the first-run coachmark
          steeredEver = true;
          try { localStorage.setItem("lr_steered", "1"); } catch (_) {}
          $("swipe-hint").classList.add("hidden");
        }
      }
    }
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame(dailyMode);
  }
  function confirmAction() {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame(dailyMode);
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame(dailyMode);
  }

  // --- Input: swipe + tap (+ drag-to-rotate in showcase) -------------------
  const SWIPE_PX = 28;
  let downX = 0, downY = 0, lastX = 0, tracking = false, draggedShowcase = false;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault(); downX = lastX = e.clientX; downY = e.clientY; tracking = true; draggedShowcase = false;
    if (renderer.showcase) renderer.setDragging(true);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!tracking || !renderer.showcase) return;
    renderer.dragBy(e.clientX - lastX); lastX = e.clientX;
    if (Math.abs(e.clientX - downX) > 6) draggedShowcase = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!tracking) return; tracking = false;
    // In the Garage / start screen the car is a draggable turntable.
    if (renderer.showcase) {
      renderer.setDragging(false);
      if (!draggedShowcase) confirmAction();   // a tap (not a drag) → play; no-op in Garage
      return;
    }
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      steer(dx < 0 ? -1 : 1);
    } else if (engine.state === "playing") {
      const rect = canvas.getBoundingClientRect();
      steer((e.clientX - rect.left) / rect.width < 0.5 ? -1 : 1);
    } else {
      confirmAction();
    }
  });
  canvas.addEventListener("pointercancel", () => { tracking = false; renderer.setDragging(false); });

  elStart.addEventListener("pointerdown", (e) => { if (e.target === elStart) confirmAction(); });
  elOver.addEventListener("pointerdown", (e) => { if (e.target === elOver) confirmAction(); });

  $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); beginGame(false); });
  $("daily-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); beginGame(true); });
  $("again-btn").addEventListener("click", (e) => { e.stopPropagation(); if (engine.state === "dead") beginGame(dailyMode); });
  $("garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("over-garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("share-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const url = "https://erlightbourn-source.github.io/car-game/";
    const text = (dailyMode ? "I scored " + engine.score + " in today's Lane Rush Daily Challenge! 🗓️🚗"
                            : "I scored " + engine.score + " in Lane Rush! 🚗💨") + " Can you beat me?";
    try {
      if (navigator.share) { await navigator.share({ title: "Lane Rush", text, url }); }
      else { await navigator.clipboard.writeText(text + " " + url); showToast("🔗 Link copied!"); }
    } catch (err) { /* user dismissed the share sheet — ignore */ }
  });
  $("shop-back").addEventListener("click", (e) => { e.stopPropagation(); showStart(); });
  $("garage-prev").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); Shop.cycleDesign(-1); });
  $("garage-next").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); Shop.cycleDesign(1); });

  // --- Settings panel (pauses the game while open) ---
  function openSettings() {
    if (ui === "playing") paused = true;
    $("set-sfx").value = Math.round(Sfx.getSfxVolume() * 100);
    $("set-music").value = Math.round(Sfx.getMusicVolume() * 100);
    $("set-reduced").checked = reducedMotion;
    $("set-easy").checked = easyMode;
    $("screen-settings").classList.remove("hidden");
  }
  function closeSettings() {
    $("screen-settings").classList.add("hidden");
    if (paused) { paused = false; last = performance.now(); }
  }
  $("settings-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); openSettings(); });
  $("set-close").addEventListener("click", (e) => { e.stopPropagation(); closeSettings(); });
  $("set-sfx").addEventListener("input", (e) => Sfx.setSfxVolume(e.target.value / 100));
  $("set-music").addEventListener("input", (e) => Sfx.setMusicVolume(e.target.value / 100));
  $("set-reduced").addEventListener("change", (e) => { reducedMotion = e.target.checked; renderer.reducedMotion = reducedMotion; saveSettings(); });
  $("set-easy").addEventListener("change", (e) => setEasyMode(e.target.checked));
  $("mode-easy").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); setEasyMode(true); });
  $("mode-classic").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); setEasyMode(false); });

  // --- First-run tutorial coachmark ---
  $("tut-ok").addEventListener("click", (e) => {
    e.stopPropagation(); Sfx.unlock();
    try { localStorage.setItem("lr_tut", "1"); } catch (_) {}
    $("tutorial").classList.add("hidden");
  });

  // --- Input: keyboard -----------------------------------------------------
  window.addEventListener("keydown", (e) => {
    switch (e.code) {
      case "ArrowLeft": case "KeyA":  e.preventDefault(); if (ui === "shop") Shop.cycleDesign(-1); else steer(-1); break;
      case "ArrowRight": case "KeyD": e.preventDefault(); if (ui === "shop") Shop.cycleDesign(1); else steer(1); break;
      case "Space": case "Enter":     e.preventDefault(); confirmAction(); break;
      case "Escape":
        if (!$("screen-settings").classList.contains("hidden")) closeSettings();
        else if (ui === "shop") showStart();
        break;
      case "KeyM":                    toggleMute(); break;
    }
  });

  // --- Mute ----------------------------------------------------------------
  function toggleMute() {
    const muted = Sfx.toggleMute();
    $("mute-btn").textContent = muted ? "🔇" : "🔊";
    if (!muted && engine.state === "playing") Sfx.engineStart();
  }
  $("mute-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); });

  // --- Resize --------------------------------------------------------------
  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  // Flush any debounced coin save before the page is hidden/closed.
  window.addEventListener("pagehide", () => Shop.flush());
  document.addEventListener("visibilitychange", () => { if (document.hidden) Shop.flush(); });

  // --- Helpers for particle positions in screen space ----------------------
  function playerScreen() {
    const pp = CONFIG.FOCAL / (CONFIG.FOCAL + CONFIG.PLAYER_Z);
    const x = CONFIG.WIDTH / 2 + engine.player.laneFrac * CONFIG.ROAD_HALF_NEAR * pp + renderer.camShift * (1 - pp);
    const y = CONFIG.HORIZON_Y + (CONFIG.HEIGHT - CONFIG.HORIZON_Y) * pp;
    return { x, y };
  }

  // --- React to engine events ---------------------------------------------
  function handleEvents(events) {
    for (const ev of events) {
      if (ev.type === "start") {
        Sfx.engineStart();
      } else if (ev.type === "score") {
        elHudScore.textContent = ev.value;          // milestone drama is handled by the near-miss handler
      } else if (ev.type === "nearmiss") {
        Sfx.nearmiss();
        Shop.addCoins(ev.bonus);
        elHudCoins.textContent = engine.runCoins;
        expression("happy");
        showComboPop(ev.combo, ev.bonus, ev.milestone);
        renderer.burst(0, 0, ev.milestone ? 18 : 8, "#9bff5a", ev.milestone ? 200 : 120);
        haptic(ev.milestone ? [15, 30, 15] : 12);
        if (ev.milestone) { Sfx.milestone(); flashScreen(); renderer.kick(0.25); }   // dramatic streak moment
      } else if (ev.type === "coin") {
        Shop.addCoins(ev.gain || CONFIG.COIN_VALUE);
        Sfx.coin();
        expression("happy");
        renderer.burst(0, 0, 6, engine.doubler > 0 ? "#86e1ff" : "#ffe07a", 90);
        flyCoinToHud();                             // 2D coin flies to the HUD
      } else if (ev.type === "powerup") {
        if (ev.kind === "slow") {
          Sfx.slow(); showToast("🐌 Slow-mo!"); renderer.burst(0, 0, 20, "#57e08a", 180);
        } else if (ev.kind === "shield") {
          Sfx.shield(); showToast("🛡️ Shield up!"); renderer.burst(0, 0, 20, "#66ccff", 180);
        } else {
          Sfx.powerup(); showToast("💰 ×2 Coins!"); renderer.burst(0, 0, 22, "#ffd23f", 200);
        }
      } else if (ev.type === "bump") {
        // Clipped a pothole: a jolt, not a crash. Run continues.
        Sfx.bump();
        renderer.burst(0, 0, 14, "#7a5a3a", 150);   // dirt/debris kick
        renderer.kick(0.45); expression("ooh"); haptic([20, 30]);
        showToast("🕳️ Pothole!");
        elHudCoins.textContent = engine.runCoins;
      } else if (ev.type === "shieldhit") {
        Sfx.shield();
        renderer.burst(0, 0, 22, "#86e1ff", 180);
        renderer.kick(0.5); expression("ooh"); haptic(40);
      } else if (ev.type === "newbest") {
        sawNewBest = true;
        Shop.setBest(engine.best);
      } else if (ev.type === "crash") {
        Sfx.crash();
        renderer.burst(0, 0, 26, "#ff9d57", 220);
        renderer.kick(1.0); expression("ooh"); haptic([30, 40, 30]);
        deadAt = performance.now();
        // Record run → missions + leaderboard; toast any newly-completed mission.
        const res = Shop.recordRun({ score: engine.score, dodges: engine.passed, coins: engine.runCoins, bestCombo: engine.bestCombo, nearMisses: engine.nearMisses });
        sawComboRecord = !!res.comboRecord;
        lastDaily = dailyMode ? Shop.recordDaily(engine.score, todayKey()) : null;
        (res.completed || []).forEach((m, i) => setTimeout(() => { showToast("🎯 Goal done: +" + m.reward + "🪙"); Sfx.bonus(); }, 700 + i * 700));
        // Guard against a restart slipping in before this fires.
        setTimeout(() => { if (engine.state === "dead" && ui === "playing") showOver(); }, 550);
      }
    }
  }

  // --- Juice: toasts, coin-to-HUD flight, HUD pulse ------------------------
  // Caps keep the DOM bounded even under coin bursts / rapid events (1000s of
  // users on weak devices) — purely cosmetic elements, safe to drop.
  function showToast(text) {
    const wrap = document.getElementById("game-wrap");
    const existing = wrap.querySelectorAll(".toast");
    if (existing.length >= 3) existing[0].remove();   // never pile up
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    wrap.appendChild(t);
    t.addEventListener("animationend", () => t.remove());
  }

  function pulseHud() {
    const hud = document.querySelector(".hud-coins");
    if (!hud) return;
    hud.classList.remove("pulse"); void hud.offsetWidth; hud.classList.add("pulse");
  }

  function flyCoinToHud() {
    const hud = document.querySelector(".hud-coins");
    if (!hud) return;
    // Cap concurrent fly-coins so a coin burst can't flood the DOM.
    if (document.querySelectorAll(".fly-coin").length >= 14) { pulseHud(); return; }
    const start = renderer.carScreenPos();
    const r = hud.getBoundingClientRect();
    const end = { x: r.left + 14, y: r.top + r.height / 2 };
    const el = document.createElement("div");
    el.className = "fly-coin";
    el.textContent = "🪙";
    el.style.left = start.x + "px";
    el.style.top = start.y + "px";
    document.body.appendChild(el);
    const dx = end.x - start.x, dy = end.y - start.y;
    const anim = el.animate([
      { transform: "translate(-50%,-50%) scale(0.6)", opacity: 0.2 },
      { transform: "translate(-50%,-50%) scale(1.1)", opacity: 1, offset: 0.18 },
      { transform: `translate(calc(-50% + ${dx * 0.4}px), calc(-50% + ${dy * 0.4 - 50}px)) scale(1)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.4)`, opacity: 0.85 },
    ], { duration: 600, easing: "cubic-bezier(0.45,0,0.6,1)" });
    // Drive the HUD update + cleanup with timers (reliable) rather than relying
    // on the animation's onfinish, which can be throttled/skipped.
    const cleanup = () => { if (el.parentNode) el.remove(); };
    if (anim) { anim.onfinish = cleanup; anim.oncancel = cleanup; }
    setTimeout(() => { elHudCoins.textContent = engine.runCoins; pulseHud(); }, 520);
    setTimeout(cleanup, 1600);
  }

  // --- Mascot expression (auto-reverts to smile), haptics, combo popup -----
  let exprTimer = null;
  function expression(name) {
    renderer.setExpression(name);
    if (exprTimer) clearTimeout(exprTimer);
    if (name !== "smile") exprTimer = setTimeout(() => renderer.setExpression("smile"), 700);
  }
  function haptic(p) { try { if (!reducedMotion && navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function showComboPop(combo, bonus, milestone) {
    if (combo < 2) return;
    const el = document.createElement("div");
    el.className = "combo-pop" + (milestone ? " milestone" : "");
    el.textContent = milestone ? "🔥 ×" + combo + " COMBO!  +" + bonus + "🪙" : "×" + combo + "  +" + bonus + "🪙";
    document.getElementById("game-wrap").appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
  // Quick full-screen flash for dramatic moments (skipped if reduced-motion).
  function flashScreen() {
    if (reducedMotion) return;
    const f = document.createElement("div");
    f.className = "screen-flash";
    document.getElementById("game-wrap").appendChild(f);
    f.addEventListener("animationend", () => f.remove());
  }

  // --- Game loop -----------------------------------------------------------
  // The whole body is wrapped so a single bad frame can NEVER kill the loop
  // (an unhandled throw used to skip the re-schedule and freeze the game).
  let last = performance.now();
  let errCount = 0;
  let perfT = 0, perfN = 0, perfBad = 0;   // adaptive-quality watchdog
  function frame(now) {
    try {
      let dt = (now - last) / 1000; last = now;
      if (dt > 0.1) dt = 0.1;

      // GPU context lost, or game paused (settings open) → freeze, preserve run.
      if (renderer._contextLost || paused) { requestAnimationFrame(frame); return; }

      const events = engine.update(dt);
      handleEvents(events);
      renderer.render(engine, dt);

      if (engine.state === "playing") {
        const sp01 = (engine.speed - CONFIG.START_SPEED) / (CONFIG.MAX_SPEED - CONFIG.START_SPEED);
        Sfx.setEngine(Math.max(0, Math.min(1, sp01)));
        elHudSpeed.textContent = Math.round(engine.speed * CONFIG.KMH_PER_SPEED);
        if (engine.doubler > 0) { elDoublerTime.textContent = Math.ceil(engine.doubler); elDoubler.classList.remove("hidden"); }
        else elDoubler.classList.add("hidden");
        if (engine.slow > 0) { elSlowTime.textContent = Math.ceil(engine.slow); elSlow.classList.remove("hidden"); }
        else elSlow.classList.add("hidden");
        if (engine.shields > 0) { elShieldN.textContent = engine.shields; elShieldBadge.classList.remove("hidden"); }
        else elShieldBadge.classList.add("hidden");
        if (engine.combo >= 2) { elCombo.textContent = "🔥 ×" + engine.combo; elCombo.classList.remove("hidden"); }
        else elCombo.classList.add("hidden");
      }

      // Adaptive quality: if the device sustains poor FPS, step quality down so
      // it self-protects instead of overloading the GPU and crashing.
      perfT += dt; perfN++;
      if (perfT >= 1) {
        const avgMs = (perfT / perfN) * 1000;
        if (avgMs > 25) { if (++perfBad >= 2) { renderer.degrade(); perfBad = 0; } }
        else perfBad = 0;
        perfT = 0; perfN = 0;
      }
    } catch (err) {
      if (errCount++ < 3) console.error("frame error (recovered):", err);
    }
    requestAnimationFrame(frame);   // ALWAYS keep the loop alive
  }

  // --- Boot ----------------------------------------------------------------
  renderer.resize();
  showStart();
  requestAnimationFrame(frame);
  // First-run tutorial coachmark.
  try { if (!localStorage.getItem("lr_tut")) $("tutorial").classList.remove("hidden"); } catch (e) {}

  // Register the service worker so the game is installable + works offline (PWA).
  // Same-origin only (CSP-safe); failures are non-fatal — the game still runs.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Debug/inspection hook (handy for tuning and an automated test harness).
  window.ZippyGame = { engine, renderer, cfg: CONFIG, Shop, beginGame, steer, showShop, showStart };
})();
