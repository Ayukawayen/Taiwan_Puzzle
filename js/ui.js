// UI：畫面繪製、輸入處理、設定、存檔、音效
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // 只在值改變時寫入 DOM（避免每 0.1 秒重設相同內容造成樣式與版面重算）
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setProp = (el, k, v) => { if (el[k] !== v) el[k] = v; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };

  // localStorage 鍵名（集中管理）。
  // save／params／log 結尾的 -v9 是「瀏覽器儲存世代」，與存檔內容版本（TPCore.VERSIONS）無關：
  // 內容格式升級由 core 的 normalizeSave／normalizeLog 移轉；只有舊資料完全無法移轉時才換世代，
  // 換世代會讓玩家既有的存檔與設定失效。
  const KEYS = {
    save: "tw-puzzle-save-v9", params: "tw-puzzle-params-v9", log: "tw-puzzle-log-v9",
    debug: "tw-puzzle-debug", theme: "tw-puzzle-theme", tips: "tw-puzzle-tips", help: "tw-puzzle-help-seen",
    touch: "tw-puzzle-touchn", hint: "tw-puzzle-hint", sfx: "tw-puzzle-sfx",
  };
  // localStorage 安全存取（無痕模式或容量不足時不丟例外）
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // 設定面板欄位：[參數, 標籤, 最小, 最大, 間距]
  const SETTINGS = [
    ["containerW", "容器寬度 px（至少 800）", 800, 1600, 10],
    ["deadlineH", "淘汰線高度 px", 900, 2000, 10],
    ["gravity", "重力 px/s²", 600, 4000, 100],
    ["friction", "摩擦力", 0, 1.5, 0.05],
    ["restitution", "彈性", 0, 0.8, 0.05],
    ["mergeKick", "合併向上推 m/s", 0, 4, 0.1],
    ["graceSec", "超線緩衝秒數", 1, 15, 0.5],
    ["rotateDegPerSec", "手上拼圖自轉 度/秒", 10, 180, 5],
    ["shakeSide", "拍打水平推力 m/s", 0.5, 3, 0.1],
    ["shakeVy", "拍打向上推力 m/s", 1, 6, 0.1],
    ["shakeCooldown", "兩次拍打最短間隔 秒", 0.05, 1, 0.01],
    ["shakeCost", "每次拍打耗體力", 1, 60, 1],
    ["shakeRegen", "體力回復 /秒", 1, 60, 1],
    ["shakeAlt", "拍打模式 (0 自選左右 / 1 左右交替)", 0, 1, 1],
    ["edgeW", "外框線寬（外側）px", 1, 5, 0.1],
    ["undoStart", "每局初始復原次數", 0, 20, 1],
  ];
  const DEFAULTS = window.TPCore.DEFAULTS;

  const MIN_CONTAINER_W = 800;
  // 確保容器寬度不低於下限
  function fitParams(p) {
    const w = "containerW" in p ? p.containerW : DEFAULTS.containerW;
    return w >= MIN_CONTAINER_W ? p : Object.assign({}, p, { containerW: MIN_CONTAINER_W });
  }
  // 使用者設定分兩類：tuning（設定面板的調校參數）與 rules（開新局面板的規則，見 TPCore.RULE_KEYS）。
  // 兩者在記憶體中分開，儲存時合併成同一個物件，localStorage 格式不變。
  const RULE_KEYS = window.TPCore.RULE_KEYS;
  const isRule = (k) => RULE_KEYS.indexOf(k) >= 0;
  let tuning = {}, rules = {};
  {
    const saved = store.get(KEYS.params) || {};
    for (const k of Object.keys(saved)) (isRule(k) ? rules : tuning)[k] = saved[k];
    delete tuning.liftContactBias;
  }
  const gameParams = () => Object.assign({}, tuning, rules);
  const saveParams = () => store.set(KEYS.params, gameParams());

  let core = null;
  const shapes = window.TP_SHAPES;
  const PENGHU = "澎湖縣";
  const PENGHU_I = shapes.pieces.findIndex((p) => p.name === PENGHU);
  const Nn = () => (core ? core.N : shapes.pieces.length);

  // --- 主題（淺色／深色）---
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode); else root.removeAttribute("data-theme");
  }
  applyTheme(store.get(KEYS.theme));

  const theme = { cat: {} };
  // 從 CSS 變數讀取繪圖用色
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    theme.cat = { "縣": g("--cat-county"), "直轄市": g("--cat-metro"), "市": g("--cat-city") };
    for (const n of ["cv-text", "edge-out", "edge-in", "cv-drop", "cv-water", "cv-water-deep", "cv-wall", "cv-danger", "guide", "guide-text", "hint", "ghost"]) theme[n] = g("--" + n);
    theme.font = g("--font-ui");
    theme.gen = (theme.gen || 0) + 1;
  }
  readTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readTheme);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const idxByName = {};
  shapes.pieces.forEach((p, i) => { idxByName[p.name] = i; });
  // 預先建立每個縣市的 Path2D：填色、外側遮罩、封口線、邊界線
  const fillPaths = shapes.pieces.map((p) => {
    const path = new Path2D();
    const ring = (pts) => { pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); };
    if (p.display.parts) { for (const part of p.display.parts) { ring(part.outer); for (const h of part.holes) ring(h); } }
    else { ring(p.display.outer); for (const h of p.display.holes) ring(h); }
    return path;
  });

  const outsidePaths = fillPaths.map((fp) => { const o = new Path2D(); o.rect(-4000, -4000, 8000, 8000); o.addPath(fp); return o; });

  const sealPaths = shapes.pieces.map((p) => {
    if (!p.display.seal) return null;
    const path = new Path2D(); path.moveTo(p.display.seal[0][0], p.display.seal[0][1]); path.lineTo(p.display.seal[1][0], p.display.seal[1][1]); return path;
  });

  const borderPaths = shapes.pieces.map((p) => p.borders.map((b) => {
    const path = new Path2D();
    for (const ln of b.lines) ln.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    return { nb: b.with === "sea" ? -1 : idxByName[b.with], path };
  }));

  const guideIdx = shapes.pieces.map((p, i) => (p.guideLabel ? i : -1)).filter((i) => i >= 0);

  // 畫布與視圖縮放
  const canvas = $("game"), mainCtx = canvas.getContext("2d");
  // 目前的繪製目標。平常是主畫布；建立靜止場景快取時暫時指向離屏畫布（見 paintInto）
  let ctx = mainCtx;
  const nextCv = $("next"), nctx = nextCv.getContext("2d");
  const slotCv = $("slotCv"), sctx = slotCv.getContext("2d");
  const resCv = $("resMap"), rctx = resCv.getContext("2d");
  const view = { cssW: 300, cssH: 300, dpr: 1, scale: 1, ox: 0, oy: 0 };
  function resize() {
    const r = canvas.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    view.cssW = Math.max(100, r.width); view.cssH = Math.max(100, r.height);
    canvas.width = Math.round(view.cssW * view.dpr); canvas.height = Math.round(view.cssH * view.dpr);
    layoutView();
  }
  const PAD_TOP = 34, PAD_BOT = 30, WALL = 14;
  // 依畫布大小計算世界座標的縮放與偏移
  function layoutView() {
    if (!core) return;
    const P = core.P;
    const worldW = P.containerW + 32, worldH = core.floorY() + WALL;
    view.scale = Math.min(view.cssW / worldW, Math.max(50, view.cssH - PAD_TOP - PAD_BOT) / worldH);
    view.ox = (view.cssW - P.containerW * view.scale) / 2;
    view.oy = PAD_TOP + Math.max(0, (view.cssH - PAD_TOP - PAD_BOT - worldH * view.scale) / 2);
  }
  new ResizeObserver(resize).observe($("board"));

  // --- 遊戲建立、存檔、讀檔 ---
  function makeCore() {
    core = window.TPCore.create({ planck: window.planck, shapes, params: gameParams() });
    layoutView();
  }
  function startNew(seed) {
    const fit = fitParams(tuning);
    if (fit !== tuning) { tuning = fit; saveParams(); }
    makeCore(); core.newGame(seed);
    cancelLogSave(); store.del(KEYS.save); store.del(KEYS.log); logSig = ""; logTooBig = false; lastLogLen = 0;
    resetTransient(); hideOverlay("ovEnd"); setMsg("");
  }
  // 存檔（約 2 KB，每秒一次，成本可忽略）；行動記錄另行延後寫入
  function saveNow() {
    if (!core) return;
    store.set(KEYS.save, core.serialize(true));
    scheduleLogSave();
  }
  // 行動記錄可能有數 MB（1.5 MB 時序列化＋寫入約 30 ms），所以不在操作當下寫：
  // 延後到瀏覽器閒置時；超過 LOG_BIG 後最多每 LOG_BIG_GAP 毫秒寫一次。
  // 離開或切到背景時（flushSaves）立即寫入，不會遺失。
  const LOG_BIG = 5e5, LOG_BIG_GAP = 15000;
  let logPending = false, logToken = 0, lastLogLen = 0, lastLogAt = 0;
  const idle = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 3000 }) : (fn) => setTimeout(fn, 500);
  function scheduleLogSave() {
    if (logPending) return;
    logPending = true;
    const token = logToken, wait = lastLogLen > LOG_BIG ? Math.max(0, lastLogAt + LOG_BIG_GAP - Date.now()) : 0;
    setTimeout(() => idle(() => { if (token !== logToken) return; logPending = false; saveLog(); }), wait);
  }
  function cancelLogSave() { logToken++; logPending = false; }
  function flushSaves() { saveNow(); cancelLogSave(); saveLog(); }

  let logSig = "", logWarned = false, logTooBig = false;
  // 行動記錄有變動才寫入；超過上限後本局不再寫入（也不再序列化，避免每次動作白花數十毫秒）
  function saveLog() {
    const lg = core && core.log; if (!lg || logTooBig) return;
    const sg = lg.segments[lg.segments.length - 1], sig = lg.segments.length + ":" + (sg ? sg.actions.length : 0);
    if (sig === logSig) return;
    logSig = sig;
    try {
      const txt = JSON.stringify(lg);
      if (txt.length > 4.5e6) { logTooBig = true; if (!logWarned) { logWarned = true; console.warn("[偵錯] 行動記錄太大，不再寫入瀏覽器儲存；仍可匯出。"); } return; }
      localStorage.setItem(KEYS.log, txt);
      lastLogLen = txt.length; lastLogAt = Date.now();
    } catch (e) { if (!logWarned) { logWarned = true; console.warn("[偵錯] 行動記錄無法寫入瀏覽器儲存：", e && e.message); } }
  }
  function loadOrNew() {
    makeCore();
    const sv = store.get(KEYS.save);
    let ok = false;
    try { ok = sv && core.restore(sv, store.get(KEYS.log)); } catch { ok = false; }
    if (ok) {
      setMsg("已還原上次的進度。");
      if (core.state.status !== "playing") showEnd();
    } else { core.newGame(); }
  }

  // 每秒自動存檔；離開頁面時也存
  setInterval(() => { if (core && core.state.status === "playing") saveNow(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSaves(); });
  window.addEventListener("pagehide", flushSaves);

  let toastTimer = 0;

  // --- 畫面暫態：特效、預覽快取、一次性提示旗標 ---
  const rings = [];            // 合併特效圓環
  let shakeAmp = 0;            // 拍打時的畫面震動幅度
  let lastNextKey = "", lastSlotKey = "x";   // 「下一塊」「保留區」小畫布的重繪快取鍵
  let slotHint = false;        // 「保留區還有一塊」提示是否已顯示
  // 讓「下一塊」「保留區」在下一幀重繪
  function invalidatePreviews() { lastNextKey = ""; lastSlotKey = "x"; }
  // 開新局或復原後：清掉特效、中斷進行中的按壓、重繪預覽
  function resetTransient() {
    rings.length = 0; shakeAmp = 0; sfxCol.fresh = -1;
    pressed = false; cancelZone = false; slotHint = false;
    invalidatePreviews();
  }

  // 底部提示訊息
  function setMsg(t, ms) {
    const el = $("toast"); clearTimeout(toastTimer);
    if (!t) { el.classList.remove("on"); return; }
    el.textContent = t; el.classList.add("on");
    toastTimer = setTimeout(() => el.classList.remove("on"), ms || Math.max(2500, t.length * 130));
  }

  // 一次性提示與觸控次數記錄
  let tips = store.get(KEYS.tips) || {};
  const tipOnce = (k) => { if (tips[k]) return false; tips[k] = true; store.set(KEYS.tips, tips); return true; };
  let touchN = store.get(KEYS.touch) || 0;
  function showOverlay(id) { $(id).hidden = false; }

  function hideOverlay(id) { const el = $(id), a = document.activeElement; if (a && el.contains(a)) a.blur(); el.hidden = true; }
  const fmtTime = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");

  // 結算地圖的群組配色：盡量讓相鄰群組不同色
  const GROUP_PALETTE = ["#e78ac3", "#ffd92f", "#a6d854", "#e5c494", "#bc80bd", "#80b1d3", "#fdb462", "#66c2a5", "#fc8d62", "#8da0cb"];
  function groupColors(ordered) {
    const out = [], cnt = {};
    ordered.forEach((g, i) => {
      const nb = new Set();
      for (let j = 0; j < i; j++) if (g.members.some((a) => ordered[j].members.some((b) => core.adj[a][b]))) nb.add(out[j]);

      let c = GROUP_PALETTE.find((x) => !cnt[x]);
      if (c == null) c = GROUP_PALETTE.find((x) => !nb.has(x));
      if (c == null) c = GROUP_PALETTE.slice().sort((x, y) => cnt[x] - cnt[y])[0];
      cnt[c] = (cnt[c] || 0) + 1; out.push(c);
    });
    return out;
  }

  // 顯示結算／暫停面板
  function showEnd() {
    const st = core.state, gs = core.groupsInfo(), P = core.P, playing = st.status === "playing";
    if (st.status === "won") {
      $("endTitle").textContent = "完成了，台灣拼好了";
      $("endBody").textContent = `用時 ${fmtTime(st.wonAt)}，拍打 ${st.shakes} 次。`;
    } else if (st.status === "lost") {
      $("endTitle").textContent = "超過淘汰線，本局結束";
      $("endBody").textContent = `已放下 ${st.dropped}/${Nn()} 塊，合併成 ${gs.length} 個區塊，撐了 ${fmtTime(st.time)}。`;
    } else {
      $("endTitle").textContent = "暫停中";
      $("endBody").textContent = `已放下 ${st.dropped}/${Nn()} 塊，目前 ${gs.length} 個區塊，用時 ${fmtTime(st.time)}。`;
    }
    $("ngMap").value = P.penghu ? "2" : "1"; $("ngLink").value = P.penghuLink === "B" ? "B" : "A"; $("ngShake").value = P.shakeAlt ? "1" : "0";
    syncNg();
    $("endClose").textContent = playing ? "繼續遊戲" : "看盤面";
    $("endClose").classList.toggle("primary", playing); $("endAgain").classList.toggle("primary", !playing);
    if (st.status === "lost" && core.canUndo()) { const ui = core.undoInfo(); $("endBody").textContent += ` 可以用頂欄的復原鈕復原最後一次放下（${shapes.pieces[ui.county].name}），剩 ${ui.left} 次。`; }
    drawResultMap(gs);
    showOverlay("ovEnd");
  }
  function syncNg() { $("ngLink").disabled = $("ngMap").value !== "2"; }

  // 在結算面板畫出拼好的部分與未放的縣市
  function drawResultMap(gs) {
    const bb = shapes.geometry.assembledBBox.slice(), PAD = 14;
    if (core.penghuIdx >= 0) { const pp = shapes.pieces[core.penghuIdx]; bb[0] = Math.min(bb[0], pp.home[0] + pp.bboxLocal[0]); bb[1] = Math.min(bb[1], pp.home[1] + pp.bboxLocal[1]); bb[2] = Math.max(bb[2], pp.home[0] + pp.bboxLocal[2]); bb[3] = Math.max(bb[3], pp.home[1] + pp.bboxLocal[3]); }
    const mw = bb[2] - bb[0], mh = bb[3] - bb[1];
    const H = 760, sc = (H - PAD * 2) / mh, W = Math.round(mw * sc + PAD * 2);
    resCv.width = W; resCv.height = H;
    const c = rctx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
    c.fillStyle = theme["cv-drop"]; c.fillRect(0, 0, W, H);
    c.lineJoin = "round"; c.lineCap = "round";
    const un = new Set(core.unplaced()), placed = new Map();
    const ordered = gs.slice().sort((a, b) => b.members.length - a.members.length || a.id - b.id);
    ordered.forEach((g, k) => { for (const m of g.members) placed.set(m, k); });
    const gcol = groupColors(ordered);
    const at = (m, fn) => { const p = shapes.pieces[m]; c.save(); c.translate((p.home[0] - bb[0]) * sc + PAD, (p.home[1] - bb[1]) * sc + PAD); c.scale(sc, sc); fn(p); c.restore(); };

    c.save(); c.setLineDash([6, 5]);
    for (const m of un) at(m, () => { c.fillStyle = "rgba(150,150,150,0.10)"; c.fill(fillPaths[m], "evenodd"); c.strokeStyle = "#969696"; c.lineWidth = 2 / sc; c.setLineDash([6 / sc, 5 / sc]); for (const b of borderPaths[m]) c.stroke(b.path); });
    c.restore();

    for (const m of placed.keys()) at(m, () => { c.fillStyle = gcol[placed.get(m)]; c.fill(fillPaths[m], "evenodd"); });
    c.strokeStyle = theme["cv-text"]; c.lineWidth = 1.3 / sc; c.setLineDash([4 / sc, 3 / sc]);
    for (const m of placed.keys()) at(m, () => { for (const b of borderPaths[m]) if (b.nb >= 0 && placed.get(b.nb) === placed.get(m) && m < b.nb) c.stroke(b.path); });
    c.setLineDash([]);
    for (const m of placed.keys()) at(m, () => { c.lineWidth = (m === PENGHU_I ? 1.7 : 2.6) / sc; for (const b of borderPaths[m]) if (!(b.nb >= 0 && placed.get(b.nb) === placed.get(m))) c.stroke(b.path); });

    for (const [pi, ci] of core.state.links || []) {
      const g = linkGeom(ci); if (!g) continue;
      const pp = shapes.pieces[pi], cp = shapes.pieces[ci];
      c.save(); c.strokeStyle = theme["cv-text"]; c.lineWidth = 1.5; c.setLineDash([6, 5]);
      c.beginPath(); c.moveTo((pp.home[0] + g.p[0] - bb[0]) * sc + PAD, (pp.home[1] + g.p[1] - bb[1]) * sc + PAD); c.lineTo((cp.home[0] + g.c[0] - bb[0]) * sc + PAD, (cp.home[1] + g.c[1] - bb[1]) * sc + PAD); c.stroke(); c.restore();
    }

    c.textAlign = "center"; c.textBaseline = "middle";
    for (const m of [...placed.keys(), ...un]) at(m, (p) => {
      if (p.guideLabel) return;
      const fs = Math.min(p.label.size, 22 / sc * 0.9);
      c.font = `700 ${fs}px ${theme.font}`; c.lineWidth = fs * 0.2; c.strokeStyle = un.has(m) ? theme["cv-drop"] : gcol[placed.get(m)]; c.fillStyle = un.has(m) ? "#737373" : theme["cv-text"];
      const txt = p.label.text || p.name, chars = Array.from(txt);
      if (p.label.vertical) { const pitch = fs * 1.05, y0 = p.label.y - ((chars.length - 1) / 2) * pitch; chars.forEach((ch, k) => { c.strokeText(ch, p.label.x, y0 + k * pitch); c.fillText(ch, p.label.x, y0 + k * pitch); }); }
      else { c.strokeText(txt, p.label.x, p.label.y); c.fillText(txt, p.label.x, p.label.y); }
    });

    const lg = $("endLegend"); lg.textContent = "";
    const addLine = (swatch, strong, text) => {
      const d = document.createElement("div"); const i = document.createElement("i"); Object.assign(i.style, swatch);
      const b = document.createElement("b"); b.textContent = strong; d.append(i, b, " " + text); lg.append(d);
    };
    ordered.forEach((g, k) => addLine({ background: gcol[k], border: "1px solid " + theme["cv-text"] }, `區塊 ${k + 1}（${g.members.length}）`, g.members.map((m) => core.pieces[m].name).join("、")));
  }

  // --- 指標輸入：移動、放下；觸控拖到淘汰線上方放開即取消 ---
  const keys = { left: false, right: false };
  function worldX(clientX) { const r = canvas.getBoundingClientRect(); return (clientX - r.left - view.ox) / view.scale; }
  let pressed = false, pressType = "mouse", cancelZone = false;
  function worldY(clientY) { const r = canvas.getBoundingClientRect(); return (clientY - r.top - view.oy) / view.scale; }

  function updateCancel(e) { cancelZone = pressed && pressType !== "mouse" && !!core && worldY(e.clientY) < core.deadlineY(); }
  canvas.addEventListener("pointermove", (e) => { if (core) core.setHeldX(worldX(e.clientX)); if (pressed) updateCancel(e); });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pressed = true; pressType = e.pointerType || "mouse"; canvas.setPointerCapture(e.pointerId);
    if (core) core.setHeldX(worldX(e.clientX));
    updateCancel(e);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!pressed || (e.pointerType === "mouse" && e.button !== 0)) return;
    updateCancel(e);
    const cancelled = cancelZone;
    pressed = false; cancelZone = false;
    if (pressType !== "mouse" && touchN < 99) store.set(KEYS.touch, ++touchN);
    if (core) { core.setHeldX(worldX(e.clientX)); if (cancelled) setMsg("已取消，拼圖沒有放下。"); else doDrop(); }
  });
  canvas.addEventListener("pointercancel", () => { pressed = false; cancelZone = false; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // --- 遊戲動作 ---
  const paused = () => anyOverlayOpen();
  function doDrop() { if (!paused() && core.drop()) saveNow(); }
  function doShake(dir) { if (core && !paused()) { if (core.shake(dir)) { shakeAmp = 1; saveNow(); } else if (core.state.status === "playing") SFX.deny(); } }

  function doHoldToggle() {
    if (!core || paused()) return;
    if (core.canHold()) { core.hold(); if (tipOnce("hold")) setMsg("已放進保留區。再按一次「取出」，就能把它換回手上。"); saveNow(); }
    else if (core.canRetrieve()) { const had = core.state.held != null; core.retrieve(); if (had && tipOnce("retrieve")) setMsg("已取出；原本手上那塊排回「下一塊」。"); slotHint = false; saveNow(); }
    else if (core.state.status === "playing" && core.state.held != null) { SFX.deny(); setMsg("最後一塊不能保留。"); }
  }

  // --- 復原 ---
  const UNDO_WHY = {
    won: "已經拼完了，不能復原。",
    shake: "放下後拍打過，不能復原。",
    used: "只能復原最後一次放下，這一次已經復原過了。",
    none: "還沒有可以復原的放下。",
  };
  const undoWhy = (b) => (b === "count" ? `復原次數用完了。合併次數每到 ${core.P.undoBonusEvery} 的倍數，會再給 1 次。` : UNDO_WHY[b] || UNDO_WHY.none);
  function doUndo() {
    if (!core) return;
    if (!$("ovSettings").hidden || !$("ovHelp").hidden || !$("ovConfirm").hidden) return;
    const b = core.undoBlocked();
    if (b) { SFX.deny(); setMsg(undoWhy(b)); return; }
    const county = core.undoInfo().county;
    if (!core.undo()) { SFX.deny(); return; }
    hideOverlay("ovEnd");
    resetTransient();
    SFX.undo();
    const st = core.state, g = st.grace > 0.05 ? `　超線累積 ${st.grace.toFixed(1)}／${core.P.graceSec} 秒。` : "";
    setMsg(`已復原：${shapes.pieces[county].name} 回到手上，剩 ${st.undo} 次復原。${g}`);
    saveNow();
  }
  function syncUndoUi() {
    const ui = core.undoInfo(), b = ui.blocked, el = $("btnUndo");
    setText($("undoN"), String(ui.left));
    el.classList.toggle("off", !!b); setAttr(el, "aria-disabled", String(!!b));
    setProp(el, "title", b ? `復原：${undoWhy(b)}` : `復原 ${shapes.pieces[ui.county].name} 的放下（Ctrl+Z），剩 ${ui.left} 次`);
    setAttr(el, "aria-label", `復原最後一次放下，剩 ${ui.left} 次`);
  }
  $("btnUndo").addEventListener("click", (e) => { doUndo(); e.currentTarget.blur(); });
  // --- 鍵盤：按鍵對照表＋單一分派器 ---
  const OVERLAYS = ["ovEnd", "ovSettings", "ovHelp", "ovConfirm"];
  const anyOverlayOpen = () => OVERLAYS.some((id) => !$(id).hidden);
  let lastDir = 0;
  // 每筆綁定：
  //   keys     比對 e.key（轉小寫）；codes 另外比對 e.code（非英文鍵盤配置時仍可用）
  //   mod      "none"（預設）：不可按 Ctrl／⌘／Alt，Shift 可；"ctrl"：須按 Ctrl 或 ⌘，不可按 Alt、Shift；"any"：不限
  //   field    輸入框或下拉選單有焦點時仍有效（預設否）
  //   overlay  有面板開著時仍有效（預設否）
  //   repeat   長按自動重複：true 照常處理；預設略過；"swallow" 略過並取消瀏覽器預設動作
  //   prevent  處理時取消瀏覽器預設動作；run 回傳 false 表示不處理（也不取消）
  //   up       放開時執行（不受上述條件限制）
  //   help     說明頁「鍵盤」列表的一列：[按鍵組合們, 說明]；同一列的其他綁定不寫
  const KEYMAP = [
    { keys: ["arrowleft", "a"], repeat: true, run: () => { keys.left = true; }, up: () => { keys.left = false; }, help: [[["←", "→"], ["A", "D"]], "移動"] },
    { keys: ["arrowright", "d"], repeat: true, run: () => { keys.right = true; }, up: () => { keys.right = false; } },
    { keys: [" ", "enter"], repeat: "swallow", prevent: true, help: [[["空白"], ["Enter"]], "放下"],
      // 焦點在按鈕上時讓按鈕自己處理
      run: () => { if (document.activeElement && document.activeElement.tagName === "BUTTON") return false; doDrop(); } },
    { keys: ["h"], run: () => doHoldToggle(), help: [[["H"]], "保留／取出"] },
    { keys: ["z"], codes: ["KeyZ"], mod: "ctrl", overlay: true, prevent: true, run: () => doUndo(), help: [[["Ctrl", "Z"], ["⌘", "Z"]], "復原最後一次放下"] },
    { keys: ["z"], run: () => { lastDir = -1; doShake(-1); }, help: [[["Z", "X"]], "向左拍／向右拍（自選左右模式）"] },
    { keys: ["x"], run: () => { lastDir = 1; doShake(1); } },
    { keys: ["s"], run: () => doShake(core.P.shakeAlt ? core.nextShakeDir() : (lastDir || 1)), help: [[["S"]], "拍打（左右交替模式依序左右；自選模式沿用上一次的方向）"] },
    { keys: ["escape"], mod: "any", field: true, overlay: true, repeat: true, help: [[["Esc"]], "打開或關閉選單（暫停）"],
      run: () => { const top = OVERLAYS.slice().reverse().find((id) => !$(id).hidden); if (top) hideOverlay(top); else if (core) showEnd(); } },
    { keys: ["?"], run: () => openHelp(), help: [[["?"]], "打開說明"] },
    { keys: ["m"], overlay: true, run: () => toggleSound(), help: [[["M"]], "音效開關"] },
  ];
  const modsOk = (b, e) => {
    const m = b.mod || "none", c = e.ctrlKey || e.metaKey;
    return m === "any" || (m === "ctrl" ? c && !e.altKey && !e.shiftKey : !c && !e.altKey);
  };
  const bindingFor = (e) => { const k = (e.key || "").toLowerCase(); return KEYMAP.find((b) => (b.keys.indexOf(k) >= 0 || (b.codes && b.codes.indexOf(e.code) >= 0)) && modsOk(b, e)); };
  window.addEventListener("keydown", (e) => {
    const b = bindingFor(e);
    if (!b) return;
    if (!b.field && (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) return;
    if (!b.overlay && anyOverlayOpen()) return;
    if (e.repeat && b.repeat !== true) { if (b.repeat === "swallow") e.preventDefault(); return; }
    if (b.run(e) !== false && b.prevent) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => { const k = (e.key || "").toLowerCase(); for (const b of KEYMAP) if (b.up && b.keys.indexOf(k) >= 0) b.up(e); });
  // 說明頁的鍵盤列表由對照表產生，避免說明與實際按鍵不一致
  function renderKeymapHelp() {
    const dl = document.querySelector('#ovHelp [data-dev="kbd"] .keymap'); if (!dl) return;
    dl.textContent = "";
    for (const b of KEYMAP) {
      if (!b.help) continue;
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      b.help[0].forEach((combo, i) => {
        if (i) dt.append(" 或 ");
        for (const k of combo) { const kb = document.createElement("kbd"); kb.textContent = k; dt.append(kb); }
      });
      dd.textContent = b.help[1];
      dl.append(dt, dd);
    }
  }

  const releaseKeys = () => { keys.left = false; keys.right = false; };
  window.addEventListener("blur", releaseKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseKeys(); });
  const press = (id, fn) => $(id).addEventListener("click", (e) => { fn(e); e.currentTarget.blur(); });
  press("btnShakeL", () => { lastDir = -1; doShake(-1); });
  press("btnShakeR", () => { lastDir = 1; doShake(1); });
  press("btnShakeA", () => doShake(core.nextShakeDir()));
  press("btnHold", doHoldToggle);

  $("btnMenu").addEventListener("click", (e) => { e.currentTarget.blur(); showEnd(); });
  // 確認對話框
  let confirmFn = null;
  function askConfirm(title, body, yes, fn) { $("cfTitle").textContent = title; $("cfBody").textContent = body; $("cfYes").textContent = yes; confirmFn = fn; showOverlay("ovConfirm"); }
  $("cfNo").addEventListener("click", () => hideOverlay("ovConfirm"));
  $("cfYes").addEventListener("click", () => { hideOverlay("ovConfirm"); const f = confirmFn; confirmFn = null; if (f) f(); });

  // 開新局（套用面板上的模式選項）
  $("endAgain").addEventListener("click", () => {
    const patch = { penghu: $("ngMap").value === "2", penghuLink: $("ngLink").value === "B" ? "B" : "A", shakeAlt: $("ngShake").value === "1" };
    const go = () => { rules = Object.assign({}, rules, patch); saveParams(); startNew(); syncModeUi(); };
    const st = core.state;
    if (st.status === "playing" && (st.dropped > 0 || st.shakes > 0)) askConfirm("放棄這一局？", `目前已放下 ${st.dropped}/${Nn()} 塊。開新局後，這一局的進度會被清除。`, "放棄並開新局", go);
    else go();
  });
  $("ngMap").addEventListener("change", syncNg);
  $("endClose").addEventListener("click", () => hideOverlay("ovEnd"));
  $("endHelp").addEventListener("click", () => openHelp("rules"));
  for (const id of ["ovEnd", "ovConfirm", "ovHelp"]) $(id).addEventListener("pointerdown", (e) => { if (e.target === $(id)) hideOverlay(id); });

  // 頂欄模式標籤
  function syncModeUi() {
    const P = core.P;
    $("modeTag").textContent = P.penghu ? `含澎湖 20 塊・澎湖${P.penghuLink === "B" ? "不限次數" : "只連一次"}` : "本島 19 塊";
  }

  // --- 說明面板 ---
  function selectTab(t) {
    for (const b of document.querySelectorAll("#ovHelp [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const p of document.querySelectorAll("#ovHelp [data-pane]")) p.hidden = p.dataset.pane !== t;
  }
  function openHelp(tab, anchor) {
    selectTab(tab || "rules");
    showOverlay("ovHelp");
    const dlg = document.querySelector("#ovHelp .dialog");
    const el = anchor && $(anchor);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1400); }
    else dlg.scrollTop = 0;
  }
  for (const b of document.querySelectorAll("#ovHelp [data-tab]")) b.addEventListener("click", () => { selectTab(b.dataset.tab); document.querySelector("#ovHelp .dialog").scrollTop = 0; });
  for (const b of document.querySelectorAll("[data-help]")) b.addEventListener("click", (e) => { const [t, a] = b.dataset.help.split(":"); e.currentTarget.blur(); openHelp(t, a); });
  $("btnHelp").addEventListener("click", (e) => { e.currentTarget.blur(); openHelp(); });
  $("hpClose").addEventListener("click", () => { hideOverlay("ovHelp"); $("hpClose").textContent = "關閉"; });
  $("hpVer").textContent = document.title;

  {
    const coarse = matchMedia("(pointer: coarse)").matches, ord = coarse ? { touch: 0, mouse: 1, kbd: 2 } : { mouse: 0, kbd: 1, touch: 2 };
    for (const sec of document.querySelectorAll("#ovHelp [data-dev]")) sec.style.order = ord[sec.dataset.dev];
  }

  $("chkHint").checked = !!store.get(KEYS.hint);
  $("chkHint").addEventListener("change", (e) => store.set(KEYS.hint, e.target.checked));

  $("stTips").addEventListener("click", () => {
    tips = {}; touchN = 0; store.del(KEYS.tips); store.del(KEYS.touch); store.del(KEYS.help);
    setMsg("已重設：一次性提示會再出現，下次開啟時也會自動顯示說明。");
  });

  // --- 設定面板 ---
  const fieldsEl = $("fields");
  function buildFields() {
    fieldsEl.textContent = "";
    for (const [key, label, min, max, step] of SETTINGS) {
      const l = document.createElement("label"); l.htmlFor = "f_" + key; l.textContent = label;
      const i = document.createElement("input");
      i.type = "number"; i.id = "f_" + key; i.min = min; i.max = max; i.step = step;
      const cur = gameParams(), v = key in cur ? cur[key] : DEFAULTS[key];
      i.value = typeof v === "boolean" ? (v ? 1 : 0) : v;
      fieldsEl.append(l, i);
    }
  }
  $("selTheme").addEventListener("change", (e) => { const v = e.target.value; store.set(KEYS.theme, v); applyTheme(v); });
  $("btnSettings").addEventListener("click", (e) => { e.currentTarget.blur(); buildFields(); $("selTheme").value = store.get(KEYS.theme) || "system"; $("chkDebug").checked = debugOn(); showOverlay("ovSettings"); });
  $("stCancel").addEventListener("click", () => hideOverlay("ovSettings"));
  $("stReset").addEventListener("click", () => { tuning = {}; rules = {}; store.del(KEYS.params); buildFields(); });
  $("stApply").addEventListener("click", () => {
    // 設定面板決定全部調校參數；規則中只有 shakeAlt 也出現在面板上，其餘規則沿用
    const nextTuning = {}, nextRules = Object.assign({}, rules);
    for (const [key, , min, max] of SETTINGS) {
      let v = parseFloat($("f_" + key).value);
      if (isRule(key)) delete nextRules[key];
      if (!isFinite(v)) continue;
      v = Math.max(min, Math.min(max, v));
      if (isRule(key)) nextRules[key] = !!v; else nextTuning[key] = v;
    }
    tuning = nextTuning; rules = nextRules; saveParams();
    hideOverlay("ovSettings"); startNew(); syncModeUi(); resize();
  });


  // --- 偵錯：匯出記錄、摘要、重放 ---
  const debugOn = () => !!store.get(KEYS.debug) || /[?&]debug(=1|&|$)/.test(location.search);
  // 偵錯模式：顯示偵錯卡片，並在 window.__tp 公開偵錯介面（關閉時移除）
  function syncDebugUi() {
    const on = debugOn();
    $("dbgCard").hidden = !on;
    if (on && !window.__tp) window.__tp = debugApi();
    else if (!on && window.__tp) delete window.__tp;
  }
  function debugApi() {
    return {
      get core() { return core; }, scene, startNew, resize, layoutGuideLabels, exportLog, summary, keymap: KEYMAP,
      log: () => currentLog(), replay: (lg) => { loadReplay(lg || currentLog(), "記錄"); return runAllReplay(); }, step: stepReplay,
    };
  }
  $("chkDebug").addEventListener("change", (e) => { store.set(KEYS.debug, e.target.checked); syncDebugUi(); });
  const fmtT = (t) => Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0");
  function currentLog() {
    const lg = core && core.exportLog(); if (!lg) return null;
    lg.build = document.title; lg.userAgent = navigator.userAgent;
    return lg;
  }
  function exportLog() {
    const lg = currentLog(); if (!lg) { setMsg("沒有行動記錄。"); return null; }
    const txt = JSON.stringify(lg), name = `tw-puzzle-log_seed${lg.seed}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    const plainDownload = () => {
      try {
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt], { type: "application/json" })); a.download = name;
        document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { console.warn("[偵錯] 無法下載，記錄已放在 window.__tp.lastLog", e); }
    };

    if (window.claude && typeof window.claude.use === "function") {
      window.claude.use("downloads").then((dl) => {
        if (!dl) { plainDownload(); return; }
        dl.save({ filename: name, data: txt }).then(() => setMsg("行動記錄已存檔。"), (err) => {
          const c = err && err.code;
          setMsg(c === "declined" ? "已取消存檔；記錄仍可用 window.__tp.lastLog 取得。" : `無法存檔（${c || "未知原因"}）；記錄已放在 window.__tp.lastLog。`);
        });
      }, plainDownload);
    } else plainDownload();
    if (window.__tp) window.__tp.lastLog = lg;
    console.info(`[偵錯] 已匯出行動記錄 ${name}（${(txt.length / 1024).toFixed(0)} KB）；也可用 window.__tp.lastLog 取得。`);
    setMsg(`已匯出行動記錄（${(txt.length / 1024).toFixed(0)} KB）。`);
    return lg;
  }

  // 在主控台印出行動記錄摘要
  function summary(log) {
    log = log || currentLog();
    if (!log) { console.warn("[偵錯] 沒有行動記錄"); return; }
    log = window.TPCore.normalizeLog(log);
    const names = shapes.pieces.filter((p) => log.penghu || p.name !== PENGHU).map((p) => p.name);
    const nm = (i) => (i == null ? "—" : names[i] || "#" + i);
    const D = window.TPCore.DEFAULTS;
    const changed = Object.keys(log.params).filter((k) => k in D && JSON.stringify(log.params[k]) !== JSON.stringify(D[k])).map((k) => `${k}=${log.params[k]}`);
    const evText = (evs) => (evs || []).map((e) => {
      if (e.type === "merge") return `${nm(e.a)}＋${nm(e.b)} 合併 → ${e.size} 縣市（上推 ${Math.round(e.lift || 0)}px${e.carried ? `，帶動 ${e.carried} 區塊` : ""}${e.gaps && e.gaps.pocket ? `，凹口容身 ${e.gaps.pocket}` : ""}${e.gaps && e.gaps.fail ? `，無解 ${e.gaps.fail} 對` : ""}${e.gaps && e.gaps.avoid ? `，避開接觸顛倒 ${e.gaps.avoid} 次` : ""}${e.gaps && e.gaps.cross ? `，仍顛倒 ${e.gaps.cross} 對` : ""}）`;
      if (e.type === "win") return "★ 完成";
      if (e.type === "undoBonus") return `復原次數 +1（合併第 ${e.n} 次，剩 ${e.left} 次）`;
      if (e.type === "undo") return `↶ 復原：${nm(e.county)} 回到手上（剩 ${e.left} 次）`;
      if (e.type === "lose") return "✗ 超過淘汰線，遊戲結束";
      if (e.type === "stuck") return "卡關提示";
      return null;
    }).filter(Boolean).join("；");
    const groupsText = (snap) => snap.groups.slice().sort((a, b) => b.members.length - a.members.length).map((g) => g.members.map(nm).join("+")).join(" ｜ ");
    console.group(`%c台灣拼圖合成｜行動記錄摘要`, "font-weight:bold;font-size:13px");
    console.log(`版本 ${log.build || "?"}｜種子 ${log.seed}｜${log.penghu ? `含澎湖 20 塊（澎湖規則 ${log.params.penghuLink}）` : "本島 19 塊"}｜段落 ${log.segments.length}`);
    console.log(`與預設不同的參數：${changed.join("、") || "無"}${log.convertedFrom ? "｜由 v1 記錄格式轉換" : ""}`);
    const ACT = { drop: "放下", hold: "保留", retrieve: "取出" };
    log.segments.forEach((sg, si) => {
      const n = sg.actions.length, nLight = sg.actions.filter((a) => a.type === "hold" || a.type === "retrieve").length;
      console.groupCollapsed(`段落 ${si + 1}：${sg.reason === "new" ? "新局" : sg.reason === "undo" ? "復原最後一次放下" : "由存檔還原"}，遊戲時間 ${fmtT(sg.time)} 起，${n} 筆（放下／拍打 ${n - nLight}、保留／取出 ${nLight}）${sg.trimmed ? "（前段已截斷）" : ""}`);
      const first = n ? sg.actions[0] : sg.end;
      if (first && evText(first.events)) console.log(`段落開頭到第一筆之間：${evText(first.events)}`);

      const nextSnap = (k) => { for (let q = k + 1; q < n; q++) if (sg.actions[q].snap) return sg.actions[q].snap; return sg.end ? sg.end.snap : null; };
      const rows = sg.actions.map((a, k) => {
        const nx = k + 1 < n ? sg.actions[k + 1] : sg.end, ns = nextSnap(k);
        const county = a.type === "shake" ? "" : a.type === "retrieve" && a.back != null ? `${nm(a.county)}（${nm(a.back)} 退回序列）` : nm(a.county);
        return {
          "#": a.n, "時間": a.time == null ? "—" : fmtT(a.time), "動作": a.type === "shake" ? (a.dir < 0 ? "拍打 ◀" : "拍打 ▶") : ACT[a.type] || a.type,
          "縣市": county, "x": a.type === "drop" ? Math.round(a.x) : "", "角度°": a.type === "drop" ? Math.round((a.a * 180 / Math.PI + 360) % 360) : "",
          "距上一筆(秒)": +(a.d * log.params.dt).toFixed(2),
          "體力": a.snap ? Math.round(a.snap.stamina) : "", "之後的事件": nx ? evText(nx.events) : "（記錄結束）", "之後的區塊數": ns ? ns.groups.length : "",
        };
      });
      if (rows.length) console.table(rows);
      if (sg.end) console.log(`匯出當下（遊戲時間 ${fmtT(sg.end.time)}，狀態 ${sg.end.snap.status}）區塊：${groupsText(sg.end.snap)}`);
      console.groupEnd();
    });
    console.groupEnd();
    setMsg("摘要已印到瀏覽器主控台（F12 → Console）。");
  }

  // 重放驗證
  let rp = null, rpSeg = 0, rpJ = 0;
  // 重放器回傳的代碼 → 顯示文字
  const REPLAY_TEXT = { start: "段落開頭", end: "匯出當下", "bad-start-snapshot": "起點快照無法還原", "not-log": "不是行動記錄檔" };
  const rpText = (c) => REPLAY_TEXT[c] || c;
  const dbgOut = (t) => console.log(t);
  function rpLine(r) {
    if (!r) return "（沒有下一步）";
    const head = `段${r.seg + 1} 轉移${r.j}：${rpText(r.from)} → ${rpText(r.to)}（${r.steps} 步／${r.sec}s${r.lights ? `，含保留／取出 ${r.lights} 筆` : ""}）`;
    if (r.error) return head + "  ✗ " + rpText(r.error);
    if (r.same) return head + "  ✓ 相同";
    const d0 = r.diffs[0];
    return head + `  ✗ ${r.nDiffs} 處不同${r.applied === false ? "（行動未被接受）" : ""}${r.lightFail ? `（${r.lightFail} 無法照記錄套用）` : ""}，最大位置差 ${r.maxPos}px；首個：${d0 ? `${d0.path} 得 ${d0.got} 記錄 ${d0.want}` : ""}`;
  }
  function loadReplay(log, label) {
    try { rp = window.TPCore.makeReplayer({ planck: window.planck, shapes, log }); } catch (e) { rp = null; dbgOut("無法載入：" + rpText(e.code || e.message)); return; }
    rpSeg = 0; rpJ = 0;
    const total = log.segments.reduce((s, _, i) => s + rp.count(i), 0);
    dbgOut(`已載入${label}：種子 ${log.seed}，${log.segments.length} 段，共 ${total} 個轉移。按「單步」或「全部」。`);
    if (window.__tp) window.__tp.replayer = rp;
  }
  function stepReplay() {
    if (!rp) return null;
    while (rpSeg < rp.segments && rpJ >= rp.count(rpSeg)) { rpSeg++; rpJ = 0; }
    if (rpSeg >= rp.segments) { dbgOut("（已到結尾）"); return null; }
    const r = rp.run(rpSeg, rpJ++);
    dbgOut(rpLine(r));
    if (r && !r.same) console.warn("[重放] 差異", r);
    return r;
  }
  function runAllReplay() {
    if (!rp) return;
    const all = [];
    for (let si = 0; si < rp.segments; si++) for (let j = 0; j < rp.count(si); j++) all.push(rp.run(si, j));
    rpSeg = rp.segments; rpJ = 0;
    const bad = all.filter((r) => !r.same);
    dbgOut(`全部 ${all.length} 個轉移：相同 ${all.length - bad.length}，不同 ${bad.length}`);
    for (const r of bad.slice(0, 30)) dbgOut(rpLine(r));
    console.groupCollapsed(`[重放] 全部 ${all.length} 個轉移，不同 ${bad.length}`);
    console.table(all.map((r) => ({ 段: r.seg + 1, 轉移: r.j, 起: rpText(r.from), 迄: rpText(r.to), 步數: r.steps, 保留取出: r.lights || "", 結果: r.same ? "相同" : `不同 ${r.nDiffs}`, 最大位置差: r.maxPos, 首個差異: r.diffs && r.diffs[0] ? r.diffs[0].path : "" })));
    console.groupEnd();
    return all;
  }
  $("dbgExport").addEventListener("click", exportLog);

  // --- 繪製 ---

  function fillFor(i) { return theme.cat[shapes.pieces[i].category]; }

  function edgeWidth(px) { return Math.max(core.P.edgeW || 2, 1.2 * px); }
  const PENGHU_K = 0.7;

  // 澎湖連線：找澎湖與相連縣市海岸間最近的兩點
  const linkCache = {};
  function linkGeom(ci) {
    if (linkCache[ci]) return linkCache[ci];
    const pp = shapes.pieces[PENGHU_I], cp = shapes.pieces[ci];
    const pts = []; for (const part of pp.display.parts) for (const q of part.outer) pts.push(q);
    let best = null;
    for (const b of cp.borders) {
      if (b.with !== "sea") continue;
      for (const ln of b.lines) for (const [cx, cy] of ln) {
        const gx = cp.home[0] + cx, gy = cp.home[1] + cy;
        for (const [qx, qy] of pts) {
          const d = Math.hypot(pp.home[0] + qx - gx, pp.home[1] + qy - gy);
          if (!best || d < best.d) best = { d, p: [qx, qy], c: [cx, cy] };
        }
      }
    }
    return (linkCache[ci] = best);
  }
  function drawLinks(poseOf, px) {
    const links = core.state.links; if (!links || !links.length) return;
    ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = theme["edge-out"]; ctx.lineWidth = Math.max(1.6, 1.1 * px); ctx.setLineDash([7 * px, 6 * px]);
    for (const [pi, ci] of links) {
      const g = linkGeom(ci), a = poseOf(pi), b = poseOf(ci); if (!g || !a || !b) continue;
      const w = (pose, q) => { const c = Math.cos(pose.a), s = Math.sin(pose.a); return [pose.x + c * q[0] - s * q[1], pose.y + s * q[0] + c * q[1]]; };
      const p1 = w(a, g.p), p2 = w(b, g.c);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    }
    ctx.restore();
  }

  // 畫一個群組：填色、內部虛線邊界、外框
  function drawGroupShape(members, poseOf, alpha) {
    const px = 1 / view.scale, set = new Set(members), ew = edgeWidth(px);
    ctx.save(); ctx.globalAlpha = alpha; ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const m of members) {
      const p = poseOf(m); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = fillFor(m); ctx.fill(fillPaths[m], "evenodd"); ctx.restore();
    }
    ctx.strokeStyle = theme["edge-in"]; ctx.lineWidth = Math.max(1.5, 1.1 * px); ctx.setLineDash([5 * px, 4 * px]);
    for (const m of members) {
      const p = poseOf(m); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      for (const b of borderPaths[m]) if (b.nb >= 0 && set.has(b.nb) && m < b.nb) ctx.stroke(b.path);
      ctx.restore();
    }
    ctx.setLineDash([]); ctx.strokeStyle = theme["edge-out"];
    for (const m of members) {
      const p = poseOf(m); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      const k = m === PENGHU_I ? PENGHU_K : 1;
      ctx.save(); ctx.clip(outsidePaths[m], "evenodd"); ctx.lineWidth = ew * 2 * k;
      for (const b of borderPaths[m]) if (!(b.nb >= 0 && set.has(b.nb))) ctx.stroke(b.path);
      ctx.restore();
      if (sealPaths[m]) { ctx.lineWidth = ew * k * 1.6; ctx.stroke(sealPaths[m]); }
      ctx.restore();
    }
    ctx.restore();
  }

  // 畫縣市名稱
  function drawLabel(m, pose, alpha) {
    const pc = shapes.pieces[m]; if (pc.guideLabel) return;
    const lab = pc.label, px = 1 / view.scale;
    const fs = Math.min(Math.max(lab.size, 10 * px), lab.size * 1.5);
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(pose.x, pose.y); ctx.rotate(pose.a);
    ctx.font = `700 ${fs}px ${theme.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    ctx.lineWidth = fs * 0.22; ctx.strokeStyle = fillFor(m); ctx.fillStyle = theme["cv-text"];
    const txt = lab.text || pc.name, chars = Array.from(txt);
    if (lab.vertical) {
      const pitch = fs * 1.05, y0 = lab.y - ((chars.length - 1) / 2) * pitch;
      chars.forEach((c, k) => { ctx.strokeText(c, lab.x, y0 + k * pitch); ctx.fillText(c, lab.x, y0 + k * pitch); });
    } else { ctx.strokeText(txt, lab.x, lab.y); ctx.fillText(txt, lab.x, lab.y); }
    ctx.restore();
  }

  // 小縣市的引線標籤排版（放在容器下方，避免重疊）
  function layoutGuideLabels(items, minX, maxX, cx, stub, tgap, gap, lineGap = 0) {
    const order = items.slice().sort((a, b) => a.ax - b.ax), n = order.length, rows = [];

    const span = (it, side) => { const x0 = it.ax + side * (stub + tgap), x1 = x0 + side * it.w; return { x0, l: Math.min(it.ax, x0, x1), r: Math.max(it.ax, x0, x1), la: side > 0, ra: side < 0 }; };
    const sep = (a, b) => (a.ra && b.la ? lineGap : gap);
    const fits = (it, side, row) => { const p = span(it, side); return p.l >= minX && p.r <= maxX && (rows[row] || []).every((s) => p.r + sep(p, s) <= s.l || s.r + sep(s, p) <= p.l); };
    const put = (it, pref) => {
      for (let row = 0; row < 4; row++) for (const side of [pref, -pref]) {
        if (!fits(it, side, row)) continue;
        const p = span(it, side); (rows[row] = rows[row] || []).push(p);
        Object.assign(it, { side, row, tx: p.x0 }); return;
      }
      Object.assign(it, { side: pref, row: 0, tx: span(it, pref).x0 });
    };
    if (n === 1) put(order[0], order[0].ax < cx ? -1 : 1);
    else if (n >= 2) {
      put(order[0], -1); put(order[n - 1], 1);
      for (let i = 1; i < n - 1; i++) {
        const it = order[i], prev = order[i - 1], next = order[i + 1];
        const leftSpace = it.ax - (prev.side > 0 ? span(prev, 1).r : prev.ax), rightSpace = (next.side < 0 ? span(next, -1).l : next.ax) - it.ax;
        put(it, leftSpace > rightSpace ? -1 : 1);
      }
    }
  }

  // 畫引線標籤
  function drawGuides(hp, st) {
    const px = 1 / view.scale, W = core.P.containerW, F = core.floorY();
    const fs = 13 * px, gap = 12 * px;
    ctx.save(); ctx.font = `700 ${fs}px ${theme.font}`; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const placed = [], held = [];
    for (const m of guideIdx) {
      const isHeld = hp && hp.county === m && st.status === "playing";
      const pose = isHeld ? { x: hp.x, y: hp.y, a: hp.a } : core.countyPose(m);
      if (!pose) continue;
      const lab = shapes.pieces[m].label, c = Math.cos(pose.a), s = Math.sin(pose.a);
      const it = { m, ax: pose.x + c * lab.x - s * lab.y, ay: pose.y + s * lab.x + c * lab.y, w: ctx.measureText(shapes.pieces[m].name).width };
      (isHeld ? held : placed).push(it);
    }
    const minX = (6 - view.ox) * px, maxX = (view.cssW - view.ox - 6) * px;
    const lineStyle = () => { ctx.strokeStyle = theme.guide; ctx.fillStyle = theme.guide; ctx.lineWidth = 2 * px; ctx.setLineDash([]); };

    const stub = 14 * px, tgap = 4 * px, rowH = fs + 6 * px;
    const yRow0 = F + WALL + 3 * px + fs / 2;
    layoutGuideLabels(placed, minX, maxX, W / 2, stub, tgap, gap);
    for (const it of placed) {
      const yy = yRow0 + it.row * rowH;
      lineStyle(); ctx.beginPath(); ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.ax, yy); ctx.lineTo(it.ax + it.side * stub, yy); ctx.stroke();
      ctx.beginPath(); ctx.arc(it.ax, it.ay, 2.5 * px, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = theme["guide-text"]; ctx.textAlign = it.side > 0 ? "left" : "right"; ctx.textBaseline = "middle";
      ctx.fillText(shapes.pieces[it.m].name, it.tx, yy);
    }

    for (const it of held) {
      const top = hp.y + hp.bbox[1];
      const rowUp = Math.max(top - 14 * px, -view.oy * px + fs + 10 * px);
      const slot = Math.max(minX + it.w / 2, Math.min(maxX - it.w / 2, it.ax));
      lineStyle(); ctx.beginPath(); ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.ax, rowUp); ctx.lineTo(slot, rowUp); ctx.stroke();
      ctx.beginPath(); ctx.arc(it.ax, it.ay, 2.5 * px, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = theme["guide-text"]; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(shapes.pieces[it.m].name, slot, rowUp - 4 * px);
    }
    ctx.restore();
  }

  // --- 靜止場景快取 ---
  // 每幀成本主要在畫布點陣化（JS 只占一小部分）。場上群組在拼圖靜止時不會變，
  // 所以內容連續兩幀相同時，就把群組（填色、邊界）與澎湖連線畫進離屏畫布，之後只貼有內容的範圍。
  // 圖層順序不變；文字仍直接繪製（快取文字反而較慢，且透明畫布上的文字抗鋸齒略有不同）。
  // 畫面震動時或有東西在動時照常直接繪製。enabled／hits／frames 供偵錯與實測使用。
  const scene = { enabled: true, prevSig: null, builtSig: null, shapes: null, rect: null, hits: 0, frames: 0 };
  // 影響快取內容的所有因素：畫布與縮放、主題、外框寬、澎湖連線、每個縣市的位置與角度
  function sceneSig(gi) {
    const parts = [canvas.width, canvas.height, view.dpr, view.scale, view.ox, view.oy, theme.gen, core.P.edgeW, JSON.stringify(core.state.links || [])];
    for (const g of gi) {
      parts.push("g" + g.id);
      for (const m of g.members) { const p = core.countyPose(m); parts.push(m, p.x, p.y, p.a); }
    }
    return parts.join(",");
  }
  function layerCanvas(c) {
    c = c || document.createElement("canvas");
    if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
    return c;
  }
  // 暫時把 ctx 指向另一個畫布，以與主畫布相同的世界座標變換繪製
  function paintInto(target, fn) {
    const prev = ctx; ctx = target.getContext("2d");
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, target.width, target.height);
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); ctx.translate(view.ox, view.oy); ctx.scale(view.scale, view.scale);
      fn();
    } finally { ctx = prev; }
  }
  // 只貼有內容的範圍（裝置像素），區域外在離屏畫布上本來就是透明的
  function blit(layer, r) {
    if (!r) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]); ctx.restore();
  }
  // 群組聯集外接矩形轉成裝置像素範圍，外擴 margin（CSS px）涵蓋描邊
  function sceneRect(gi, margin) {
    if (!gi.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of gi) { const b = core.groupAABB(g.id); if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
    const d = view.dpr, toDev = (wx, wy) => [(view.ox + wx * view.scale) * d, (view.oy + wy * view.scale) * d];
    let [ax, ay] = toDev(x0, y0), [bx, by] = toDev(x1, y1);
    const m = margin * d;
    ax = Math.max(0, Math.floor(ax - m)); ay = Math.max(0, Math.floor(ay - m));
    bx = Math.min(canvas.width, Math.ceil(bx + m)); by = Math.min(canvas.height, Math.ceil(by + m));
    return bx > ax && by > ay ? [ax, ay, bx - ax, by - ay] : null;
  }
  const drawPlacedShapes = (gi, px) => { for (const g of gi) drawGroupShape(g.members, (m) => core.countyPose(m), 1); drawLinks((m) => core.countyPose(m), px); };

  let hatchCache = { color: "", pat: null };
  // 落點預覽用的斜線花紋
  function hatchPattern() {
    if (hatchCache.color === theme.ghost && hatchCache.pat) return hatchCache.pat;
    const T = 10, c = document.createElement("canvas"); c.width = c.height = T;
    const g = c.getContext("2d"); g.strokeStyle = theme.ghost; g.lineWidth = 1.7;
    g.beginPath();
    g.moveTo(0, T); g.lineTo(T, 0); g.moveTo(-T / 2, T / 2); g.lineTo(T / 2, -T / 2); g.moveTo(T / 2, T * 1.5); g.lineTo(T * 1.5, T / 2);
    g.stroke();
    hatchCache = { color: theme.ghost, pat: ctx.createPattern(c, "repeat") };
    return hatchCache.pat;
  }
  // 主畫面繪製
  function draw(ts) {
    const P = core.P, st = core.state, W = P.containerW, F = core.floorY(), DL = core.deadlineY(), px = 1 / view.scale;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.cssW, view.cssH);
    ctx.save();
    let jx = 0, jy = 0;
    if (shakeAmp > 0.01) { jx = (Math.random() - 0.5) * 10 * shakeAmp; jy = (Math.random() - 0.5) * 10 * shakeAmp; }
    ctx.translate(view.ox + jx, view.oy + jy); ctx.scale(view.scale, view.scale);

    const top = -view.oy * px;
    ctx.fillStyle = theme["cv-drop"]; ctx.fillRect(0, top, W, DL - top);
    const grd = ctx.createLinearGradient(0, DL, 0, F); grd.addColorStop(0, theme["cv-water"]); grd.addColorStop(1, theme["cv-water-deep"]);
    ctx.fillStyle = grd; ctx.fillRect(0, DL, W, F - DL);
    ctx.fillStyle = theme["cv-wall"];
    ctx.fillRect(-WALL, top, WALL, F + WALL - top); ctx.fillRect(W, top, WALL, F + WALL - top); ctx.fillRect(-WALL, F, W + WALL * 2, WALL);

    // 淘汰線（超線時閃爍）
    const warn = st.over ? 0.5 + 0.5 * Math.sin(ts / 90) : 0;
    ctx.save();
    ctx.setLineDash([14, 10]); ctx.lineWidth = 2.5 + warn * 2; ctx.strokeStyle = theme["cv-danger"]; ctx.globalAlpha = 0.65 + warn * 0.35;
    ctx.beginPath(); ctx.moveTo(0, DL); ctx.lineTo(W, DL); ctx.stroke();
    ctx.restore();
    ctx.font = `500 ${13 * px}px ${theme.font}`; ctx.fillStyle = theme["cv-danger"]; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(st.over ? `超線！剩 ${Math.max(0, P.graceSec - st.grace).toFixed(1)} 秒` : "淘汰線", 8, DL - 5 * px);

    // 手上拼圖與落點預覽
    const hp = core.heldPose();
    const holding = hp && st.status === "playing";
    const pv = holding && core.previewVisible() ? core.dropPreview() : null;
    if (holding) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-WALL, 0, W + WALL * 2, F); ctx.clip();
      if (pv) {

        ctx.save();
        ctx.setLineDash([3 * px * 2, 9 * px]); ctx.lineWidth = Math.max(2, 1.5 * px); ctx.strokeStyle = theme["cv-wall"]; ctx.globalAlpha = cancelZone ? 0.2 : 0.75;
        ctx.beginPath(); ctx.moveTo(hp.px, hp.py); ctx.lineTo(hp.px, hp.py + pv.dy); ctx.stroke();
        ctx.restore();

        ctx.save(); ctx.globalAlpha = cancelZone ? 0.3 : 1;
        ctx.translate(pv.x, pv.y); ctx.rotate(pv.a);
        ctx.fillStyle = theme.ghost; ctx.globalAlpha *= 0.13; ctx.fill(fillPaths[pv.county], "evenodd"); ctx.globalAlpha = cancelZone ? 0.3 : 1;
        ctx.save(); ctx.clip(fillPaths[pv.county], "evenodd");
        ctx.rotate(-pv.a); ctx.translate(-pv.x, -pv.y);
        const pat = hatchPattern(); if (pat) { pat.setTransform(new DOMMatrix().scale(px)); ctx.fillStyle = pat; ctx.fillRect(pv.x - 700, pv.y - 700, 1400, 1400); }
        ctx.restore();
        ctx.setLineDash([8 * px, 6 * px]); ctx.lineWidth = Math.max(2.5, 1.6 * px); ctx.lineJoin = "round"; ctx.strokeStyle = theme.ghost;
        for (const b of borderPaths[pv.county]) ctx.stroke(b.path);
        ctx.restore();
      }
      const hpose = () => ({ x: hp.x, y: hp.y, a: hp.a });
      drawGroupShape([hp.county], hpose, cancelZone ? 0.35 : 1);
      ctx.restore();
    }

    // 場上群組：內容連續兩幀相同就使用（必要時建立）快取
    const gi = core.groupsInfo();
    const sig = scene.enabled && !(jx || jy) ? sceneSig(gi) : null;
    const cached = sig !== null && sig === scene.prevSig;
    scene.prevSig = sig; scene.hits += cached ? 1 : 0; scene.frames++;
    if (cached && scene.builtSig !== sig) {
      scene.shapes = layerCanvas(scene.shapes);
      paintInto(scene.shapes, () => drawPlacedShapes(gi, px));
      scene.rect = sceneRect(gi, 24);
      scene.builtSig = sig;
    }
    if (cached) blit(scene.shapes, scene.rect); else drawPlacedShapes(gi, px);

    // 提示：標出可與手上拼圖合併的縣市
    if (holding && $("chkHint").checked) {
      ctx.save(); ctx.strokeStyle = theme.hint; ctx.lineWidth = Math.max(5, 3 * px); ctx.lineJoin = "round";
      const ruleA = core.P.penghuLink !== "B" && core.penghuIdx >= 0;
      for (const g of gi) for (const m of g.members) if (core.adj[hp.county][m] && !(ruleA && m === core.penghuIdx && g.members.length > 1)) {
        const p = core.countyPose(m); if (!p) continue;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.stroke(fillPaths[m]); ctx.restore();
      }
      ctx.restore();
    }
    if (holding) { ctx.save(); ctx.beginPath(); ctx.rect(-WALL, 0, W + WALL * 2, F); ctx.clip(); drawLabel(hp.county, { x: hp.x, y: hp.y, a: hp.a }, cancelZone ? 0.35 : 1); ctx.restore(); }
    for (const g of gi) for (const m of g.members) { const p = core.countyPose(m); if (p) drawLabel(m, p, 1); }
    drawGuides(hp, st);

    // 合併特效圓環
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i], k = (ts - r.t0) / 450;
      if (k >= 1) { rings.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = 1 - k; ctx.lineWidth = 4 * (1 - k) + 1; ctx.strokeStyle = theme.hint;
      ctx.beginPath(); ctx.arc(r.x, r.y, 20 + k * (60 + r.size * 14), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }

    // 觸控取消提示
    if (pressed && pressType !== "mouse" && st.status === "playing" && (cancelZone || touchN < 5)) {
      ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (cancelZone) {
        ctx.font = `700 ${22 * px}px ${theme.font}`; ctx.fillStyle = theme["cv-danger"];
        ctx.fillText("放開＝取消", W / 2, Math.max(top + 30 * px, DL / 2));
      } else {
        ctx.font = `500 ${12 * px}px ${theme.font}`; ctx.fillStyle = theme["cv-danger"]; ctx.globalAlpha = 0.9;
        ctx.fillText("↑ 拖到紅線以上放開＝取消", W / 2, DL + 18 * px);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // 在小畫布中畫單一拼圖（下一塊、保留區）
  function drawPieceIn(cv, c2, m) {
    c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, cv.width, cv.height);
    if (m == null) return;
    const bb = shapes.pieces[m].bboxLocal, w = bb[2] - bb[0], h = bb[3] - bb[1];
    const s = Math.min((cv.width - 20) / w, (cv.height - 20) / h);
    c2.translate(cv.width / 2 - (bb[0] + w / 2) * s, cv.height / 2 - (bb[1] + h / 2) * s); c2.scale(s, s);
    c2.fillStyle = fillFor(m); c2.fill(fillPaths[m], "evenodd");
    c2.strokeStyle = theme["edge-out"]; c2.lineJoin = "round";
    c2.save(); c2.clip(outsidePaths[m], "evenodd"); c2.lineWidth = 2 * 2 / s * (m === PENGHU_I ? PENGHU_K : 1);
    for (const b of borderPaths[m]) c2.stroke(b.path);
    c2.restore();
  }
  function drawNext() {
    const m = core.nextPreview();
    $("nextName").textContent = m == null ? (core.state.held == null ? "—" : "最後一塊") : shapes.pieces[m].name;
    drawPieceIn(nextCv, nctx, m);
  }
  function drawSlot() {
    const m = core.state.slot;
    $("slotName").textContent = m == null ? "空" : shapes.pieces[m].name;
    drawPieceIn(slotCv, sctx, m);
  }

  let last = 0, hudT = 0, themeGen = 0;
  // 主迴圈：處理輸入、推進模擬、處理事件、繪製、更新 HUD
  function frame(ts) {
    const dt = last ? (ts - last) / 1000 : 0; last = ts;
    if (core) {
      const st = core.state;
      const pz = paused();
      if (st.status === "playing" && !pz) {
        const sp = 650 * dt;
        const h0 = core.heldPose();
        if (h0 && keys.left) core.setHeldX(h0.px - sp);
        if (h0 && keys.right) core.setHeldX(h0.px + sp);
      }
      const was = st.status;
      if (!pz) core.update(dt);
      for (const e of core.drainEvents()) {
        sfxEvent(e);
        if (e.type === "merge") {
          rings.push({ x: e.pos[0], y: e.pos[1], t0: ts, size: e.size });
          setMsg(`${core.pieces[e.a].name}＋${core.pieces[e.b].name} 合併・${e.size} 縣市`);
        } else if (e.type === "undoBonus") {
          setMsg(`合併第 ${e.n} 次！復原次數 +1（剩 ${e.left} 次）`);
        }
      }
      sfxImpacts(ts); sfxDanger(dt, pz);
      if (st.over && st.status === "playing" && tipOnce("over")) setMsg(`超過淘汰線了！累積 ${core.P.graceSec} 秒就結束；回到線下，倒數會慢慢復原。`, 6000);
      if (was === "playing" && st.status !== "playing") { saveNow(); showEnd(); }
      shakeAmp *= Math.pow(0.002, dt);

      draw(ts);
      hudT += dt;
      if (themeGen !== theme.gen) {
        themeGen = theme.gen; invalidatePreviews();
        if (!$("ovEnd").hidden) drawResultMap(core.groupsInfo());
      }
      const nk = String(st.dropped) + ":" + st.held + ":" + st.queue.length + ":" + st.queue[0];
      if (nk !== lastNextKey) { lastNextKey = nk; drawNext(); }
      const sk = String(st.slot);
      if (sk !== lastSlotKey) { lastSlotKey = sk; drawSlot(); }
      // 每 0.1 秒更新一次 HUD（setText／setProp／setAttr 只在值改變時寫入 DOM）
      if (hudT > 0.1) {
        hudT = 0;
        setText($("sDropped"), `${st.dropped}/${Nn()}`);
        setText($("sGroups"), String(core.groupsInfo().length));
        setText($("sTime"), fmtTime(st.status === "won" ? st.wonAt : st.time));
        const pct = Math.max(0, Math.min(100, (st.stamina / core.P.shakeMax) * 100));
        if ($("stam").style.width !== pct + "%") $("stam").style.width = pct + "%";
        $("stamBar").classList.toggle("low", st.stamina < core.P.shakeMin);
        setAttr($("stamBar"), "aria-valuenow", String(Math.round(pct)));
        const cs = core.canShake(), alt = !!core.P.shakeAlt;
        setProp($("shakeSel"), "hidden", alt); setProp($("shakeAlt"), "hidden", !alt);
        setProp($("btnShakeL"), "disabled", !cs); setProp($("btnShakeR"), "disabled", !cs); setProp($("btnShakeA"), "disabled", !cs);

        const nd = core.nextShakeDir();
        setText($("altL"), nd < 0 ? "◀ " : "　"); setText($("altR"), nd < 0 ? "　" : " ▶");
        setAttr($("btnShakeA"), "aria-label", nd < 0 ? "拍打（向左）" : "拍打（向右）");

        const ret = core.canRetrieve();
        setText($("holdLabel"), ret ? "取出" : "保留");
        setProp($("btnHold"), "disabled", !(ret || core.canHold()));
        syncUndoUi();
        const slotLeft = st.status === "playing" && st.held == null && !st.queue.length && st.slot != null;
        $("btnHold").classList.toggle("pulse", slotLeft);
        if (slotLeft && !slotHint) { slotHint = true; setMsg("拼圖都放完了，保留區還有一塊，按「取出」。", 5000); }
      }
    }
    requestAnimationFrame(frame);
  }

  // --- 音效（實作在 js/sfx.js）---
  const SFX = window.TPSfx.create({ load: () => store.get(KEYS.sfx), save: (v) => store.set(KEYS.sfx, v) });

  // 把物理碰撞轉成音效（限制數量與頻率）
  const sfxCol = { cd: new Map(), fresh: -1, freshT: 0, beatT: 0 };
  function sfxImpacts(ts) {
    const list = core.drainImpacts();
    if (!list.length || !SFX.pref.on) return;
    const now = ts / 1000, P = core.P, gof = core.groupOf;
    let info = null, played = 0;
    const freshG = sfxCol.fresh >= 0 && now - sfxCol.freshT < 3 ? gof[sfxCol.fresh] : -1;
    list.sort((p, q) => q.v - p.v);
    for (const im of list) {
      if (played >= 3) break;
      const gid = im.a >= 0 ? im.a : im.b;
      if (gid < 0) continue;
      const isFresh = freshG >= 0 && (im.a === freshG || im.b === freshG);
      if (im.v < (isFresh ? 0.4 : 0.7)) continue;
      const k = isFresh ? freshG : gid;
      if (now - (sfxCol.cd.get(k) || -1) < 0.09) continue;
      sfxCol.cd.set(k, now);
      if (!info) { info = new Map(); for (const g of core.groupsInfo()) info.set(g.id, g.members.reduce((s, m) => s + core.pieces[m].areaDisplay, 0)); }
      const area = info.get(k) || 20000;
      const f = Math.max(150, Math.min(1500, 520 * Math.sqrt(20822 / area)));
      SFX.knock(im.v, f, (im.x / P.containerW) * 1.6 - 0.8, isFresh);
      if (isFresh) sfxCol.fresh = -1;
      played++;
    }
  }
  // 遊戲事件對應音效
  function sfxEvent(e) {
    const P = core.P;
    if (e.type === "drop") { SFX.drop(); sfxCol.fresh = e.county; sfxCol.freshT = performance.now() / 1000; }
    else if (e.type === "hold") SFX.hold();
    else if (e.type === "retrieve") SFX.retrieve();
    else if (e.type === "shake") SFX.shake(e.dir);
    else if (e.type === "merge") {
      const na = core.pieces[e.a], nb = core.pieces[e.b], pair = na.name + nb.name;
      const inlay = /臺北市/.test(pair) && /新北市/.test(pair) || /嘉義市/.test(pair) && /嘉義縣/.test(pair);
      SFX.merge({ step: e.size - 2, pan: (e.pos[0] / P.containerW) * 1.4 - 0.7, delay: P.tweenSec * 0.85, inlay,
        metro: na.category === "直轄市" || nb.category === "直轄市", lift: e.lift || 0 });
    }
    else if (e.type === "undoBonus") SFX.bonus();
    else if (e.type === "win") SFX.win(core.N);
    else if (e.type === "lose") SFX.lose();
  }
  // 超線時的心跳聲
  function sfxDanger(dt, pz) {
    const st = core.state;
    if (pz || st.status !== "playing" || st.grace <= 0) { sfxCol.beatT = 0; return; }
    const ratio = Math.min(1, st.grace / core.P.graceSec);
    sfxCol.beatT -= dt;
    if (sfxCol.beatT <= 0) { SFX.heartbeat(ratio, st.over); sfxCol.beatT = st.over ? 0.9 - 0.55 * ratio : 1.1; }
  }
  // 音效開關 UI
  function syncSoundUi() {
    const on = SFX.pref.on;
    $("btnSound").setAttribute("aria-pressed", String(on));
    $("btnSound").title = on ? "音效：開（M）" : "音效：關（M）";
    $("sndWave").style.display = on ? "" : "none"; $("sndX").style.display = on ? "none" : "";
    $("chkSound").checked = on; $("rngVol").value = String(Math.round(SFX.pref.vol * 100));
  }
  function toggleSound() { SFX.setOn(!SFX.pref.on); syncSoundUi(); }
  $("btnSound").addEventListener("click", (e) => { toggleSound(); e.currentTarget.blur(); });
  $("chkSound").addEventListener("change", (e) => { SFX.setOn(e.target.checked); syncSoundUi(); });
  $("rngVol").addEventListener("input", (e) => SFX.setVol(Number(e.target.value) / 100));
  syncSoundUi();

  // 啟動：讀檔或開新局；偵錯模式下公開 window.__tp
  function boot() {
    renderKeymapHelp();
    loadOrNew(); syncModeUi(); syncDebugUi(); resize(); drawNext(); drawSlot(); requestAnimationFrame(frame);
    if (!store.get(KEYS.help)) { store.set(KEYS.help, true); openHelp("rules"); $("hpClose").textContent = "開始玩"; }
  }
  // 等字型載入（最多 1.2 秒）後啟動
  const fontsReady = document.fonts && document.fonts.load ? document.fonts.load("500 14px 'Noto Sans TC'", "台灣拼圖").catch(() => {}) : Promise.resolve();
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1200))]).then(boot);
})();
