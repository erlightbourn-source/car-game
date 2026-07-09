/*
 * shop.js — Coin economy, persistence, and the tabbed Garage UI.
 *
 * Customization categories (each coin-priced, owned/equipped tracked separately):
 *   paint   → CARS        (body colour)
 *   design  → DESIGNS     (car body shape)
 *   light   → LIGHTS      (taillight colour)
 *   bg      → BACKGROUNDS (world / theme)
 * Plus perks: magnet, shield.
 *
 * Kept separate from gameplay so the engine stays pure and persistence is easy
 * to swap for UserDefaults on iOS. onChange() fires on every mutation so the
 * host can live-update the 3D scene and on-screen labels.
 */
const Shop = (() => {
  const KEY = "zippy_save_v1";
  const DEFAULTS = {
    best: 0, coins: 0,
    owned: ["red"], car: "red",                 // paint (legacy keys)
    designOwned: ["hatch"], design: "hatch",
    lightOwned: ["red"], light: "red",
    bgOwned: ["day"], bg: "day",
    magnet: 0, shield: 0,
    lastBonus: "", streak: 0, maxStreak: 0,
    bestCombo: 0,
    dailyBest: 0, dailyBestDay: "",
    missions: [], missionsDay: "", scores: [],
  };
  let data = { ...DEFAULTS };
  let mem = null;
  let onChange = () => {};   // cheap: refresh coin/best labels (fires often)
  let onSelect = () => {};   // expensive: re-apply 3D customization (fires only on equip)
  let onUnlock = () => {};
  let tab = "paint";
  let saveTimer = null;

  // Category descriptors → which catalog + which save keys.
  const CATS = {
    paint:  { list: () => CARS,        ownedKey: "owned",       selKey: "car" },
    design: { list: () => DESIGNS,     ownedKey: "designOwned", selKey: "design" },
    light:  { list: () => LIGHTS,      ownedKey: "lightOwned",  selKey: "light" },
    bg:     { list: () => BACKGROUNDS, ownedKey: "bgOwned",     selKey: "bg" },
  };
  const TABS = [
    ["paint", "🎨 Paint"], ["design", "🚗 Body"], ["light", "💡 Lights"],
    ["bg", "🌅 World"], ["perks", "⚙️ Perks"], ["missions", "🎯 Goals"],
  ];

  // ---- Daily missions + local leaderboard --------------------------------
  const MISSION_POOL = [
    { type: "dodge", reward: 60, targets: [40, 60, 80], label: (n) => `Dodge ${n} obstacles` },
    { type: "coins", reward: 70, targets: [80, 120, 160], label: (n) => `Collect ${n} coins` },
    { type: "combo", reward: 80, targets: [6, 8, 10], label: (n) => `Hit a ${n}× near-miss combo` },
    { type: "score", reward: 90, targets: [80, 150, 250], label: (n) => `Reach score ${n} in one run` },
  ];
  function generateMissions() {
    const pool = MISSION_POOL.slice();
    const out = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const t = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const target = t.targets[Math.floor(Math.random() * t.targets.length)];
      out.push({ type: t.type, target, reward: t.reward, progress: 0, done: false, text: t.label(target) });
    }
    return out;
  }
  function ensureMissions() {
    const today = dayKey(new Date());
    if (data.missionsDay !== today || !Array.isArray(data.missions) || data.missions.length === 0) {
      data.missions = generateMissions();
      data.missionsDay = today;
      persist();
    }
  }
  // Called at the end of a run; advances missions + leaderboard. Returns newly-completed.
  function recordRun(stats) {
    ensureMissions();
    const completed = [];
    for (const m of data.missions) {
      if (m.done) continue;
      if (m.type === "dodge") m.progress += (stats.dodges != null ? stats.dodges : stats.score);
      else if (m.type === "coins") m.progress += stats.coins;
      else if (m.type === "combo") m.progress = Math.max(m.progress, stats.bestCombo);
      else if (m.type === "score") m.progress = Math.max(m.progress, stats.score);
      if (m.progress >= m.target) { m.done = true; data.coins += m.reward; completed.push(m); }
    }
    if (stats.score > 0) {
      data.scores.push(stats.score);
      data.scores.sort((a, b) => b - a);
      data.scores = data.scores.slice(0, 5);
    }
    // Lifetime-best near-miss combo — a durable, skill-based personal record.
    const runCombo = stats.bestCombo | 0;
    const comboRecord = runCombo >= 2 && runCombo > (data.bestCombo | 0);
    if (comboRecord) data.bestCombo = runCombo;
    persist(); onChange();
    return { completed, comboRecord };
  }
  const DESIGN_EMOJI = { hatch: "🚗", sport: "🏎️", pickup: "🛻", van: "🚐", classic: "🚙", roadster: "🚘", muscle: "💪" };

  function load() {
    try {
      const raw = window.localStorage.getItem(KEY);
      data = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch (e) { data = mem ? { ...mem } : { ...DEFAULTS }; }
    // Guard each owned list + default selection.
    for (const k of ["paint", "design", "light", "bg"]) {
      const c = CATS[k];
      if (!Array.isArray(data[c.ownedKey])) data[c.ownedKey] = [];
      const def = DEFAULTS[c.ownedKey][0];
      if (data[c.ownedKey].indexOf(def) < 0) data[c.ownedKey].push(def);
      if (!c.list().some((x) => x.id === data[c.selKey])) data[c.selKey] = def;
    }
    return data;
  }
  function persist() {
    mem = { ...data };
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { window.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }
  // Coalesce frequent writes (e.g. coin banking during a magnet burst) into one
  // localStorage write per second — synchronous storage I/O can jank weak devices.
  function persistSoon() {
    mem = { ...data };
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 1000);
  }

  const hex = (n) => "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  function byId(list, id) { return list.find((x) => x.id === id); }

  function equippedColors() {
    const c = byId(CARS, data.car) || CARS[0];
    return { body: c.body, roof: c.roof, bumper: c.bumper };
  }
  function equippedDesign() { return data.design; }
  function equippedLight() { return byId(LIGHTS, data.light) || LIGHTS[0]; }
  function equippedBackground() { return byId(BACKGROUNDS, data.bg) || BACKGROUNDS[0]; }

  // Buy (if affordable) and/or equip an item in a category.
  function buyOrEquip(cat, id) {
    const c = CATS[cat]; if (!c) return;
    const item = byId(c.list(), id); if (!item) return;
    if (data[c.selKey] === id) return;                 // already equipped
    const owned = data[c.ownedKey];
    if (owned.indexOf(id) >= 0) {
      data[c.selKey] = id;                             // own it → just equip
    } else if (data.coins >= item.price) {
      data.coins -= item.price; owned.push(id); data[c.selKey] = id;
      onUnlock(item.name);                             // toast + unlock sound (host)
    } else { return; }                                 // can't afford
    persist(); onChange(); onSelect(); renderGarage();
  }

  // Grant a once-per-day coin bonus with a consecutive-day streak multiplier.
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function claimDailyBonus() {
    const today = new Date();
    const key = dayKey(today);
    if (data.lastBonus === key) return null;           // already claimed today
    const y = new Date(today); y.setDate(today.getDate() - 1);
    data.streak = (data.lastBonus === dayKey(y)) ? (data.streak | 0) + 1 : 1;
    data.maxStreak = Math.max(data.maxStreak | 0, data.streak);
    data.lastBonus = key;
    const amount = 25 + Math.min(data.streak - 1, 5) * 15;   // 25 → 100
    data.coins += amount;
    persist(); onChange();
    return { amount, streak: data.streak };
  }

  // Streak data for the Garage calendar.
  const STREAK_AMOUNTS = [25, 40, 55, 70, 85, 100, 100];
  function streakInfo() {
    return { streak: data.streak | 0, maxStreak: data.maxStreak | 0,
      claimedToday: data.lastBonus === dayKey(new Date()), amounts: STREAK_AMOUNTS };
  }

  // ---- UI -----------------------------------------------------------------
  // The daily-streak calendar lives in the Perks tab so the customization tabs
  // stay short and the spinning car preview is clearly visible.
  function buildStreakNode() {
    const wrap = document.createElement("div");
    wrap.className = "streak";
    const s = data.streak | 0, best = data.maxStreak | 0;
    let cells = '<div class="streak-cells">';
    for (let i = 0; i < STREAK_AMOUNTS.length; i++) {
      const day = i + 1;
      const cls = "streak-cell" + (day <= s ? " on" : "") + (day === s ? " today" : "");
      cells += `<div class="${cls}"><span class="sc-day">D${day}</span><span class="sc-amt">🪙${STREAK_AMOUNTS[i]}</span></div>`;
    }
    cells += "</div>";
    const note = streakInfo().claimedToday
      ? `🔥 ${s}-day streak · come back tomorrow!`
      : "🎁 Daily bonus ready — auto-claimed on launch!";
    wrap.innerHTML = `<div class="streak-title">${note}` +
      (best > 1 ? ` <span class="streak-best">Best: ${best}🔥</span>` : "") + `</div>` + cells;
    return wrap;
  }

  function renderGarage() {
    document.getElementById("shop-coins").textContent = data.coins;
    renderTabs();
    const host = document.getElementById("shop-items");
    host.innerHTML = "";
    if (tab === "perks") {
      host.appendChild(buildStreakNode());
      host.appendChild(upgradeRow("🧲 Coin Magnet", "magnet", CONFIG.MAGNET_PRICES, "Pulls coins in from nearby lanes"));
      host.appendChild(upgradeRow("🛡️ Shield", "shield", CONFIG.SHIELD_PRICES, "Absorbs a crash so you keep driving"));
    } else if (tab === "missions") {
      ensureMissions();
      host.appendChild(buildStreakNode());
      for (const m of data.missions) host.appendChild(buildMissionNode(m));
    } else {
      renderCatalog(host, tab);
    }
  }

  function buildMissionNode(m) {
    const row = document.createElement("div");
    row.className = "upg-row" + (m.done ? " done" : "");
    const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
    row.innerHTML =
      `<div class="upg-info"><div class="upg-name">${m.done ? "✅ " : "🎯 "}${m.text}</div>` +
      `<div class="mbar"><div class="mbar-fill" style="width:${pct}%"></div></div>` +
      `<div class="upg-desc">${Math.min(m.progress, m.target)} / ${m.target}</div></div>` +
      `<div class="upg-action"><span class="${m.done ? "upg-max" : "mreward"}">${m.done ? "DONE" : "🪙 " + m.reward}</span></div>`;
    return row;
  }

  function renderTabs() {
    const bar = document.getElementById("shop-tabs");
    bar.innerHTML = "";
    for (const [id, label] of TABS) {
      const b = document.createElement("button");
      b.className = "tab" + (tab === id ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => { tab = id; renderGarage(); });
      bar.appendChild(b);
    }
  }

  function renderCatalog(host, cat) {
    const c = CATS[cat];
    const grid = document.createElement("div");
    grid.className = "item-grid";
    for (const item of c.list()) {
      const owned = data[c.ownedKey].indexOf(item.id) >= 0;
      const equipped = data[c.selKey] === item.id;
      const el = document.createElement("button");
      el.className = "item" + (equipped ? " equipped" : "") + ((!owned && data.coins < item.price) ? " locked" : "");

      let vis = "";
      if (cat === "paint") vis = `<span class="chip" style="background:${item.body}"></span>`;
      else if (cat === "light") vis = `<span class="chip" style="background:${hex(item.color)};box-shadow:0 0 8px ${hex(item.emissive)}"></span>`;
      else if (cat === "bg") vis = `<span class="chip" style="background:linear-gradient(160deg,${hex(item.sky[0])},${hex(item.sky[2])} 70%,${hex(item.grass)})"></span>`;
      else vis = `<span class="emoji">${DESIGN_EMOJI[item.id] || "🚗"}</span>`;

      const need = item.price - data.coins;
      const locked = !owned && need > 0;
      el.innerHTML = vis +
        `<span class="item-name">${item.name}</span>` +
        `<span class="item-tag">${equipped ? "Equipped" : owned ? "Select" : "🪙 " + item.price}</span>` +
        // Show how close you are so an unaffordable item reads as a goal, not a wall.
        (locked ? `<span class="item-need">🪙 ${need} to go</span>` : "");
      if (locked) el.title = `${item.name} costs ${item.price} coins — ${need} more to go`;
      el.addEventListener("click", () => buyOrEquip(cat, item.id));
      grid.appendChild(el);
    }
    host.appendChild(grid);
  }

  function upgradeRow(label, key, prices, desc) {
    const maxLevel = prices.length - 1;
    const level = data[key] | 0;
    const row = document.createElement("div");
    row.className = "upg-row";
    let dots = "";
    for (let i = 1; i <= maxLevel; i++) dots += `<span class="dot ${i <= level ? "on" : ""}"></span>`;
    let btn;
    if (level >= maxLevel) btn = `<span class="upg-max">MAX</span>`;
    else {
      const price = prices[level + 1];
      btn = `<button class="upg-buy${data.coins >= price ? "" : " locked"}">🪙 ${price}</button>`;
    }
    row.innerHTML =
      `<div class="upg-info"><div class="upg-name">${label}</div>` +
      `<div class="upg-desc">${desc}</div><div class="dots">${dots}</div></div>` +
      `<div class="upg-action">${btn}</div>`;
    const buy = row.querySelector(".upg-buy");
    if (buy) buy.addEventListener("click", () => {
      const price = prices[level + 1];
      if (level >= maxLevel || data.coins < price) return;
      data.coins -= price; data[key] = level + 1; Sfx.coin();
      persist(); onChange(); renderGarage();
    });
    return row;
  }

  return {
    init(opts) {
      onChange = (opts && opts.onChange) || (() => {});
      onSelect = (opts && opts.onSelect) || (() => {});
      onUnlock = (opts && opts.onUnlock) || (() => {});
      load();
    },
    claimDailyBonus, streakInfo, recordRun,
    // Daily Challenge best score, scoped to a day key (resets each new day).
    dailyBest(dayK) { return (data.dailyBestDay === dayK) ? (data.dailyBest | 0) : 0; },
    recordDaily(score, dayK) {
      const prev = (data.dailyBestDay === dayK) ? (data.dailyBest | 0) : 0;
      const isBest = score > prev;
      if (data.dailyBestDay !== dayK) data.dailyBestDay = dayK;
      if (isBest) data.dailyBest = score;
      persist(); onChange();
      return { best: Math.max(prev, score), isBest };
    },
    get scores() { return data.scores || []; },
    // Flip the equipped car to the prev/next OWNED design (Garage arrows / keys).
    cycleDesign(dir) {
      const owned = DESIGNS.filter((d) => data.designOwned.indexOf(d.id) >= 0);
      if (owned.length < 2) return false;
      let i = owned.findIndex((d) => d.id === data.design);
      if (i < 0) i = 0;
      i = (i + dir + owned.length) % owned.length;
      data.design = owned[i].id;
      persist(); onChange(); onSelect(); renderGarage();
      return true;
    },
    flush() { if (saveTimer) persist(); },   // force-write any pending coins (page hide)
    get coins() { return data.coins; },
    get best() { return data.best; },
    get bestCombo() { return data.bestCombo | 0; },
    get upgrades() { return { magnet: data.magnet | 0, shield: data.shield | 0 }; },
    equippedColors, equippedDesign, equippedLight, equippedBackground,
    addCoins(n) { data.coins += n; persistSoon(); onChange(); },
    setBest(v) { if (v > data.best) { data.best = v; persist(); onChange(); } },
    renderGarage,
  };
})();
