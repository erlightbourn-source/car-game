/*
 * audio.js — Web Audio: a gentle looping music track + procedural SFX, with
 * independent SFX / Music volume (for the settings panel). No asset files.
 * Lazily initialized on the first user gesture (browser autoplay rules).
 *
 * The old buzzy "engine drone" is gone (engineStart/Stop/setEngine are now
 * no-ops kept for call-site compatibility); music carries the soundscape.
 */
const Sfx = (() => {
  let ctx = null, muted = false;
  let sfxGain = null, musicGain = null;
  let sfxVol = 0.9, musicVol = 0.55;
  let musicTimer = null, nextNote = 0, step = 0;

  // Load persisted volumes.
  try {
    const s = JSON.parse(window.localStorage.getItem("lr_audio") || "{}");
    if (typeof s.sfx === "number") sfxVol = s.sfx;
    if (typeof s.music === "number") musicVol = s.music;
  } catch (e) {}
  function persist() {
    try { window.localStorage.setItem("lr_audio", JSON.stringify({ sfx: sfxVol, music: musicVol })); } catch (e) {}
  }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      sfxGain = ctx.createGain(); sfxGain.gain.value = muted ? 0 : sfxVol; sfxGain.connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.gain.value = muted ? 0 : musicVol; musicGain.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function blip(f0, f1, dur, type = "square", gain = 0.12) {
    if (muted) return;
    const ac = ensure(); if (!ac) return;
    const t0 = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // ---- Music: I–V–vi–IV in C, gentle 8th-note arpeggio + bass ----
  const BPM = 126, STEP = 30 / BPM;          // 8th-note length (s)
  const CH = [
    [261.63, 329.63, 392.00],  // C
    [196.00, 246.94, 293.66],  // G
    [220.00, 261.63, 329.63],  // Am
    [174.61, 220.00, 261.63],  // F
  ];
  function tone(freq, time, dur, type, gain) {
    if (muted || !ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(gain, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g).connect(musicGain);
    o.start(time); o.stop(time + dur + 0.02);
  }
  // Percussion via a shared noise buffer + a sine kick (routed through musicGain).
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 0.4);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function drum(time, type) {
    if (muted || !ctx) return;
    if (type === "kick") {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, time); o.frequency.exponentialRampToValueAtTime(45, time + 0.12);
      g.gain.setValueAtTime(0.16, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
      o.connect(g).connect(musicGain); o.start(time); o.stop(time + 0.18);
    } else {
      const src = ctx.createBufferSource(); src.buffer = noise();
      const f = ctx.createBiquadFilter(), g = ctx.createGain();
      if (type === "hat") {
        f.type = "highpass"; f.frequency.value = 7500;
        g.gain.setValueAtTime(0.04, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      } else { // snare
        f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.8;
        g.gain.setValueAtTime(0.09, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
      }
      src.connect(f).connect(g).connect(musicGain); src.start(time); src.stop(time + 0.22);
    }
  }
  // 32-step (8-bar) loop: bass + pad + arpeggio + drums, with a lead in the B half.
  function scheduleNote(time, s) {
    const chord = CH[Math.floor(s / 4) % 4];
    if (s % 4 === 0) {
      tone(chord[0] / 2, time, STEP * 3.6, "triangle", 0.085);                 // bass
      tone(chord[0], time, STEP * 3.8, "sine", 0.022);                         // pad
      tone(chord[1], time, STEP * 3.8, "sine", 0.018);
      tone(chord[2], time, STEP * 3.8, "sine", 0.018);
    }
    const arp = [0, 1, 2, 1][s % 4];
    tone(chord[arp] * 2, time, STEP * 0.85, "sine", 0.045);                    // sparkle
    tone(chord[arp], time, STEP * 1.3, "triangle", 0.04);                      // mid
    // drums
    if (s % 2 === 0) drum(time, "kick");
    drum(time, "hat");
    if (s % 4 === 2) drum(time, "snare");
    // lead melody only in the second half of the loop (variation)
    if (s >= 16) { const lead = [chord[2], 0, chord[1], chord[2]][s % 4]; if (lead) tone(lead * 2, time, STEP * 0.8, "square", 0.03); }
  }
  function startMusic() {
    const ac = ensure(); if (!ac || musicTimer) return;
    nextNote = ac.currentTime + 0.1; step = 0;
    musicTimer = setInterval(() => {
      if (!ctx) return;
      while (nextNote < ctx.currentTime + 0.15) {
        scheduleNote(nextNote, step);
        nextNote += STEP; step = (step + 1) % 32;
      }
    }, 25);
  }

  return {
    unlock() { ensure(); startMusic(); },
    startMusic,

    steer() {},                                              // intentionally silent
    pass() {},                                               // per-dodge tick removed
    coin()  { blip(880, 880, 0.06, "square", 0.07); setTimeout(() => blip(1320, 1320, 0.08, "square", 0.07), 50); },
    nearmiss() { blip(300, 900, 0.12, "sawtooth", 0.06); },  // risky-dodge whoosh
    milestone() { blip(660, 660, 0.09, "triangle", 0.11); setTimeout(() => blip(990, 990, 0.10, "triangle", 0.11), 70); },
    shield() { blip(180, 520, 0.18, "sine", 0.12); blip(360, 720, 0.18, "triangle", 0.06); },
    crash() { blip(220, 80, 0.30, "sawtooth", 0.13); blip(140, 60, 0.32, "square", 0.09); },
    bump() { blip(160, 70, 0.16, "sine", 0.12); blip(90, 50, 0.18, "triangle", 0.08); },  // pothole thud (softer than a crash)
    bonus() {
      blip(523, 523, 0.10, "triangle", 0.11);
      setTimeout(() => blip(659, 659, 0.10, "triangle", 0.11), 90);
      setTimeout(() => blip(784, 784, 0.10, "triangle", 0.11), 180);
      setTimeout(() => blip(1047, 1047, 0.16, "triangle", 0.12), 280);
    },
    unlock_sfx() { blip(660, 660, 0.10, "square", 0.09); setTimeout(() => blip(1047, 1047, 0.18, "square", 0.10), 95); },
    powerup() { blip(380, 1180, 0.26, "sawtooth", 0.11); setTimeout(() => blip(880, 1500, 0.20, "square", 0.07), 70); },
    slow() { blip(900, 260, 0.4, "sine", 0.11); blip(600, 180, 0.42, "triangle", 0.06); },

    // Deprecated engine-drone hooks (kept as no-ops so callers don't break).
    engineStart() { startMusic(); },
    engineStop() {},
    setEngine() {},

    // --- Volume / mute (settings panel) ---
    setSfxVolume(v) { sfxVol = Math.max(0, Math.min(1, v)); if (sfxGain && !muted) sfxGain.gain.value = sfxVol; persist(); },
    setMusicVolume(v) { musicVol = Math.max(0, Math.min(1, v)); if (musicGain && !muted) musicGain.gain.value = musicVol; persist(); },
    getSfxVolume() { return sfxVol; },
    getMusicVolume() { return musicVol; },
    toggleMute() {
      muted = !muted;
      if (ctx) { sfxGain.gain.value = muted ? 0 : sfxVol; musicGain.gain.value = muted ? 0 : musicVol; }
      if (!muted) { ensure(); startMusic(); }
      return muted;
    },
    isMuted() { return muted; },
  };
})();
