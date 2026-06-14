/*
 * audio.js — Procedural Web Audio sound effects + a live engine drone.
 * No asset files, no copyright concerns. Lazily initialized on the first
 * user gesture (browser autoplay rules).
 *
 * API: Sfx.steer(), Sfx.pass(), Sfx.coin(), Sfx.milestone(), Sfx.shield(),
 *      Sfx.crash(), Sfx.engineStart(), Sfx.engineStop(),
 *      Sfx.setEngine(speed01), Sfx.toggleMute().
 */
const Sfx = (() => {
  let ctx = null;
  let muted = false;

  // Engine drone nodes (persistent oscillator while driving).
  let engOsc = null, engGain = null, engFilter = null, engOn = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function blip(f0, f1, dur, type = "square", gain = 0.12) {
    if (muted) return;
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  return {
    unlock() { ensure(); },

    steer() { blip(300, 520, 0.09, "sine", 0.09); },
    pass()  { blip(680, 680, 0.05, "triangle", 0.05); },
    coin() {                                                 // bright two-note chime
      blip(880, 880, 0.06, "square", 0.08);
      setTimeout(() => blip(1320, 1320, 0.09, "square", 0.08), 55);
    },
    milestone() {
      blip(660, 660, 0.09, "triangle", 0.12);
      setTimeout(() => blip(990, 990, 0.10, "triangle", 0.12), 70);
    },
    shield() {                                               // protective "whoomph"
      blip(180, 520, 0.18, "sine", 0.13);
      blip(360, 720, 0.18, "triangle", 0.07);
    },
    crash() {
      blip(220, 80, 0.30, "sawtooth", 0.14);
      blip(140, 60, 0.32, "square", 0.10);
    },

    // --- Engine drone -----------------------------------------------------
    engineStart() {
      if (muted) return;
      const ac = ensure(); if (!ac || engOn) return;
      engOsc = ac.createOscillator();
      engFilter = ac.createBiquadFilter();
      engGain = ac.createGain();
      engOsc.type = "sawtooth";
      engOsc.frequency.value = 60;
      engFilter.type = "lowpass";
      engFilter.frequency.value = 380;
      engGain.gain.value = 0.05;
      engOsc.connect(engFilter).connect(engGain).connect(ac.destination);
      engOsc.start();
      engOn = true;
    },
    setEngine(speed01) {
      if (!engOn || !ctx) return;
      const t = ctx.currentTime;
      engOsc.frequency.setTargetAtTime(55 + speed01 * 95, t, 0.1);
      engFilter.frequency.setTargetAtTime(360 + speed01 * 700, t, 0.1);
    },
    engineStop() {
      if (!engOn) return;
      try {
        const t = ctx.currentTime;
        engGain.gain.setTargetAtTime(0.0001, t, 0.15);
        engOsc.stop(t + 0.4);
      } catch (e) {}
      engOn = false; engOsc = null; engGain = null; engFilter = null;
    },

    toggleMute() {
      muted = !muted;
      if (muted) this.engineStop();
      else ensure();
      return muted;
    },
    isMuted() { return muted; },
  };
})();
