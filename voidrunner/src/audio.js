// Every sound in VOIDRUNNER is synthesised in the browser. No audio files,
// no loading screen, and the soundtrack never repeats exactly.

const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.musicOn = true;
    this.sfxOn = true;
    this.intensity = 0;
    this.playing = false;
    this.tempo = 124;
    this.root = 45;
    this.scale = [0, 3, 5, 7, 10];
    this.bright = 0.4;
    this._step = 0;
    this._next = 0;
    this._timer = null;
    this._speed01 = 0;
  }

  /** Must be called from inside a user gesture. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { return false; }
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.ready = true;
    return true;
  }

  _build() {
    const ctx = this.ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.comp);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? 0.5 : 0;
    this.musicBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxOn ? 0.85 : 0;
    this.sfxBus.connect(this.master);

    // A cheap plate-ish send so nothing sounds bone dry.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(1.7, 2.6);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.34;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);

    this.noise = this._noiseBuffer(2);

    // Engine drone.
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilt = ctx.createBiquadFilter();
    this.engFilt.type = 'lowpass';
    this.engFilt.frequency.value = 400;
    this.engFilt.Q.value = 3;
    this.engGain.connect(this.engFilt);
    this.engFilt.connect(this.master);

    this.eng = [];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'square' : 'sawtooth';
      o.frequency.value = 48 + i * 0.6;
      o.detune.value = (i - 1) * 11;
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.16 : 0.4;
      o.connect(g); g.connect(this.engGain);
      o.start();
      this.eng.push(o);
    }
    const ns = ctx.createBufferSource();
    ns.buffer = this.noise;
    ns.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 900;
    nf.Q.value = 0.6;
    const ng = ctx.createGain();
    ng.gain.value = 0.08;
    ns.connect(nf); nf.connect(ng); ng.connect(this.engGain);
    ns.start();
    this.engNoiseGain = ng;
    this.engNoiseFilt = nf;
  }

  _noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return b;
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.05);
  }

  setSfx(on) {
    this.sfxOn = on;
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.05);
  }

  setZone(z) {
    if (!z) return;
    this.root = z.music.root;
    this.scale = z.music.scale;
    this.tempo = z.music.tempo;
    this.bright = z.music.bright;
  }

  setIntensity(v) { this.intensity = v; }

  setEngine(speed01, overdrive) {
    if (!this.ready) return;
    this._speed01 = speed01;
    const t = this.ctx.currentTime;
    const s = speed01 + (overdrive ? 0.45 : 0);
    this.engGain.gain.setTargetAtTime(this.playing ? 0.16 + s * 0.13 : 0, t, 0.12);
    this.engFilt.frequency.setTargetAtTime(260 + s * 1500, t, 0.15);
    this.engNoiseFilt.frequency.setTargetAtTime(700 + s * 2600, t, 0.15);
    this.engNoiseGain.gain.setTargetAtTime(0.04 + s * 0.10, t, 0.15);
    for (let i = 0; i < this.eng.length; i++) {
      this.eng[i].frequency.setTargetAtTime((40 + s * 46) * (i === 2 ? 2 : 1), t, 0.18);
    }
  }

  start() {
    if (!this.ready || this.playing) return;
    this.playing = true;
    this._step = 0;
    this._next = this.ctx.currentTime + 0.08;
    if (!this._timer) this._timer = setInterval(() => this._tick(), 26);
  }

  stop() {
    this.playing = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.ready) this.engGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  /* --------------------------- sequencer --------------------------- */

  _tick() {
    if (!this.playing || !this.ready) return;
    const ctx = this.ctx;
    const spb = 60 / this.tempo;
    const stepDur = spb / 4;           // sixteenths
    while (this._next < ctx.currentTime + 0.14) {
      this._playStep(this._step, this._next, stepDur);
      this._next += stepDur;
      this._step++;
    }
  }

  _playStep(step, t, dur) {
    const I = this.intensity;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const sc = this.scale;
    const deg = (n) => {
      const o = Math.floor(n / sc.length);
      return this.root + sc[((n % sc.length) + sc.length) % sc.length] + o * 12;
    };

    // Kick
    if (s % 4 === 0 || (s === 14 && bar % 2 === 1)) this._kick(t, 0.9);
    // Hats
    if (s % 2 === 1) this._hat(t, s % 4 === 3 ? 0.30 : 0.16, 0.03);
    if (I > 0.35 && s % 2 === 0 && s % 4 !== 0) this._hat(t, 0.10, 0.02);
    // Snare
    if (s === 4 || s === 12) this._snare(t, 0.5 + I * 0.2);

    // Bass on the beat
    if (s % 4 === 0) {
      const pat = [0, 0, 4, 2, 0, 5, 3, 1];
      const n = deg(pat[(bar * 4 + s / 4) % pat.length] - 7);
      this._bass(t, NOTE(n), dur * 3.6, 0.34);
    }

    // Arpeggio - the melodic layer only fills in as the run heats up
    if (I > 0.08) {
      const seed = (bar * 16 + s) * 2654435761 % 2147483647;
      const r = (seed % 1000) / 1000;
      const density = 0.34 + I * 0.5;
      if (r < density) {
        const shape = [0, 2, 4, 2, 5, 4, 2, 0, 3, 5, 7, 5, 4, 2, 1, 0];
        const n = deg(shape[s] + (bar % 3 === 2 ? 2 : 0)) + 12;
        this._pluck(t, NOTE(n), dur * (r < 0.2 ? 2 : 1) * 0.9, 0.10 + I * 0.10);
      }
    }

    // Pad swell at the top of every second bar
    if (s === 0 && bar % 2 === 0) {
      this._pad(t, [deg(0) - 12, deg(2) - 12, deg(4) - 12], (60 / this.tempo) * 8, 0.045 + I * 0.03);
    }
  }

  /* ----------------------------- voices ---------------------------- */

  _env(t, a, d, peak, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(dest || this.musicBus);
    return g;
  }

  _kick(t, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = this._env(t, 0.004, 0.24, 0.55 * v);
    o.connect(g);
    o.start(t); o.stop(t + 0.3);
  }

  _hat(t, v, len) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 1.8;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7200;
    const g = this._env(t, 0.002, len, v * 0.4);
    s.connect(f); f.connect(g);
    s.start(t, Math.random() * 1.5); s.stop(t + len + 0.02);
  }

  _snare(t, v) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.8;
    const g = this._env(t, 0.003, 0.14, v * 0.28);
    s.connect(f); f.connect(g);
    g.connect(this.verb);
    s.start(t, Math.random()); s.stop(t + 0.2);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.09);
    const g2 = this._env(t, 0.003, 0.09, v * 0.14);
    o.connect(g2);
    o.start(t); o.stop(t + 0.14);
  }

  _bass(t, f, len, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f * 0.5;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(160 + this.bright * 300, t);
    flt.frequency.exponentialRampToValueAtTime(90, t + len);
    flt.Q.value = 6;
    const g = this._env(t, 0.01, len, v);
    o.connect(flt); o2.connect(flt); flt.connect(g);
    o.start(t); o.stop(t + len + 0.05);
    o2.start(t); o2.stop(t + len + 0.05);
  }

  _pluck(t, f, len, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = this.bright > 0.6 ? 'triangle' : 'sawtooth';
    o.frequency.value = f;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(1200 + this.bright * 3600, t);
    flt.frequency.exponentialRampToValueAtTime(600, t + len);
    const g = this._env(t, 0.006, len * 1.6, v);
    o.connect(flt); flt.connect(g);
    g.connect(this.verb);
    o.start(t); o.stop(t + len * 2 + 0.05);
  }

  _pad(t, notes, len, v) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + len * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    g.connect(this.musicBus);
    g.connect(this.verb);
    for (const n of notes) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = NOTE(n);
        o.detune.value = det;
        o.connect(g);
        o.start(t); o.stop(t + len + 0.1);
      }
    }
  }

  /* ------------------------------ sfx ------------------------------ */

  _blip(f0, f1, len, v, type = 'sine', verb = 0.2) {
    if (!this.ready || !this.sfxOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len);
    const g = this._env(t, 0.005, len, v, this.sfxBus);
    o.connect(g);
    if (verb > 0) {
      const vg = ctx.createGain();
      vg.gain.value = verb;
      g.connect(vg); vg.connect(this.verb);
    }
    o.start(t); o.stop(t + len + 0.05);
  }

  cell(combo = 0) {
    const n = 72 + Math.min(combo, 14) * 1;
    this._blip(NOTE(n), NOTE(n + 7), 0.09, 0.16, 'triangle', 0.25);
  }

  graze(combo = 0) {
    const n = 79 + Math.min(combo, 18);
    this._blip(NOTE(n), NOTE(n + 3), 0.05, 0.07, 'square', 0.15);
  }

  multUp(level) {
    const n = 67 + level * 2;
    this._blip(NOTE(n), NOTE(n + 12), 0.22, 0.14, 'triangle', 0.4);
  }

  shield() { this._blip(NOTE(60), NOTE(79), 0.3, 0.2, 'triangle', 0.4); }

  hit() {
    if (!this.ready || !this.sfxOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2600, t);
    f.frequency.exponentialRampToValueAtTime(140, t + 0.5);
    const g = this._env(t, 0.003, 0.55, 0.5, this.sfxBus);
    s.connect(f); f.connect(g); g.connect(this.verb);
    s.start(t, Math.random()); s.stop(t + 0.7);
    this._blip(180, 38, 0.45, 0.3, 'sawtooth', 0.3);
  }

  shatter() {
    if (!this.ready || !this.sfxOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 1.4;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    f.Q.value = 0.7;
    const g = this._env(t, 0.002, 0.28, 0.34, this.sfxBus);
    s.connect(f); f.connect(g);
    s.start(t, Math.random()); s.stop(t + 0.35);
  }

  overdrive() {
    if (!this.ready || !this.sfxOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(NOTE(this.root + 12 + i * 7), t);
      o.frequency.exponentialRampToValueAtTime(NOTE(this.root + 24 + i * 7), t + 0.5);
      const g = this._env(t, 0.02, 0.9, 0.13, this.sfxBus);
      o.connect(g); g.connect(this.verb);
      o.start(t); o.stop(t + 1.0);
    }
  }

  zone() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((iv, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = NOTE(this.root + 12 + iv);
      const g = this._env(t + i * 0.07, 0.01, 0.5, 0.12, this.sfxBus);
      o.connect(g); g.connect(this.verb);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.6);
    });
  }

  gameOver() {
    if (!this.ready || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    [0, -3, -7, -12].forEach((iv, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = NOTE(this.root + 12 + iv);
      const g = this._env(t + i * 0.14, 0.02, 0.8, 0.13, this.sfxBus);
      o.connect(g); g.connect(this.verb);
      o.start(t + i * 0.14); o.stop(t + i * 0.14 + 1.0);
    });
  }

  ui(up = true) { this._blip(up ? 620 : 420, up ? 880 : 300, 0.07, 0.10, 'square', 0.1); }
}
