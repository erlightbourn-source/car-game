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

  // --- Persistence / economy ----------------------------------------------
  function refreshLabels() {
    $("start-best").textContent = Shop.best;
    $("start-coins").textContent = Shop.coins;
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
    onUnlock: (name) => { showToast("🔓 " + name + " unlocked!"); Sfx.unlock(); },
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
  }
  function showOver() {
    ui = "over"; hideAll();
    $("over-score").textContent = engine.score;
    $("over-best").textContent = engine.best;
    $("over-coins").textContent = engine.runCoins;
    $("new-best").classList.toggle("hidden", !sawNewBest);
    elOver.classList.remove("hidden");
  }

  // --- Actions -------------------------------------------------------------
  function beginGame() {
    sawNewBest = false;
    engine.upgrades = Shop.upgrades;       // apply purchased perks for this run
    engine.best = Shop.best;
    engine.reset();
    engine.start();
    applyCustomization();
    Sfx.unlock(); Sfx.engineStart();
    showPlaying();
  }

  function steer(dir) {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame();
    else if (engine.state === "playing") engine.steer(dir);
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame();
  }
  function confirmAction() {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame();
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame();
  }

  // --- Input: swipe + tap --------------------------------------------------
  const SWIPE_PX = 28;
  let downX = 0, downY = 0, tracking = false;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault(); downX = e.clientX; downY = e.clientY; tracking = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!tracking) return; tracking = false;
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
  canvas.addEventListener("pointercancel", () => { tracking = false; });

  elStart.addEventListener("pointerdown", (e) => { if (e.target === elStart) confirmAction(); });
  elOver.addEventListener("pointerdown", (e) => { if (e.target === elOver) confirmAction(); });

  $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); beginGame(); });
  $("again-btn").addEventListener("click", (e) => { e.stopPropagation(); if (engine.state === "dead") beginGame(); });
  $("garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("over-garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("shop-back").addEventListener("click", (e) => { e.stopPropagation(); showStart(); });

  // --- Input: keyboard -----------------------------------------------------
  window.addEventListener("keydown", (e) => {
    switch (e.code) {
      case "ArrowLeft": case "KeyA":  e.preventDefault(); steer(-1); break;
      case "ArrowRight": case "KeyD": e.preventDefault(); steer(1); break;
      case "Space": case "Enter":     e.preventDefault(); confirmAction(); break;
      case "Escape":                  if (ui === "shop") showStart(); break;
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
      } else if (ev.type === "steer") {
        renderer.burst(0, 0, 7, "#d9d2c4", 90);   // dust kick only (no sound)
      } else if (ev.type === "score") {
        elHudScore.textContent = ev.value;
        if (ev.value % 5 === 0) Sfx.milestone(); else Sfx.pass();
      } else if (ev.type === "coin") {
        Shop.addCoins(ev.gain || CONFIG.COIN_VALUE);
        Sfx.coin();
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
      } else if (ev.type === "shieldhit") {
        Sfx.shield();
        const p = playerScreen();
        renderer.burst(p.x, p.y - 24, 22, "#86e1ff", 180);
      } else if (ev.type === "newbest") {
        sawNewBest = true;
        Shop.setBest(engine.best);
      } else if (ev.type === "crash") {
        Sfx.crash(); Sfx.engineStop();
        const p = playerScreen();
        renderer.burst(p.x, p.y - 30, 26, "#ff9d57", 220);
        deadAt = performance.now();
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

  // --- Game loop -----------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;

    const events = engine.update(dt);
    handleEvents(events);
    renderer.render(engine, dt);

    if (engine.state === "playing") {
      const sp01 = (engine.speed - CONFIG.START_SPEED) / (CONFIG.MAX_SPEED - CONFIG.START_SPEED);
      Sfx.setEngine(Math.max(0, Math.min(1, sp01)));
      elHudSpeed.textContent = Math.round(engine.speed * CONFIG.KMH_PER_SPEED);
      // Power-up status badges
      if (engine.doubler > 0) { elDoublerTime.textContent = Math.ceil(engine.doubler); elDoubler.classList.remove("hidden"); }
      else elDoubler.classList.add("hidden");
      if (engine.slow > 0) { elSlowTime.textContent = Math.ceil(engine.slow); elSlow.classList.remove("hidden"); }
      else elSlow.classList.add("hidden");
      if (engine.shields > 0) { elShieldN.textContent = engine.shields; elShieldBadge.classList.remove("hidden"); }
      else elShieldBadge.classList.add("hidden");
    }
    requestAnimationFrame(frame);
  }

  // --- Boot ----------------------------------------------------------------
  renderer.resize();
  showStart();
  requestAnimationFrame(frame);

  // Debug/inspection hook (handy for tuning and an automated test harness).
  window.ZippyGame = { engine, renderer, cfg: CONFIG, Shop, beginGame, steer, showShop, showStart };
})();
