// TPCore：遊戲核心（物理模擬、合併、存檔、行動記錄、重放），可在瀏覽器或 Node 使用
// 依賴：TPGeom（js/geometry.js）、TPLift（js/lift.js），瀏覽器中需先載入
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geometry.js"), require("./lift.js"));
  else root.TPCore = factory(root.TPGeom, root.TPLift);
})(typeof self !== "undefined" ? self : this, function (TPGeom, TPLift) {
  "use strict";
  const { satGap, minkDiff, chordAtX } = TPGeom;

  // 預設參數（長度單位為 px，S 為 px→物理世界的比例）
  const DEFAULTS = {
    S: 0.01,
    containerW: 1300,
    deadlineH: 1000,
    headroom: 520,
    gravity: 1800,
    friction: 0.5,
    restitution: 0.05,
    density: 1,
    linearDamping: 0.0,
    angularDamping: 0.08,
    dropGap: 14,
    dropCooldown: 0.45,
    graceSec: 10.0,
    mergeKick: 0.5,
    mergeSpin: 0.4,
    maxSpeed: 12,
    rotateDegPerSec: 60,
    penghu: true,
    penghuLink: "A",
    edgeW: 2,
    shakeAlt: false,
    shakeMax: 100,
    shakeCost: 20,
    shakeMin: 20,
    shakeRegen: 25,
    shakeCooldown: 0.06,
    shakeSide: 1.5,
    shakeVy: 3.2,
    shakeSpin: 1.2,
    tweenSec: 0.28,
    canonical: true,
    record: true,
    recMaxActions: 3000,
    liftOrderBias: 200,
    liftContactBias: 200,
    liftContactMax: 2,
    liftContactMinNy: 0.5,
    liftContactMaxRot: 30,
    undoStart: 1,
    undoBonusEvery: 5,
    stuckSec: 7,
    dt: 1 / 240,
    velIter: 10,
    posIter: 6,

  };

  // --- 版本 ---
  // SAVE_VERSION：存檔／快照內容格式；LOG_VERSION：行動記錄格式。
  // 讀取舊版資料一律經過 normalizeSave／normalizeLog 轉成目前格式，其他程式只需處理最新格式。
  const SAVE_VERSION = 6;
  const SAVE_VERSIONS_READABLE = [5, 6];
  const LOG_VERSION = 2;

  // 規則：隨存檔保存、還原時沿用的設定（其餘參數為調校參數）。
  // penghu／penghuLink 決定拼圖組成，存檔必須與遊戲實例一致；shakeAlt 會依存檔切換。
  const RULE_KEYS = ["penghu", "penghuLink", "shakeAlt"];

  // 把任一可讀版本的存檔補齊成目前格式（不修改輸入）；無法辨識時回傳 null。
  // v5 與早期 v6 缺少的欄位（拍打冷卻、卡關、復原次數等）在此補上預設值。
  function normalizeSave(sv, undoStart) {
    if (!sv || typeof sv !== "object" || SAVE_VERSIONS_READABLE.indexOf(sv.v) < 0) return null;
    return Object.assign({}, sv, {
      v: SAVE_VERSION,
      slot: sv.slot == null ? null : sv.slot,
      previewWait: sv.previewWait || 0,
      shakes: sv.shakes || 0, merges: sv.merges || 0,
      links: sv.links || [],
      shakeCd: sv.shakeCd || 0, stillT: sv.stillT || 0, stuck: !!sv.stuck,
      undo: sv.undo == null ? undoStart : sv.undo,
      undoClaimed: Array.isArray(sv.undoClaimed) ? sv.undoClaimed : [],
      undos: sv.undos || 0,
    });
  }

  // 可重現的亂數產生器
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 把角度正規化到 [-π, π]
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  // 建立一個遊戲實例
  function create(opts) {
    const planck = opts.planck;
    const shapes = opts.shapes;
    const P = Object.assign({}, DEFAULTS, opts.params || {});
    const { Vec2 } = planck;

    // 依設定篩選拼圖，並建立縣市相鄰矩陣
    const PENGHU = "澎湖縣";
    const pieces = shapes.pieces.filter((p) => P.penghu || p.name !== PENGHU);
    const N = pieces.length;
    const idxByName = {};
    pieces.forEach((p, i) => { idxByName[p.name] = i; });
    const penghuIdx = idxByName[PENGHU] == null ? -1 : idxByName[PENGHU];
    const adj = pieces.map(() => new Array(N).fill(false));
    const link2 = (a, b) => { if (idxByName[a] == null || idxByName[b] == null) return; adj[idxByName[a]][idxByName[b]] = true; adj[idxByName[b]][idxByName[a]] = true; };
    for (const a of Object.keys(shapes.adjacency)) for (const b of shapes.adjacency[a]) link2(a, b);
    if (penghuIdx >= 0) for (const b of (shapes.pengHuAdjacentToWestCoast || [])) link2(PENGHU, b);
    const homeX = pieces.map((p) => p.home[0]);
    const homeY = pieces.map((p) => p.home[1]);
    const weight = pieces.map((p) => p.areaDisplay);
    const densScale = pieces.map((p) => p.areaDisplay / p.areaSolid);
    const rotC = pieces.map((p) => [p.rotation.cx, p.rotation.cy]);
    const rotR = pieces.map((p) => p.rotation.r);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // 執行期狀態
    let world = null, wallBody = null, impacts = [];
    let undoSnap = null, undoGone = null;
    let groups = new Map();
    let groupOf = [];
    let nextGid = 1;
    let S = P.S;
    let st = null;
    let tweens = [];
    let events = [];
    let acc = 0;
    let simSteps = 0;

    const newLiftStats = () => ({ merges: 0, pairs: 0, pocket: 0, alt: 0, flip: 0, fail: 0, touch: 0, avoid: 0, cross: 0 });
    let liftStats = newLiftStats();

    // 發出事件給 UI，同時寫入行動記錄
    function emit(e) { events.push(e); if (cur) cur.tail.events.push(Object.assign({ d: sinceAct }, e)); }

    let rec = null, cur = null, sinceAct = 0;
    // --- 行動記錄（供偵錯與重放） ---
    function recHeader() {
      const pp = {}; for (const k of Object.keys(P)) { const v = P[k]; if (typeof v !== "function") pp[k] = v; }
      return { format: "tw-puzzle-log", logVersion: LOG_VERSION, saveVersion: SAVE_VERSION, created: Date.now(), params: pp, pieces: N, penghu: !!P.penghu };
    }

    function recStart(reason, prev, snap0) {
      if (!P.record) { rec = null; cur = null; return; }
      rec = prev && prev.format === "tw-puzzle-log" && prev.logVersion === LOG_VERSION && prev.seed === st.seed && prev.segments ? prev : Object.assign(recHeader(), { seed: st.seed, segments: [] });
      cur = { reason, at: Date.now(), time: st.time, snap0: JSON.parse(JSON.stringify(snap0 || serialize())), actions: [], nextN: 0, tail: { events: [] } };
      rec.segments.push(cur); sinceAct = 0;
    }

    // 新增一筆動作；超過上限時從有快照的位置截斷舊紀錄
    function pushEntry(type, prm, snap) {
      if (!cur) return;
      const e = Object.assign({ n: cur.nextN++, type, d: sinceAct, time: st.time }, prm, { events: cur.tail.events });
      if (snap) e.snap = snap;
      cur.actions.push(e);
      cur.tail = { events: [] }; sinceAct = 0;

      if (cur.actions.length > P.recMaxActions) {
        let k = cur.actions.length - P.recMaxActions;
        while (k < cur.actions.length && !cur.actions[k].snap) k++;
        if (k < cur.actions.length) { cur.actions.splice(0, k); cur.trimmed = (cur.trimmed || 0) + 1; }
      }
    }
    const recAction = (type, prm, snap) => pushEntry(type, prm, snap);
    const recLight = (type, prm) => pushEntry(type, prm, null);

    // 動作前先存快照；canonical 模式下從快照重建，確保可重放
    function beginAction(type, prm) {
      const snap = JSON.parse(JSON.stringify(serialize()));
      recAction(type, prm, snap);
      if (P.canonical) rebuildFrom(JSON.parse(JSON.stringify(snap)), { tweens: true });
      return snap;
    }

    // 從快照重建物理世界與遊戲狀態，但不打斷進行中的遊戲：
    // 保留 state 物件本身（外部可能持有 core.state 參照）、尚未取走的事件與時間累積量；
    // keep.tweens 為真時也保留補間動畫。快照無效時不做任何改變並回傳 false。
    function rebuildFrom(snap, keep) {
      const keepSt = st, keepE = events, keepAcc = acc, keepT = keep && keep.tweens ? tweens.slice() : null;
      if (!restoreState(snap)) return false;
      for (const k of Object.keys(keepSt)) if (!(k in st)) delete keepSt[k];
      st = Object.assign(keepSt, st);
      events = keepE; acc = keepAcc;
      if (keepT) tweens = keepT;
      return true;
    }
    // 匯出完整行動記錄（含目前狀態）
    function exportLog() {
      if (!rec) return null;
      const out = JSON.parse(JSON.stringify(rec));
      const last = out.segments[out.segments.length - 1];
      last.end = { d: sinceAct, events: cur ? cur.tail.events : [], time: st.time, snap: JSON.parse(JSON.stringify(serialize())) };
      for (const sg of out.segments) { delete sg.tail; delete sg.nextN; }
      out.exported = Date.now();
      return out;
    }

    // 重建物理世界與遊戲狀態，並用種子洗牌出牌順序
    function reset(seed) {
      S = P.S;
      world = new planck.World({ gravity: Vec2(0, P.gravity * S) });
      world.setAllowSleeping(true);

      impacts = [];
      // 記錄碰撞強度，供音效使用
      world.on("begin-contact", (c) => {
        if (impacts.length >= 64) return;
        const A = c.getFixtureA().getBody(), B = c.getFixtureB().getBody();
        const wm = c.getWorldManifold(null);
        if (!wm || !wm.normal) return;
        const p = wm.points && wm.points.length && c.getManifold().pointCount > 0 ? wm.points[0] : B.getWorldCenter();
        const va = A.getLinearVelocityFromWorldPoint(p), vb = B.getLinearVelocityFromWorldPoint(p);
        const v = Math.abs((vb.x - va.x) * wm.normal.x + (vb.y - va.y) * wm.normal.y);
        const ia = A.getUserData(), ib = B.getUserData();
        impacts.push({ a: typeof ia === "number" ? ia : -1, b: typeof ib === "number" ? ib : -1, v, x: p.x / S, y: p.y / S });
      });
      groups = new Map(); groupOf = new Array(N).fill(-1); nextGid = 1;
      tweens = new Array(N).fill(null);
      events = []; acc = 0; simSteps = 0;
      undoSnap = null; undoGone = null;
      buildWalls();
      const rng = mulberry32(seed >>> 0);
      const order = [...Array(N).keys()];
      for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      st = {
        links: [],
        seed: seed >>> 0, order, dropped: 0, queue: order.slice(), slot: null, previewAt: 0,
        held: null, heldX: P.containerW / 2, heldAngle: 0, cooldown: 0.2,
        status: "playing", time: 0, stamina: P.shakeMax, shakeCd: 0,
        grace: 0, over: false, stillT: 0, stuck: false, shakes: 0, merges: 0, wonAt: null,
        undo: P.undoStart, undoClaimed: [], undos: 0,
      };
    }

    // 地板與淘汰線的 y 座標
    function floorY() { return (P.headroom + P.deadlineH); }
    function deadlineY() { return P.headroom; }

    // 建立地板與左右牆
    function buildWalls() {
      wallBody = world.createBody({ type: "static", position: Vec2(0, 0) });
      const W = P.containerW * S, F = floorY() * S, T = 6, H = 80;
      const mk = (cx, cy, hx, hy) => wallBody.createFixture(new planck.Polygon([
        Vec2(cx - hx, cy - hy), Vec2(cx + hx, cy - hy), Vec2(cx + hx, cy + hy), Vec2(cx - hx, cy + hy)]),
        { friction: P.friction, restitution: 0, userData: -1 });
      mk(W / 2, F + T, W / 2 + T * 2, T);
      mk(-T, F - H, T, H + T);
      mk(W + T, F - H, T, H + T);
    }

    // 以面積加權求群組在拼好地圖上的中心點
    function pivotOf(members) {
      let sx = 0, sy = 0, sw = 0;
      for (const m of members) { sx += homeX[m] * weight[m]; sy += homeY[m] * weight[m]; sw += weight[m]; }
      return [sx / sw, sy / sw];
    }

    // 以一個或多個縣市建立剛體群組
    function makeGroup(members, posPx, angle, extra) {
      const pivot = pivotOf(members);
      const body = world.createBody({
        type: "dynamic", position: Vec2(posPx[0] * S, posPx[1] * S), angle,
        bullet: true, linearDamping: P.linearDamping, angularDamping: P.angularDamping, allowSleep: true,
      });
      for (const m of members) {
        for (const c of pieces[m].physics.convex) {
          const verts = c.map(([x, y]) => Vec2((homeX[m] + x - pivot[0]) * S, (homeY[m] + y - pivot[1]) * S));
          body.createFixture(new planck.Polygon(verts), {
            density: P.density * densScale[m], friction: P.friction, restitution: P.restitution, userData: m,
          });
        }
      }
      const g = { id: nextGid++, members: members.slice(), pivot, body, landed: false };
      body.setUserData(g.id);
      groups.set(g.id, g);
      for (const m of members) groupOf[m] = g.id;
      if (extra) Object.assign(g, extra);
      return g;
    }

    // 縣市在世界座標中的位置
    function worldPointOfMember(g, m) {
      const p = g.body.getWorldPoint(Vec2((homeX[m] - g.pivot[0]) * S, (homeY[m] - g.pivot[1]) * S));
      return [p.x / S, p.y / S];
    }

    // 群組的外接矩形
    function groupAABB(g) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const m of g.members) {
        for (const [x, y] of pieces[m].physics.outerSimplified) {
          const p = g.body.getWorldPoint(Vec2((homeX[m] - g.pivot[0] + x) * S, (homeY[m] - g.pivot[1] + y) * S));
          const px = p.x / S, py = p.y / S;
          if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
      return [x0, y0, x1, y1];
    }

    function heldAABBLocal(m, ang) {
      const c = Math.cos(ang), s = Math.sin(ang);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [x, y] of pieces[m].physics.outerSimplified) {
        const rx = x * c - y * s, ry = x * s + y * c;
        if (rx < x0) x0 = rx; if (rx > x1) x1 = rx; if (ry < y0) y0 = ry; if (ry > y1) y1 = ry;
      }
      return [x0, y0, x1, y1];
    }
    // 手上拼圖的位置與角度（限制在容器內、淘汰線上方）
    function heldPose() {
      if (st.held == null) return null;
      const m = st.held, R = rotR[m], a = st.heldAngle, c = Math.cos(a), sn = Math.sin(a);
      const lo = R + 2, hi = P.containerW - R - 2;
      const px = hi < lo ? P.containerW / 2 : clamp(st.heldX, lo, hi);
      const py = deadlineY() - P.dropGap - R;
      const [cx, cy] = rotC[m];
      const x = px - (c * cx - sn * cy), y = py - (sn * cx + c * cy);
      return { county: m, x, y, a, px, py, r: R, bbox: heldAABBLocal(m, a) };
    }
    function setHeldX(xpx) { st.heldX = xpx; }
    function spawnHeld() {
      if (st.queue.length) st.held = st.queue.shift();
      else st.held = null;
      st.heldAngle = 0;
    }
    function nextPreview() { return st.queue.length ? st.queue[0] : null; }

    // 估算落到底所需時間（用來延後顯示落點預覽）
    function fallTime() {
      const g = P.gravity * S, H = P.deadlineH * S, vm = P.maxSpeed;
      const ta = vm / g, da = 0.5 * g * ta * ta;
      return H <= da ? Math.sqrt(2 * H / g) : ta + (H - da) / vm;
    }
    function previewVisible() { return st.time >= st.previewAt; }
    function unplaced() {
      const out = [];
      if (st.held != null) out.push(st.held);
      for (const m of st.queue) out.push(m);
      if (st.slot != null) out.push(st.slot);
      return out;
    }

    // 放下手上的拼圖
    function drop() {
      if (st.status !== "playing" || st.held == null) return false;
      const snap = beginAction("drop", { county: st.held, x: st.heldX, a: st.heldAngle });
      undoSnap = snap; undoGone = null;
      const hp = heldPose();
      const g = makeGroup([hp.county], [hp.x, hp.y], hp.a);
      g.body.setLinearVelocity(Vec2(0, 0)); g.body.setAngularVelocity(0);
      st.dropped++; st.held = null; st.cooldown = P.dropCooldown; st.heldAngle = 0;
      st.previewAt = st.time + fallTime();
      emit({ type: "drop", county: hp.county });
      return true;
    }

    // 保留：把手上的拼圖放進保留區
    function canHold() { return st.status === "playing" && st.held != null && st.slot == null && st.queue.length > 0; }
    function hold() {
      if (!canHold()) return false;
      st.slot = st.held; st.held = st.queue.shift(); st.heldAngle = 0;
      recLight("hold", { county: st.slot });
      emit({ type: "hold", county: st.slot });
      return true;
    }

    // 取出：從保留區換回手上
    function canRetrieve() { return st.status === "playing" && st.slot != null && !(st.held == null && st.queue.length > 0); }
    function retrieve() {
      if (!canRetrieve()) return false;
      const back = st.held;
      if (back != null) st.queue.unshift(back);
      st.held = st.slot; st.slot = null; st.heldAngle = 0;
      recLight("retrieve", { county: st.held, back });
      emit({ type: "retrieve", county: st.held });
      return true;
    }

    // --- 幾何工具 ---
    function polyKeys(body) {
      const out = new Map(), seen = {};
      for (let f = body.getFixtureList(); f; f = f.getNext()) {
        const m = f.getUserData(); seen[m] = seen[m] == null ? 0 : seen[m] + 1;
        out.set(f, m + ":" + seen[m]);
      }
      return out;
    }
    function bodyPolys(body) {
      const out = [], keys = polyKeys(body);
      for (let f = body.getFixtureList(); f; f = f.getNext()) {
        const vs = f.getShape().m_vertices;
        const pts = vs.map((v) => { const p = body.getWorldPoint(v); return [p.x / S, p.y / S]; });
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        out.push({ pts, b: [x0, y0, x1, y1], key: keys.get(f) });
      }
      return out;
    }

    // 兩剛體間接觸的上下關係（用於合併後維持疊放順序）
    function contactRel(bx, by, skipM, out) {
      out = out || new Map();
      const kx = polyKeys(bx), ky = polyKeys(by);
      for (let ce = bx.getContactList(); ce; ce = ce.next) {
        if (ce.other !== by) continue;
        const c = ce.contact;
        if (!c.isTouching()) continue;
        const man = c.getManifold(); if (!man || !man.pointCount) continue;
        const ny = c.getWorldManifold(null).normal.y;
        if (Math.abs(ny) < P.liftContactMinNy) continue;
        const fa = c.getFixtureA(), fb = c.getFixtureB();
        const fx = fa.getBody() === bx ? fa : fb, fy = fx === fa ? fb : fa;
        if (skipM && skipM.has(fx.getUserData())) continue;
        const sg = (fx === fa ? 1 : -1) * (ny > 0 ? 1 : -1);
        const k = kx.get(fx) + "|" + ky.get(fy);
        out.set(k, (out.get(k) || 0) + sg);
      }
      return out;
    }

    // 偵錯：目前最大穿透深度
    function maxPenetration() {
      let worst = 0;
      const all = [...groups.values()].map((g) => bodyPolys(g.body));
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
        for (const A of all[i]) for (const B of all[j]) {
          if (A.b[2] < B.b[0] || A.b[0] > B.b[2] || A.b[3] < B.b[1] || A.b[1] > B.b[3]) continue;
          worst = Math.max(worst, -satGap(A.pts, B.pts, 0, 0));
        }
      for (const polys of all) for (const A of polys) {
        worst = Math.max(worst, A.b[3] - floorY(), -A.b[0], A.b[2] - P.containerW);
      }
      return worst;
    }

    // 偵錯：某縣市嵌入其他拼圖的程度
    function deepIn(m) {
      const g = groups.get(groupOf[m]); if (!g) return null;
      const mine = [];
      for (let f = g.body.getFixtureList(); f; f = f.getNext()) if (f.getUserData() === m) {
        const pts = f.getShape().m_vertices.map((v) => { const p = g.body.getWorldPoint(v); return [p.x / S, p.y / S]; });
        mine.push(pts);
      }
      let depth = 0, other = -1, inside = false;
      for (const g2 of groups.values()) {
        if (g2 === g) continue;
        for (const B of bodyPolys(g2.body)) for (const A of mine) {
          const d = -satGap(A, B.pts, 0, 0);
          if (d > depth) { depth = d; other = g2.members[0]; }
        }
      }

      for (const A of mine) {
        const cx = A.reduce((a, p) => a + p[0], 0) / A.length, cy = A.reduce((a, p) => a + p[1], 0) / A.length;
        for (const g2 of groups.values()) {
          if (g2 === g) continue;
          for (const B of bodyPolys(g2.body)) {
            let pos = 0, neg = 0;
            for (let i = 0, n = B.pts.length; i < n; i++) { const p = B.pts[i], q = B.pts[(i + 1) % n]; const cr = (q[0] - p[0]) * (cy - p[1]) - (q[1] - p[1]) * (cx - p[0]); if (cr > 0) pos++; else neg++; }
            const ins = pos === 0 || neg === 0;
            if (ins) { inside = true; }
          }
        }
      }
      return { depth, other, inside };
    }

    // 偵錯：列出穿透超過門檻的群組對
    function penPairs(minPx) {
      const out = [], gl = [...groups.values()], all = gl.map((g) => bodyPolys(g.body));
      const nm = (g) => g.members.map((m) => pieces[m].name).join("+");
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        let w = 0;
        for (const A of all[i]) for (const B of all[j]) {
          if (A.b[2] < B.b[0] || A.b[0] > B.b[2] || A.b[3] < B.b[1] || A.b[1] > B.b[3]) continue;
          w = Math.max(w, -satGap(A.pts, B.pts, 0, 0));
        }
        if (w > minPx) out.push([nm(gl[i]), nm(gl[j]), +w.toFixed(1)]);
      }
      for (let i = 0; i < all.length; i++) { let w = 0; for (const A of all[i]) w = Math.max(w, A.b[3] - floorY(), -A.b[0], A.b[2] - P.containerW); if (w > minPx) out.push([nm(gl[i]), "wall", +w.toFixed(1)]); }
      return out;
    }

    // 計算手上拼圖垂直落下後的停點（落點預覽）
    function dropPreview() {
      const hp = heldPose(); if (!hp) return null;
      const c = Math.cos(hp.a), sn = Math.sin(hp.a);
      const mine = pieces[hp.county].physics.convex.map((cv) => cv.map(([x, y]) => [hp.x + x * c - y * sn, hp.y + x * sn + y * c]));
      const boxes = mine.map((A) => { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of A) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; });
      let best = floorY() - Math.max(...boxes.map((b) => b[3])) - 1;
      let hitBy = -1;
      for (const g of groups.values()) {
        for (const B of bodyPolys(g.body)) {
          for (let k = 0; k < mine.length; k++) {
            const ab = boxes[k];
            if (B.b[2] < ab[0] || B.b[0] > ab[2] || B.b[3] < ab[1]) continue;
            const D = minkDiff(B.pts, mine[k]);
            const ch = chordAtX(D, 0);
            if (!ch || ch[1] < 0) continue;
            const t = Math.max(ch[0], 0) - 1;
            if (t < best) { best = t; hitBy = g.id; }
          }
        }
      }
      best = Math.max(best, 0);
      return { county: hp.county, x: hp.x, y: hp.y + best, a: hp.a, dy: best, hitBy };
    }

    // 判斷兩群組誰在上方
    function verticalOrder(gx, gy) {
      let v = 0;
      const PA = bodyPolys(gx.body), PB = bodyPolys(gy.body);
      for (const A of PA) for (const B of PB) {
        if (Math.min(A.b[2], B.b[2]) - Math.max(A.b[0], B.b[0]) <= 1) continue;
        const ch = chordAtX(minkDiff(A.pts, B.pts), 0); if (!ch) continue;
        if (ch[1] <= 0.5) v++; else if (ch[0] >= -0.5) v--;
      }
      return v;
    }

    // 合併後若與其他拼圖重疊，求解最小的向上位移，並盡量保持原本上下順序
    function liftAfterMerge(ng, preOrder, preContact) {
      const gl = [...groups.values()], n = gl.length;
      const ngi = gl.indexOf(ng);
      const polys = gl.map((g) => bodyPolys(g.body));
      const { d, stats } = TPLift.solve({
        n, ngi, polys, floorY: floorY(), params: P,
        lb0: Math.max(0, groupAABB(ng)[3] - (floorY() - 0.5)),
        // 上下關係：與新群組的配對用合併前記下的 preOrder，其餘即時判斷
        orderOf: (i, j) => {
          if (i === ngi) return preOrder ? -(preOrder.get(gl[j].id) || 0) : 0;
          if (j === ngi) return preOrder ? (preOrder.get(gl[i].id) || 0) : 0;
          return verticalOrder(gl[j], gl[i]);
        },
        // 接觸關係：與新群組的配對用合併前記下的 preContact，其餘讀取目前接觸
        relOf: (i, j) => {
          const R = new Map();
          if (i === ngi || j === ngi) {
            const src = preContact && preContact.get(gl[i === ngi ? j : i].id);
            if (src) for (const [k, v] of src) { if (!v) continue; if (i === ngi) R.set(k, Math.sign(v)); else { const [a, b] = k.split("|"); R.set(b + "|" + a, -Math.sign(v)); } }
          } else {
            for (const [k, v] of contactRel(gl[i].body, gl[j].body, null)) if (v) R.set(k, Math.sign(v));
          }
          return R;
        },
      });

      // 套用位移：被帶動的舊群組加上補間動畫
      const carried = [];
      const fromPoses = new Map();
      for (let k = 0; k < n; k++) {
        const g = gl[k], dy = d[k];
        if (!(dy > 0.05)) continue;
        if (g !== ng) { carried.push(g.id); for (const m of g.members) { const p = worldPointOfMember(g, m); fromPoses.set(m, { x: p[0], y: p[1], a: g.body.getAngle() }); } }
        const p = g.body.getPosition();
        g.body.setTransform(Vec2(p.x, p.y - dy * S), g.body.getAngle());
        g.body.setAwake(true);
        if (dy > 2) g.landed = false;
      }
      for (const [m, fp] of fromPoses) tweens[m] = { x: fp.x, y: fp.y, a: fp.a, t: 0 };
      for (const k in stats) liftStats[k] += stats[k];
      liftStats.merges++;
      return { lift: d[ngi], carried, cycle: stats.fail > 0, maxd: Math.max(...d), gaps: stats };
    }

    // 合併兩群組：保留動量與角動量，必要時旋轉以塞進容器，再處理重疊
    function mergeGroups(gA, gB, cA, cB) {
      const bA = gA.body, bB = gB.body;
      const mA = bA.getMass(), mB = bB.getMass(), M = mA + mB;
      const comA = bA.getWorldCenter(), comB = bB.getWorldCenter();
      const com = Vec2((comA.x * mA + comB.x * mB) / M, (comA.y * mA + comB.y * mB) / M);
      const vA = bA.getLinearVelocity(), vB = bB.getLinearVelocity();
      const wA = bA.getAngularVelocity(), wB = bB.getAngularVelocity();
      const IcA = bA.getInertia() - mA * Vec2.dot(bA.getLocalCenter(), bA.getLocalCenter());
      const IcB = bB.getInertia() - mB * Vec2.dot(bB.getLocalCenter(), bB.getLocalCenter());
      const vCom = Vec2((vA.x * mA + vB.x * mB) / M, (vA.y * mA + vB.y * mB) / M);

      const L = IcA * wA + IcB * wB;
      const thA = bA.getAngle(), thB = bB.getAngle();
      const th = Math.atan2(mA * Math.sin(thA) + mB * Math.sin(thB), mA * Math.cos(thA) + mB * Math.cos(thB));

      const fromPose = {};
      for (const g of [gA, gB]) for (const m of g.members) {
        const p = worldPointOfMember(g, m); fromPose[m] = { x: p[0], y: p[1], a: g.body.getAngle() };
      }
      const members = gA.members.concat(gB.members);
      const landed = gA.landed || gB.landed;
      const posGuess = [com.x / S, com.y / S];
      const ng = makeGroup(members, posGuess, th, { landed });

      let c2 = ng.body.getWorldCenter();
      let pos = ng.body.getPosition();
      ng.body.setTransform(Vec2(pos.x + com.x - c2.x, pos.y + com.y - c2.y), th);

      // 群組太大時嘗試旋轉，讓它塞得進容器
      const wMax = P.containerW - 6, hMax = P.deadlineH - 6;
      const rotateAboutCom = (ang) => {
        const c = ng.body.getWorldCenter(), p = ng.body.getPosition(), d = ang - ng.body.getAngle();
        const rx = p.x - c.x, ry = p.y - c.y, cs = Math.cos(d), sn = Math.sin(d);
        ng.body.setTransform(Vec2(c.x + rx * cs - ry * sn, c.y + rx * sn + ry * cs), ang);
      };
      let bb = groupAABB(ng);
      const fitsFull = (b) => b[2] - b[0] <= wMax && b[3] - b[1] <= hMax;
      const fitsW = (b) => b[2] - b[0] <= wMax;
      if (!fitsFull(bb)) {
        let found = false;
        for (const test of [fitsFull, fitsW]) {
          for (let k = 1; k <= 180 && !found; k++) {
            for (const sgn of [1, -1]) {
              rotateAboutCom(th + sgn * k * Math.PI / 180);
              bb = groupAABB(ng);
              if (test(bb)) { found = true; break; }
            }
          }
          if (found) break;
        }
        if (!found) { rotateAboutCom(th); bb = groupAABB(ng); }
      }

      let dx = 0;
      if (bb[0] < 3) dx = 3 - bb[0]; else if (bb[2] > P.containerW - 3) dx = P.containerW - 3 - bb[2];
      if (dx) { const p = ng.body.getPosition(); ng.body.setTransform(Vec2(p.x + dx * S, p.y), ng.body.getAngle()); }

      // 記錄合併前與其他群組的上下及接觸關係
      const preOrder = new Map();
      for (const g of groups.values()) if (g !== gA && g !== gB && g !== ng) { const o = verticalOrder(gA, g) + verticalOrder(gB, g); if (o) preOrder.set(g.id, o); }

      const preContact = new Map();
      if (P.liftContactBias > 0) {
        const skipM = new Set(), fin = ng.body.getAngle(), lim = P.liftContactMaxRot * Math.PI / 180;
        const rot = (a) => Math.abs(Math.atan2(Math.sin(fin - a), Math.cos(fin - a)));
        if (rot(thA) > lim) for (const m of gA.members) skipM.add(m);
        if (rot(thB) > lim) for (const m of gB.members) skipM.add(m);
        for (const g of groups.values()) if (g !== gA && g !== gB && g !== ng) {
          const R = contactRel(bA, g.body, skipM); contactRel(bB, g.body, skipM, R);
          if (R.size) preContact.set(g.id, R);
        }
      }

      world.destroyBody(bA); world.destroyBody(bB);
      groups.delete(gA.id); groups.delete(gB.id);
      const lift = liftAfterMerge(ng, preOrder, preContact);

      const Inew = ng.body.getInertia() - ng.body.getMass() * Vec2.dot(ng.body.getLocalCenter(), ng.body.getLocalCenter());
      let wNew = Inew > 1e-9 ? L / Inew : 0;
      wNew = Math.max(-8, Math.min(8, wNew));
      ng.body.setLinearVelocity(Vec2(vCom.x, vCom.y - P.mergeKick));
      ng.body.setAngularVelocity(wNew + (st.rng ? (st.rng() - 0.5) : Math.random() - 0.5) * 2 * P.mergeSpin);
      ng.body.setAwake(true);

      for (const m of members) tweens[m] = { x: fromPose[m].x, y: fromPose[m].y, a: fromPose[m].a, t: 0 };
      // 合併次數達倍數時獎勵復原次數
      st.merges++;
      const bonus = P.undoBonusEvery > 0 && st.merges % P.undoBonusEvery === 0 && st.undoClaimed.indexOf(st.merges) < 0;
      if (bonus) { st.undoClaimed.push(st.merges); st.undo++; }

      if (penghuIdx >= 0 && (cA === penghuIdx || cB === penghuIdx)) st.links.push([penghuIdx, cA === penghuIdx ? cB : cA]);
      const cc = ng.body.getWorldCenter();
      emit({ type: "merge", a: cA, b: cB, size: members.length, gid: ng.id, pos: [cc.x / S, cc.y / S], lift: lift.lift, maxd: lift.maxd, carried: lift.carried.length, cycle: lift.cycle, gaps: lift.gaps });
      if (bonus) emit({ type: "undoBonus", n: st.merges, left: st.undo });
      if (members.length === N && st.status === "playing") {
        st.status = "won"; st.wonAt = st.time; undoSnap = null;
        emit({ type: "win", time: st.time });
      }
      return ng;
    }

    // 找出相鄰縣市且正在接觸的配對
    function scanContacts() {
      const pairs = [];
      for (const g of groups.values()) g._touch = false;
      for (let c = world.getContactList(); c; c = c.getNext()) {
        if (!c.isTouching()) continue;
        const fa = c.getFixtureA(), fb = c.getFixtureB();
        const a = fa.getUserData(), b = fb.getUserData();
        const ga = groups.get(fa.getBody().getUserData()), gb = groups.get(fb.getBody().getUserData());
        if (ga) ga.landed = true;
        if (gb) gb.landed = true;
        if (a >= 0 && b >= 0 && adj[a][b] && ga && gb && ga !== gb) {

          // 規則 A：澎湖只能連接一次
          if (P.penghuLink !== "B" && penghuIdx >= 0 && (a === penghuIdx || b === penghuIdx)) {
            const gp = a === penghuIdx ? ga : gb;
            if (gp.members.length > 1) continue;
          }
          pairs.push([a, b]);
        }
      }
      return pairs;
    }

    // 處理本步所有合併（每步最多 8 次）
    function processMergesAll() {
      const pairs = scanContacts();
      let n = 0;
      for (const [a, b] of pairs) {
        const ga = groups.get(groupOf[a]), gb = groups.get(groupOf[b]);
        if (!ga || !gb || ga === gb) continue;
        mergeGroups(ga, gb, a, b);
        if (++n >= 8) break;
      }
      return n;
    }

    // 限制最大線速度與角速度
    function clampSpeeds() {
      for (const g of groups.values()) {
        const v = g.body.getLinearVelocity(), sp = Math.hypot(v.x, v.y);
        if (sp > P.maxSpeed) g.body.setLinearVelocity(Vec2(v.x * P.maxSpeed / sp, v.y * P.maxSpeed / sp));
        const w = g.body.getAngularVelocity();
        if (Math.abs(w) > 12) g.body.setAngularVelocity(Math.sign(w) * 12);
      }
    }

    // 固定時間步長推進一步
    function stepOnce() {
      const dt = P.dt;
      world.step(dt, P.velIter, P.posIter);
      simSteps++; sinceAct++;
      clampSpeeds();
      if (st.status === "playing" || st.status === "won") processMergesAll();
      if (st.status !== "playing") return;
      st.time += dt;
      st.stamina = Math.min(P.shakeMax, st.stamina + P.shakeRegen * dt);
      if (st.shakeCd > 0) st.shakeCd -= dt;
      if (st.held == null && st.queue.length) {
        st.cooldown -= dt;
        if (st.cooldown <= 0) spawnHeld();
      }
      if (simSteps % 4 === 0) checkDeadline(dt * 4);
    }

    // 超過淘汰線累計緩衝時間，滿了就輸；並偵測卡關
    function checkDeadline(dt) {
      let over = false, maxSp = 0;
      const dl = deadlineY();
      for (const g of groups.values()) {
        const v = g.body.getLinearVelocity(); maxSp = Math.max(maxSp, Math.hypot(v.x, v.y) / S);
        if (!g.landed) continue;
        const bb = groupAABB(g);
        if (bb[1] < dl) { over = true; }
      }
      st.over = over;
      if (over) st.grace += dt; else st.grace = Math.max(0, st.grace - dt * 2);
      if (st.grace >= P.graceSec) {
        st.status = "lost"; emit({ type: "lose" });
      }

      if (st.dropped >= N && maxSp < 6) st.stillT += dt; else { st.stillT = 0; st.stuck = false; }
      if (!st.stuck && st.stillT > P.stuckSec) st.stuck = true;
    }

    // 每幀呼叫：依實際時間累積步數，並旋轉手上拼圖、推進補間動畫
    function update(realDt) {
      if (!world) return;
      realDt = Math.min(realDt, 0.1);
      acc += realDt;
      let n = 0;
      while (acc >= P.dt && n < 24) { stepOnce(); acc -= P.dt; n++; }
      if (n >= 24) acc = 0;
      if (st.status === "playing" && st.held != null) st.heldAngle = wrapPi(st.heldAngle + P.rotateDegPerSec * Math.PI / 180 * realDt);
      for (let m = 0; m < N; m++) {
        const t = tweens[m];
        if (t) { t.t += realDt; if (t.t >= P.tweenSec) tweens[m] = null; }
      }
    }

    // --- 拍打：給所有群組一個側向與向上的衝量 ---
    function canShake() { return st.status === "playing" && st.stamina >= P.shakeMin && st.shakeCd <= 0 && groups.size > 0; }
    function nextShakeDir() { return st.shakes % 2 === 0 ? -1 : 1; }

    function shake(dir) {
      if (!canShake()) return false;
      const d = P.shakeAlt ? nextShakeDir() : (dir < 0 ? -1 : 1);
      const hadUndo = !!undoSnap;
      beginAction("shake", { dir: d });
      undoSnap = null; undoGone = hadUndo ? "shake" : null;
      st.stamina -= P.shakeCost; st.shakeCd = P.shakeCooldown; st.shakes++;
      const rnd = st.rng || Math.random;
      for (const g of groups.values()) {
        const b = g.body, m = b.getMass();
        const dvx = d * P.shakeSide * (0.85 + rnd() * 0.3), dvy = P.shakeVy * (0.5 + rnd() * 0.5);
        b.applyLinearImpulse(Vec2(m * dvx, -m * dvy), b.getWorldCenter(), true);
        b.setAngularVelocity(b.getAngularVelocity() + (rnd() * 2 - 1) * P.shakeSpin);
        b.setAwake(true);
      }
      emit({ type: "shake", dir: d });
      return true;
    }

    // 縣市目前的繪製姿態（含合併時的補間動畫）
    function countyPose(m) {
      const g = groups.get(groupOf[m]);
      if (!g) return null;
      const p = worldPointOfMember(g, m);
      const cur = { x: p[0], y: p[1], a: g.body.getAngle() };
      const t = tweens[m];
      if (!t) return cur;
      const k = Math.min(1, t.t / P.tweenSec), e = 1 - Math.pow(1 - k, 3);
      return { x: t.x + (cur.x - t.x) * e, y: t.y + (cur.y - t.y) * e, a: t.a + wrapPi(cur.a - t.a) * e };
    }
    function groupsInfo() {
      const out = [];
      for (const g of groups.values()) out.push({ id: g.id, members: g.members.slice(), landed: g.landed, awake: g.body.isAwake() });
      return out;
    }
    function drainEvents() { const e = events; events = []; return e; }
    function drainImpacts() { const e = impacts; impacts = []; return e; }

    // --- 存檔與還原 ---
    function serialize(full) {
      const gs = [];
      for (const g of groups.values()) {
        const p = g.body.getPosition(), v = g.body.getLinearVelocity();
        gs.push({ members: g.members, x: p.x / S, y: p.y / S, a: g.body.getAngle(), vx: v.x, vy: v.y, w: g.body.getAngularVelocity(), landed: g.landed });
      }
      return {
        v: SAVE_VERSION, params: { containerW: P.containerW, deadlineH: P.deadlineH, headroom: P.headroom, S: P.S },
        seed: st.seed, order: st.order, queue: st.queue, slot: st.slot, previewWait: Math.max(0, st.previewAt - st.time), shakeAlt: !!P.shakeAlt, dropped: st.dropped, held: st.held, heldX: st.heldX, heldAngle: st.heldAngle,
        status: st.status, time: st.time, stamina: st.stamina, grace: st.grace, shakes: st.shakes, merges: st.merges,
        cooldown: st.cooldown, wonAt: st.wonAt, groups: gs,
        penghu: !!P.penghu, penghuLink: P.penghuLink, links: st.links,
        shakeCd: st.shakeCd, stillT: st.stillT, stuck: st.stuck,
        undo: st.undo, undoClaimed: st.undoClaimed.slice(), undos: st.undos,
        undoSnap: full && undoSnap ? undoSnap : undefined,
      };
    }

    // 還原時依進度重新產生亂數種子
    const reseed = (sv) => mulberry32(((sv.seed ^ 0x9E3779B9) ^ Math.imul((sv.dropped | 0) * 977 + (sv.shakes | 0) * 31 + (sv.merges | 0) * 7 + 1, 0x85EBCA6B)) >>> 0);
    function restore(sv, prevLog) {
      const copy = JSON.parse(JSON.stringify(sv));
      if (!restoreState(sv)) return false;
      undoSnap = sv.undoSnap && typeof sv.undoSnap === "object" ? sv.undoSnap : null;
      delete copy.undoSnap;
      recStart("restore", prevLog, copy);
      return true;
    }

    // 規則：存檔的拼圖組成是否與本實例相同；採用存檔中可切換的規則
    const rulesCompatible = (sv) => !!sv.penghu === !!P.penghu && sv.penghuLink === P.penghuLink;
    function adoptRules(sv) { P.shakeAlt = !!sv.shakeAlt; }
    function rules() { return { penghu: !!P.penghu, penghuLink: P.penghuLink, shakeAlt: !!P.shakeAlt }; }

    // 驗證存檔後重建遊戲狀態（任何可讀版本皆可，先經 normalizeSave 補齊）
    function restoreState(raw) {
      const sv = normalizeSave(raw, P.undoStart);
      if (!sv) return false;
      if (!rulesCompatible(sv)) return false;
      for (const k of ["containerW", "deadlineH", "headroom", "S"]) if (sv.params[k] !== P[k]) return false;
      if (!Array.isArray(sv.groups) || !Array.isArray(sv.queue) || sv.order.length !== N) return false;
      {
        const all = [];
        for (const g of sv.groups) for (const m of g.members) all.push(m);
        if (sv.held != null) all.push(sv.held);
        for (const m of sv.queue) all.push(m);
        if (sv.slot != null) all.push(sv.slot);
        if (all.length !== N || new Set(all).size !== N) return false;
      }
      reset(sv.seed);
      st.rng = reseed(sv);
      st.shakeCd = sv.shakeCd; st.stillT = sv.stillT; st.stuck = sv.stuck;
      st.undo = sv.undo; st.undoClaimed = sv.undoClaimed.slice(); st.undos = sv.undos;
      adoptRules(sv);
      st.queue = sv.queue.slice(); st.slot = sv.slot;
      st.previewAt = (sv.time || 0) + sv.previewWait;
      st.order = sv.order; st.dropped = sv.dropped; st.held = sv.held; st.heldX = sv.heldX; st.heldAngle = sv.heldAngle;
      st.status = sv.status; st.time = sv.time; st.stamina = sv.stamina; st.grace = sv.grace; st.shakes = sv.shakes;
      st.merges = sv.merges; st.cooldown = sv.cooldown; st.wonAt = sv.wonAt; st.links = sv.links.map((l) => l.slice());
      const seen = new Set();
      for (const g of sv.groups) {
        for (const m of g.members) { if (seen.has(m) || m < 0 || m >= N) return false; seen.add(m); }
        const ng = makeGroup(g.members, [g.x, g.y], g.a, { landed: !!g.landed });
        ng.body.setLinearVelocity(Vec2(g.vx, g.vy)); ng.body.setAngularVelocity(g.w);
      }
      return true;
    }

    // --- 復原：回到最後一次放下之前 ---
    function undoBlocked() {
      if (!st) return "none";
      if (st.status === "won") return "won";
      if (!undoSnap) return undoGone || "none";
      if (st.undo <= 0) return "count";
      if (st.status !== "playing" && st.status !== "lost") return "none";
      return "";
    }
    function canUndo() { return undoBlocked() === ""; }
    function undoInfo() { return { left: st ? st.undo : 0, county: undoSnap ? undoSnap.held : null, blocked: undoBlocked() }; }
    function undo() {
      if (!canUndo()) return false;
      const snap = undoSnap, county = snap.held;

      const from = [];
      for (let m = 0; m < N; m++) { const p = countyPose(m); if (p) from[m] = p; }
      const keep = { time: st.time, stamina: st.stamina, undo: st.undo - 1, claimed: st.undoClaimed.slice(), undos: (st.undos || 0) + 1 };

      if (cur) cur.end = { d: sinceAct, events: cur.tail.events, time: st.time, snap: JSON.parse(JSON.stringify(serialize())) };

      const target = JSON.parse(JSON.stringify(snap));
      Object.assign(target, { time: keep.time, stamina: Math.min(P.shakeMax, keep.stamina), undo: keep.undo, undoClaimed: keep.claimed, undos: keep.undos });
      if (!rebuildFrom(JSON.parse(JSON.stringify(target)))) return false;
      undoSnap = null; undoGone = "used";
      for (let m = 0; m < N; m++) if (from[m] && groupOf[m] >= 0) tweens[m] = { x: from[m].x, y: from[m].y, a: from[m].a, t: 0 };
      recStart("undo", rec, target);
      emit({ type: "undo", county, left: st.undo });
      return true;
    }

    // 開新局
    function newGame(seed) {
      reset(seed == null ? (Math.random() * 4294967296) >>> 0 : seed);
      liftStats = newLiftStats();
      st.rng = mulberry32((st.seed ^ 0x9E3779B9) >>> 0);
      spawnHeld();
      recStart("new");
    }
    function setParams(p) { Object.assign(P, p); }

    // 對外公開的介面
    const api = {
      N, pieces, adj, idxByName, P, penghuIdx,
      newGame, restore, serialize, update, stepOnce, drop, shake, canShake, undo, canUndo, undoBlocked, undoInfo,
      setHeldX, heldPose, nextPreview, unplaced, dropPreview, previewVisible, fallTime, hold, retrieve, canHold, canRetrieve, nextShakeDir, maxPenetration, penPairs, deepIn, countyPose, groupsInfo, drainEvents, drainImpacts, setParams,
      groupAABB: (gid) => groupAABB(groups.get(gid)),
      exportLog, get log() { return rec; }, restoreState, rules,
      get liftStats() { return liftStats; },
      debugMerge: (a, b) => { const ga = groups.get(groupOf[a]), gb = groups.get(groupOf[b]); if (ga && gb && ga !== gb) { mergeGroups(ga, gb, a, b); return true; } return false; },
      floorY, deadlineY,
      get state() { return st; },
      get groupOf() { return groupOf; },
      get world() { return world; },
    };
    return api;
  }

  // 比較兩個快照的差異（重放驗證用）
  const IGNORE = new Set(["heldX", "heldAngle"]);
  const ADDED_V17 = new Set(["undo", "undoClaimed", "undos", "undoSnap"]);
  function compareSnap(got, want) {
    const diffs = [];
    const walk = (a, b, path) => {
      if (diffs.length > 200) return;
      if (typeof a === "number" && typeof b === "number") { if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) diffs.push({ path, got: a, want: b, delta: a - b }); return; }
      if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a !== b) diffs.push({ path, got: a, want: b }); return; }
      if (Array.isArray(a) !== Array.isArray(b)) { diffs.push({ path, got: Array.isArray(a) ? "array" : "object", want: Array.isArray(b) ? "array" : "object" }); return; }
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) { if (IGNORE.has(k) && path === "") continue; if (path === "" && ADDED_V17.has(k) && !(k in b)) continue; walk(a[k], b[k], path ? path + "." + k : k); }
    };
    walk(got, want, "");
    let maxPos = 0;
    if (got.groups && want.groups) for (let i = 0; i < Math.min(got.groups.length, want.groups.length); i++) {
      const g = got.groups[i], h = want.groups[i]; if (g.members.join() === h.members.join()) maxPos = Math.max(maxPos, Math.hypot(g.x - h.x, g.y - h.y));
    }
    return { diffs, maxPos };
  }

  // 把舊版（v1）行動記錄轉成 v2 格式
  function normalizeLog(log) {
    const out = JSON.parse(JSON.stringify(log));
    if ((out.logVersion || 1) >= 2) return out;
    for (const sg of out.segments || []) {
      const acts = []; let n = 0;
      const conv = (a) => {
        let last = 0;
        for (const o of a.holdOps || []) { acts.push({ n: n++, type: o.op, d: o.d - last, time: null, county: o.county, events: [] }); last = o.d; }
        a.d -= last; delete a.holdOps; return a;
      };
      for (const a of sg.actions || []) { conv(a); a.n = n++; acts.push(a); }
      sg.actions = acts;
      if (sg.end) { const keep = acts.length; conv(sg.end); sg.endLights = acts.length - keep; }
    }
    out.logVersion = 2; out.convertedFrom = 1;
    return out;
  }
  const hasSnap = (a) => a.type === "drop" || a.type === "shake";
  // 重放器：從記錄中的快照逐段重跑，檢查結果是否一致
  function makeReplayer(opts) {
    if (!opts.log || opts.log.format !== "tw-puzzle-log") throw Object.assign(new Error("not a tw-puzzle-log"), { code: "not-log" });
    const log = normalizeLog(opts.log);

    const core = create({ planck: opts.planck, shapes: opts.shapes, params: Object.assign({ liftContactBias: 0 }, log.params, { record: false, canonical: false }) });
    const clone = (o) => JSON.parse(JSON.stringify(o));

    const pts = log.segments.map((sg) => {
      const out = [], snaps = [];
      sg.actions.forEach((a, i) => { if (hasSnap(a)) snaps.push(i); });
      if (sg.trimmed) { if (!snaps.length) return []; out.push({ i: snaps.shift() }); } else out.push({ i: -1 });
      for (const i of snaps) out.push({ i });
      if (sg.end) out.push({ i: sg.actions.length, end: true });
      return out;
    });
    const count = (si) => (pts[si] ? Math.max(0, pts[si].length - 1) : 0);
    function applyAct(a) {
      if (a.type === "drop") { core.state.heldAngle = a.a; core.setHeldX(a.x); return core.drop(); }
      if (a.type === "shake") return core.shake(a.dir);
      return false;
    }

    function applyLight(a) {
      if (a.type === "hold") return core.hold() && core.state.slot === a.county;
      if (a.type === "retrieve") {
        const had = core.state.held;
        return core.retrieve() && core.state.held === a.county && (a.back === undefined || had === a.back);
      }
      return false;
    }
    function run(si, j) {
      const sg = log.segments[si], P0 = pts[si] && pts[si][j], P1 = pts[si] && pts[si][j + 1];
      if (!sg || !P0 || !P1) return null;
      const acts = sg.actions, from = P0.i < 0 ? null : acts[P0.i], to = P1.end ? sg.end : acts[P1.i];
      const mids = acts.slice(P0.i + 1, P1.i);
      const steps = mids.reduce((t, a) => t + a.d, 0) + to.d;
      // from／to：「#編號 動作」，或 "start"（段落開頭）、"end"（匯出當下）；error 為代碼，顯示文字由介面決定
      const res = { seg: si, j, from: from ? `#${from.n} ${from.type}` : "start", to: P1.end ? "end" : `#${to.n} ${to.type}`, steps, sec: +(steps * core.P.dt).toFixed(3), lights: mids.length };
      if (!core.restoreState(clone(from ? from.snap : sg.snap0))) return Object.assign(res, { same: false, error: "bad-start-snapshot" });
      res.applied = from ? applyAct(from) : true;
      let lightOk = true;
      for (const a of mids) {
        for (let k = 0; k < a.d; k++) core.stepOnce();
        if (!applyLight(a)) { lightOk = false; res.lightFail = `#${a.n} ${a.type}`; }
      }
      for (let k = 0; k < to.d; k++) core.stepOnce();
      core.drainEvents();
      const c = compareSnap(clone(core.serialize()), to.snap);
      return Object.assign(res, { same: c.diffs.length === 0 && res.applied !== false && lightOk, nDiffs: c.diffs.length, maxPos: +c.maxPos.toFixed(4), diffs: c.diffs.slice(0, 20) });
    }
    function runAll(si) { const out = []; for (let j = 0; j < count(si); j++) out.push(run(si, j)); return out; }
    return { log, core, count, run, runAll, segments: log.segments.length };
  }

  return { create, DEFAULTS, mulberry32, makeReplayer, compareSnap, normalizeLog, normalizeSave, RULE_KEYS, VERSIONS: { save: SAVE_VERSION, saveReadable: SAVE_VERSIONS_READABLE.slice(), log: LOG_VERSION } };
});
