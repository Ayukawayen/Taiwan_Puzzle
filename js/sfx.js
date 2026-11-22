// TPSfx：遊戲音效（Web Audio 即時合成，不需要音效檔）
// 用法：const SFX = TPSfx.create({ load: () => 偏好設定物件或 null, save: (pref) => {...} })
// 建立時會在 window 掛上 pointerdown／keydown 監聽，於第一次互動時解鎖 AudioContext
(function (root) {
  "use strict";

  function create(opts) {
    const pref = Object.assign({ on: true, vol: 0.8 }, opts.load() || {});
    const PENTA = [0, 2, 4, 7, 9];
    const BASE = 146.83;
    let ac = null, master = null, sfxBus = null, colBus = null, noiseBuf = null;
    let muteColUntil = 0, lastChime = 0, lastNoteAt = 0, combo = 0;
    function save() { opts.save({ on: pref.on, vol: pref.vol }); }
    // 首次需要時建立 AudioContext 與混音匯流排
    function ensure() {
      if (!pref.on) return null;
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
        master = ac.createGain(); master.gain.value = pref.vol * pref.vol;
        master.connect(comp); comp.connect(ac.destination);
        sfxBus = ac.createGain(); sfxBus.connect(master);
        colBus = ac.createGain(); colBus.gain.value = 0.9; colBus.connect(master);
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state === "suspended") ac.resume().catch(() => {});
      return ac;
    }
    const live = () => pref.on && ac && ac.state === "running";
    function dest(pan, bus) {
      const b = bus || sfxBus;
      if (!pan || !ac.createStereoPanner) return b;
      const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(b);
      return p;
    }
    function env(g, t, a, d, peak) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }

    // 播放一個帶包絡的振盪器音
    function tone(o) {
      const t = ac.currentTime + (o.at || 0), a = o.a || 0.002, d = o.d || 0.1;
      const osc = ac.createOscillator(), g = ac.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + a + d);
      env(g, t, a, d, o.g);
      osc.connect(g); g.connect(o.out || dest(o.pan, o.bus));
      osc.start(t); osc.stop(t + a + d + 0.05);
      return osc;
    }

    // 播放濾波後的雜訊
    function noise(o) {
      const t = ac.currentTime + (o.at || 0), a = o.a || 0.002, d = o.d || 0.05;
      const src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4;
      flt.type = o.ft || "bandpass"; flt.frequency.setValueAtTime(o.f, t); flt.Q.value = o.q || 1;
      if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, t + a + d);
      env(g, t, a, d, o.g);
      src.connect(flt); flt.connect(g); g.connect(o.out || dest(o.pan, o.bus));
      src.start(t, Math.random() * 0.5); src.stop(t + a + d + 0.05);
    }
    // 暫時壓低碰撞音量
    function duck(amount, dur) {
      const t = ac.currentTime, p = colBus.gain;
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(0.9 * amount, t + 0.02); p.linearRampToValueAtTime(0.9, t + dur);
    }
    // 五聲音階音高
    const noteF = (step) => BASE * Math.pow(2, (12 * Math.floor(step / 5) + PENTA[((step % 5) + 5) % 5]) / 12);

    function mallet(f, at, g, pan, long) {
      const out = dest(pan);
      tone({ f, d: long ? 1.6 : 0.9, g, at, out });
      tone({ type: "triangle", f, d: 0.25, g: g * 0.25, at, out });
      tone({ f: f * 4, d: 0.14, g: g * 0.3, at, out });
      if (f * 10 < 9000) tone({ f: f * 10, d: 0.04, g: g * 0.12, at, out });
    }

    function drop() {
      if (!live()) return;
      noise({ ft: "highpass", f: 3200, q: 0.7, d: 0.025, g: 0.22 });
      tone({ type: "triangle", f: 1900, f2: 1250, d: 0.035, g: 0.09 });
    }
    function click(at, pan) {
      noise({ ft: "highpass", f: 2600, d: 0.02, g: 0.25, at, pan });
      tone({ type: "triangle", f: 1500, f2: 1100, d: 0.03, g: 0.1, at, pan });
    }
    function hold() {
      if (!live()) return;
      noise({ f: 500, f2: 2600, q: 2.2, a: 0.04, d: 0.15, g: 0.28 });
      click(0.17);
    }
    function retrieve() {
      if (!live()) return;
      click(0);
      noise({ f: 2600, f2: 500, q: 2.2, a: 0.03, d: 0.16, g: 0.28, at: 0.03 });
    }
    function deny() {
      if (!ensure()) return;
      tone({ f: 130, f2: 85, d: 0.14, g: 0.4 });
      noise({ ft: "lowpass", f: 350, d: 0.07, g: 0.3 });
    }
    function shake(dir) {
      if (!live()) return;
      const pan = dir * 0.55;
      tone({ f: 95, f2: 40, d: 0.32, g: 0.85, pan });
      tone({ type: "triangle", f: 190, f2: 110, d: 0.08, g: 0.25, pan });
      noise({ ft: "lowpass", f: 600, d: 0.12, g: 0.55, pan });
      noise({ f: 1400, q: 0.8, d: 0.03, g: 0.25, pan });
      for (let i = 0; i < 16; i++) {
        const at = 0.04 + Math.pow(Math.random(), 1.4) * 0.42, f = 500 + Math.random() * 1500;
        const gp = (0.05 + Math.random() * 0.08) * (1 - at * 1.2);
        tone({ type: "triangle", f, f2: f * 0.8, d: 0.025, g: gp, at, pan: dir * 0.3 + (Math.random() - 0.5) * 0.8, bus: colBus });
      }
      muteColUntil = ac.currentTime + 0.4;
    }

    // 碰撞聲：音量隨碰撞速度、音高隨群組面積
    function knock(v, f, pan, boost) {
      if (!live() || ac.currentTime < muteColUntil) return;
      const g = Math.min(0.55, Math.pow(Math.max(0, v - 0.5) / 4, 0.8) * 0.45) * (boost ? 1.5 : 1);
      if (g < 0.015) return;
      const d = 0.05 + Math.min(0.08, 30 / f);
      tone({ f, f2: f * 0.82, d, g, pan, bus: colBus });
      tone({ type: "triangle", f: f * 2.6, d: 0.025, g: g * 0.25, pan, bus: colBus });
      noise({ f: f * 2, q: 2.5, d: 0.025, g: g * 0.6, pan, bus: colBus });
      if (boost) noise({ ft: "lowpass", f: 500, d: 0.06, g: g * 0.6, pan, bus: colBus });
    }

    // 合併音效：連續合併會疊加高音
    function merge(o) {
      if (!live()) return;
      const now = ac.currentTime;
      combo = now - lastNoteAt < 0.8 ? combo + 1 : 0;
      const at = Math.max(o.delay, lastChime + 0.09 - now);
      lastChime = now + at; lastNoteAt = now;
      const out = dest(o.pan);
      if (o.inlay) {
        tone({ f: 320, f2: 110, d: 0.13, g: 0.5, at: at - 0.02, out });
        noise({ ft: "lowpass", f: 900, d: 0.05, g: 0.35, at: at - 0.02, out });
      } else {
        noise({ ft: "highpass", f: 2400, d: 0.018, g: 0.4, at: at - 0.02, out });
        tone({ type: "triangle", f: 2300, f2: 1500, d: 0.025, g: 0.14, at: at - 0.02, out });
        tone({ f: 170, f2: 115, d: 0.07, g: o.metro ? 0.45 : 0.28, at: at - 0.02, out });
      }
      const f = noteF(o.step);
      mallet(f, at, 0.32, o.pan);
      if (o.metro) tone({ f: f / 2, d: 1.1, g: 0.22, at, out });
      if (combo > 0) tone({ f: f * 2, d: 0.35, g: Math.min(0.12, 0.04 * combo), at: at + 0.05, out });
      if (o.lift > 6) {
        const g = Math.min(0.2, o.lift / 250), t = ac.currentTime + at;
        const osc = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), flt = ac.createBiquadFilter(), eg = ac.createGain();
        osc.type = "sawtooth"; osc.frequency.value = 62;
        lfo.frequency.value = 23; lg.gain.value = 18; lfo.connect(lg); lg.connect(osc.frequency);
        flt.type = "bandpass"; flt.frequency.setValueAtTime(650, t); flt.frequency.linearRampToValueAtTime(900, t + 0.35); flt.Q.value = 7;
        env(eg, t, 0.06, 0.34, g);
        osc.connect(flt); flt.connect(eg); eg.connect(out);
        osc.start(t); lfo.start(t); osc.stop(t + 0.5); lfo.stop(t + 0.5);
      }
      duck(0.35, 0.5);
    }

    function heartbeat(ratio, over) {
      if (!live()) return;
      const g = (0.25 + 0.45 * ratio) * (over ? 1 : 0.5);
      tone({ f: 62, f2: 44, d: 0.16, g });
      if (over) tone({ f: 58, f2: 42, d: 0.14, g: g * 0.6, at: 0.15 });
    }
    function win(total) {
      if (!live()) return;
      const top = total - 2;
      for (let i = 0; i < 9; i++) mallet(noteF(top - 8 + i), 0.08 * i, 0.22, (i - 4) * 0.12);
      [0, 2, 4, 5].forEach((s, k) => mallet(noteF(top - 5 + s) / (k === 0 ? 2 : 1), 0.8, 0.2, 0, true));
    }
    function lose() {
      if (!live()) return;
      for (let i = 0; i < 5; i++) mallet(noteF(9 - i * 2), 0.14 * i, 0.22, 0);
      tone({ f: 80, f2: 38, d: 0.6, g: 0.7, at: 0.72 });
      noise({ ft: "lowpass", f: 400, d: 0.3, g: 0.4, at: 0.72 });
    }
    function setOn(v) {
      pref.on = !!v; save();
      if (pref.on) { ensure(); if (live()) click(0); } else if (ac) ac.suspend().catch(() => {});
    }
    function setVol(v) { pref.vol = v; save(); if (master) master.gain.setTargetAtTime(v * v, ac.currentTime, 0.02); }

    const unlock = () => ensure();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);

    function undo() {
      if (!live()) return;
      noise({ f: 3200, f2: 300, q: 1.6, a: 0.02, d: 0.22, g: 0.3 });
      tone({ type: "triangle", f: 880, f2: 330, a: 0.01, d: 0.2, g: 0.12 });
      click(0.24);
    }
    function bonus() {
      if (!live()) return;
      mallet(noteF(12), 0.35, 0.2, 0); mallet(noteF(14), 0.47, 0.22, 0);
    }
    return { pref, drop, hold, retrieve, deny, shake, knock, merge, heartbeat, win, lose, undo, bonus, setOn, setVol };
  }

  root.TPSfx = { create };
})(typeof self !== "undefined" ? self : this);
