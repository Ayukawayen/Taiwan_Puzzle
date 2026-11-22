// TPLift：合併後的「上推」求解器（純計算，不依賴 planck）
// 合併出的新群組可能與其他群組重疊；本模組求每個群組要往上移多少（d[i] ≥ 0），
// 使兩兩不重疊，並盡量維持合併前的上下順序與接觸關係、讓總位移最小。
// 瀏覽器中為全域 TPLift，Node 中以 require 取得；需要先載入 TPGeom。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geometry.js"));
  else root.TPLift = factory(root.TPGeom);
})(typeof self !== "undefined" ? self : this, function (G) {
  "use strict";
  const { minkDiff, chordAtX } = G;

  // opts：
  //   n, ngi        群組數、新群組的索引
  //   polys[i]      群組 i 的世界座標凸多邊形 [{ pts, b: [x0,y0,x1,y1], key: "縣市:序號" }]
  //   lb0           新群組至少要上推的量（例如穿出地板時）
  //   floorY        地板 y；任何位移超過此值視為無解
  //   params        { liftOrderBias, liftContactBias, liftContactMax }
  //   orderOf(i,j)  i、j 的上下關係（正負號有意義，0 為未知）
  //   relOf(i,j)    i、j 的接觸關係 Map<"keyI|keyJ", ±1>
  // 回傳 { d, stats }
  function solve(opts) {
    const { n, ngi, polys, floorY, params: P, orderOf, relOf } = opts;
    const DELTA = 1, TOL = 1, EPS = 1e-6;
    const xr = polys.map((ps) => { let a = 1e9, b = -1e9; for (const p of ps) { if (p.b[0] < a) a = p.b[0]; if (p.b[2] > b) b = p.b[2]; } return [a, b]; });
    const xOverlap = (i, j) => xr[i][1] - xr[j][0] > DELTA && xr[j][1] - xr[i][0] > DELTA;

    // i、j 之間「不可接受」的相對位移區間（d[j] − d[i] 落在區間內就會重疊）
    const fcache = new Map(), fraw = new Map();
    function forbid(i, j) {
      const key = i * 4096 + j;
      if (fcache.has(key)) return fcache.get(key);
      const iv = [], raw = [];
      if (xOverlap(i, j)) {
        const mine = i === ngi || j === ngi;
        for (const A of polys[i]) for (const B of polys[j]) {
          if (A.b[2] - B.b[0] <= DELTA || B.b[2] - A.b[0] <= DELTA) continue;
          const D = minkDiff(A.pts, B.pts);
          const c0 = chordAtX(D, 0); if (!c0) continue;
          if (!chordAtX(D, DELTA) || !chordAtX(D, -DELTA)) continue;
          let lo = -c0[1] + TOL, hi = -c0[0] - TOL;
          if (hi <= lo) continue;

          // 舊群組之間：只保留往較近一側脫離所需的部分
          if (!mine && lo < 0 && hi > 0) { if (hi < -lo) hi = 0; else lo = 0; }
          iv.push([lo, hi]); raw.push({ lo, hi, key: A.key + "|" + B.key });
        }
        iv.sort((a, b) => a[0] - b[0]);
        for (let k = 1; k < iv.length; k++) {
          const p = iv[k - 1], q = iv[k];
          if (q[0] <= p[1] + EPS) { p[1] = Math.max(p[1], q[1]); iv.splice(k, 1); k--; }
        }
      }
      fcache.set(key, iv); fraw.set(key, raw);
      return iv;
    }

    const ccache = new Map();
    function rel0(i, j) {
      const key = i * 4096 + j;
      if (ccache.has(key)) return ccache.get(key);
      const R = relOf(i, j);
      ccache.set(key, R); return R;
    }

    // 選定的間隙會讓多少對原本接觸的拼圖上下顛倒
    function crossings(i, j, G0, G1) {
      const R = rel0(i, j); if (!R.size) return 0;
      const bad = new Set();
      for (const f of fraw.get(i * 4096 + j) || []) {
        const s0 = R.get(f.key); if (!s0) continue;
        const sg = G1 <= f.lo + EPS ? 1 : G0 >= f.hi - EPS ? -1 : 0;
        if (sg && sg !== s0) { const [a, b] = f.key.split("|"); bad.add(a.split(":")[0] + "|" + b.split(":")[0]); }
      }
      return bad.size;
    }

    const inside = (F, r) => { for (let k = 0; k < F.length; k++) if (F[k][0] < r - EPS && r + EPS < F[k][1]) return k; return -1; };

    const ocache = new Map();
    function order(i, j) {
      const key = i * 4096 + j;
      if (ocache.has(key)) return ocache.get(key);
      const o = Math.sign(orderOf(i, j)); ocache.set(key, o); return o;
    }

    // 可行間隙依代價排序：距離＋（顛倒上下順序的懲罰）
    function gapsByDist(F, r, o) {
      const g = [];
      let prev = -Infinity;
      for (const [lo, hi] of F) { if (lo > prev) g.push([prev, lo]); prev = Math.max(prev, hi); }
      g.push([prev, Infinity]);
      for (const x of g) {
        x.dist = r < x[0] ? x[0] - r : r > x[1] ? r - x[1] : 0;
        const side = x[1] === Infinity ? 1 : x[0] === -Infinity ? -1 : 0;
        x.flip = side * o < 0;
        x.cost = x.dist + (x.flip ? P.liftOrderBias : 0);
      }
      return g.sort((a, b) => a.cost - b.cost);
    }

    const lb = new Array(n).fill(0);
    lb[ngi] = opts.lb0;
    const cons = [];
    // 差分約束（Bellman–Ford 式鬆弛）：求滿足所有 G0 ≤ d[j]−d[i] ≤ G1 的最小 d
    const solveCons = () => {
      const d = lb.slice();
      const edges = [];
      for (const c of cons) {
        if (c.G0 > -Infinity) edges.push([c.i, c.j, c.G0]);
        if (c.G1 < Infinity) edges.push([c.j, c.i, -c.G1]);
      }
      for (let pass = 0; pass <= n; pass++) {
        let changed = false;
        for (const [u, v, w] of edges) if (d[u] + w > d[v] + EPS) { d[v] = d[u] + w; changed = true; }
        if (!changed) { for (const x of d) if (x > floorY) return null; return d; }
      }
      return null;
    };
    let d = solveCons();
    const done = new Set(), stats = { pairs: 0, pocket: 0, alt: 0, flip: 0, fail: 0, touch: 0, avoid: 0, cross: 0 };
    // 每輪挑一對仍重疊的群組（新群組優先、脫離量小者優先），為它選一個間隙並加入約束
    for (let iter = 0; iter < 4 * n * n; iter++) {

      let best = null;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const key = i * 4096 + j; if (done.has(key)) continue;
        const F = forbid(i, j); if (!F.length) continue;
        const r = d[j] - d[i], k = inside(F, r); if (k < 0) continue;
        const esc = Math.min(F[k][1] - r, r - F[k][0]);
        const pri = (i === ngi || j === ngi ? 0 : 1e6) + esc;
        if (!best || pri < best.pri) best = { i, j, key, F, r, pri };
      }
      if (!best) break;
      done.add(best.key);
      const gaps = gapsByDist(best.F, best.r, order(best.i, best.j));
      const useC = P.liftContactBias > 0 && rel0(best.i, best.j).size > 0;
      let pick = null, first = -1;
      for (let a = 0; a < gaps.length; a++) {
        const gp = gaps[a];
        if (pick && gp.cost >= pick.total) break;
        const c = { i: best.i, j: best.j, G0: gp[0], G1: gp[1] };
        cons.push(c); const nd = solveCons(); cons.pop();
        if (!nd) continue;
        if (first < 0) first = a;
        const cross = useC ? crossings(best.i, best.j, gp[0], gp[1]) : 0;
        const total = gp.cost + Math.min(cross, P.liftContactMax) * P.liftContactBias;
        if (!pick || total < pick.total) pick = { a, c, nd, cross, total };
        if (!useC) break;
      }
      const ok = !!pick;
      if (pick) {
        cons.push(pick.c); d = pick.nd; stats.pairs++;
        const c = pick.c, gp = gaps[pick.a];
        if (c.G0 > -Infinity && c.G1 < Infinity) stats.pocket++;
        if (pick.a > 0) stats.alt++;
        if (gp.flip) stats.flip++;
        if (useC) stats.touch++;
        if (pick.a !== first) stats.avoid++;
        if (pick.cross) stats.cross++;
      }
      if (!ok) stats.fail++;
    }
    return { d, stats };
  }

  return { solve };
});
