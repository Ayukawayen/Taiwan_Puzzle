// TPGeom：2D 凸多邊形幾何純函式（不依賴 planck 與遊戲狀態）
// 多邊形皆為 [[x, y], ...] 頂點陣列；瀏覽器中為全域 TPGeom，Node 中以 require 取得
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TPGeom = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 分離軸測試：A 平移 (dx, dy) 後與 B 的最大間隙（負值為穿透深度）
  function satGap(A, B, dx, dy) {
    let best = -1e9;
    for (const poly of [A, B]) {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const x1 = poly[i][0], y1 = poly[i][1], x2 = poly[(i + 1) % n][0], y2 = poly[(i + 1) % n][1];
        let nx = y2 - y1, ny = -(x2 - x1); const L = Math.hypot(nx, ny); if (L < 1e-9) continue; nx /= L; ny /= L;
        let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
        for (const p of A) { const d = (p[0] + dx) * nx + (p[1] + dy) * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
        for (const p of B) { const d = p[0] * nx + p[1] * ny; if (d < b0) b0 = d; if (d > b1) b1 = d; }
        const gap = Math.max(b0 - a1, a0 - b1);
        if (gap > best) best = gap;
      }
    }
    return best;
  }

  // 凸包（單調鏈演算法），去除共線點
  function hull2(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    const up = [];
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  // 閔可夫斯基差 P − Q（凸包）
  function minkDiff(P_, Q_) {
    const pts = [];
    for (const p of P_) for (const q of Q_) pts.push([p[0] - q[0], p[1] - q[1]]);
    return hull2(pts);
  }

  // 凸多邊形在 x 處的垂直截線 [ymin, ymax]；不相交時回傳 null
  function chordAtX(H, x) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0, n = H.length; i < n; i++) {
      const p = H[i], q = H[(i + 1) % n];
      if ((p[0] <= x && q[0] >= x) || (p[0] >= x && q[0] <= x)) {
        if (p[0] === q[0]) { lo = Math.min(lo, p[1], q[1]); hi = Math.max(hi, p[1], q[1]); }
        else { const y = p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]); if (y < lo) lo = y; if (y > hi) hi = y; }
      }
    }
    return lo === Infinity ? null : [lo, hi];
  }

  return { satGap, hull2, minkDiff, chordAtX };
});
