// P&ID 기호 인식 (브라우저·Node 공용): 범례 시트에서 기호 모양을 배워 두고(템플릿), 도면에서 같은 모양을 찾는다.
//
// 1) 기본 도형 추출(extractPrimitives): PDF 연산 목록의 경로를 하위 경로 단위 폴리라인으로 펼친다(곡선은 4점으로 근사).
//    좌표는 페이지 pt(좌상단 원점). 외곽선 글자(작은 채움 다각형)는 기호가 아니므로 뺀다.
// 2) 템플릿(makeTemplate): 범례의 기호 하나를 이루는 도형들을 1pt 간격 점으로 바꿔 중심 기준으로 저장한다.
//    가장 큰 도형을 기준 도형(anchor)으로 삼는다.
// 3) 찾기(detectSymbols): 도면에서 기준 도형과 같은 종류(점 수·곡선·닫힘·채움)이고 크기 비가 맞는 도형마다
//    회전 4방향 × 뒤집기로 템플릿을 겹쳐 보고, 양방향 점 일치율(템플릿→도면, 도면→템플릿)로 점수를 매긴다.
//    겹치는 결과는 점수가 높은(같으면 더 큰) 기호만 남긴다.

const MOVE = 0, LINE = 1, CURVE = 2, QUAD = 3, CLOSE = 4;

/**
 * @returns {Promise<{W:number, H:number, prims: Array<{pts:number[][], curves:number, closed:boolean, fill:boolean, stroke:boolean, dash:boolean, w:number, bb:number[]}>}>}
 */
export async function extractPrimitives(page, OPS, Util) {
  const list = await page.getOperatorList({ intent: 'print' });
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  let ctm = [1, 0, 0, 1, 0, 0], lw = 1, dash = false;
  const stack = [];
  const prims = [];
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, lw, dash]);
    else if (fn === OPS.restore) [ctm, lw, dash] = stack.pop() || [ctm, lw, dash];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, lw, dash]); if (a[0]) ctm = Util.transform(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) [ctm, lw, dash] = stack.pop() || [ctm, lw, dash];
    else if (fn === OPS.setLineWidth) lw = a[0];
    else if (fn === OPS.setDash) dash = Array.isArray(a[0]) ? a[0].length > 0 : !!a[0]?.length;
    else if (fn === OPS.constructPath) {
      const [op, data] = a;
      const d = data?.[0];
      if (!d || typeof d.length !== 'number') continue;
      const fill = fillOps.has(op), stroke = strokeOps.has(op);
      if (!fill && !stroke) continue;
      const m = Util.transform(vp.transform, ctm);
      const pt = (x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
      const w = lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
      const subs = [];
      let cur = null, start = null, last = null;
      for (let k = 0; k < d.length;) {
        const c = d[k++];
        if (c === MOVE) { start = last = [d[k++], d[k++]]; cur = { pts: [pt(...start)], curves: 0, closed: false }; subs.push(cur); }
        else if (c === LINE) { last = [d[k++], d[k++]]; cur?.pts.push(pt(...last)); }
        else if (c === CURVE) {
          const c1 = [d[k++], d[k++]], c2 = [d[k++], d[k++]], e = [d[k++], d[k++]];
          if (cur && last) {
            for (const t of [0.25, 0.5, 0.75, 1]) {
              const u = 1 - t;
              cur.pts.push(pt(
                u * u * u * last[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
                u * u * u * last[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]));
            }
            cur.curves++;
          }
          last = e;
        } else if (c === QUAD) {
          const c1 = [d[k++], d[k++]], e = [d[k++], d[k++]];
          if (cur && last) {
            for (const t of [0.5, 1]) { const u = 1 - t; cur.pts.push(pt(u * u * last[0] + 2 * u * t * c1[0] + t * t * e[0], u * u * last[1] + 2 * u * t * c1[1] + t * t * e[1])); }
            cur.curves++;
          }
          last = e;
        } else if (c === CLOSE) { if (cur && start) { cur.pts.push(pt(...start)); cur.closed = true; } last = start; }
        else break;
      }
      for (const s of subs) {
        if (s.pts.length < 2) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of s.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        const p = { pts: s.pts, curves: s.curves, closed: s.closed, fill, stroke, dash, w, bb: [x0, y0, x1, y1] };
        if (fill && isGlyph(p)) continue;
        prims.push(p);
      }
    }
  }
  return { W, H, prims };
}

/** 외곽선 글자 조각: 작은 채움 다각형(점이 많거나 가는 것). 화살촉·채운 밸브(점 3~6개, 2pt 이상)는 남긴다. */
function isGlyph(p) {
  const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1];
  if (Math.max(w, h) < 1.2) return true;
  if (p.curves > 0 && Math.max(w, h) < 9) return true;
  if (p.pts.length > 9 && Math.max(w, h) < 9) return true;
  return Math.min(w, h) < 1.3;
}

const STEP = 1; // 점 간격(pt)

/** 도형 하나를 점들로: 선은 1pt 간격, 채움은 외곽선 + 내부 격자. kind 1 = 선, 2 = 채움 */
function primPoints(p, out, lens) {
  const d = diag(p.bb);
  const push = (x, y, k) => { out.push(x, y, k); lens?.push(d); };
  const n = p.pts.length;
  for (let i = 1; i < n; i++) {
    const [ax, ay] = p.pts[i - 1], [bx, by] = p.pts[i];
    const L = Math.hypot(bx - ax, by - ay);
    const m = Math.max(1, Math.ceil(L / STEP));
    for (let j = i === 1 ? 0 : 1; j <= m; j++) push(ax + (bx - ax) * j / m, ay + (by - ay) * j / m, p.fill ? 2 : 1);
  }
  if (p.fill && n >= 3) {
    const [x0, y0, x1, y1] = p.bb;
    for (let y = y0 + STEP / 2; y < y1; y += STEP) {
      for (let x = x0 + STEP / 2; x < x1; x += STEP) if (inPoly(p.pts, x, y)) push(x, y, 2);
    }
  }
}
function inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const diag = (bb) => Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);
const sig = (p) => ({ n: p.pts.length, curves: p.curves > 0, closed: p.closed, fill: p.fill });

/**
 * 범례 기호 하나(도형 목록)로 템플릿을 만든다.
 * @param {Array} prims  그 기호를 이루는 도형들
 * @param {object} meta  {id, label, kind, ...} — 그대로 템플릿에 붙는다
 */
export function makeTemplate(prims, meta = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of prims) { x0 = Math.min(x0, p.bb[0]); y0 = Math.min(y0, p.bb[1]); x1 = Math.max(x1, p.bb[2]); y1 = Math.max(y1, p.bb[3]); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const raw = [];
  for (const p of prims) primPoints(p, raw);
  const pts = [];
  for (let i = 0; i < raw.length; i += 3) pts.push([+(raw[i] - cx).toFixed(2), +(raw[i + 1] - cy).toFixed(2), raw[i + 2]]);
  // 기준 도형: 가장 긴 직선 조각(같은 기호라도 폴리라인 하나로 그리거나 선 여러 개로 나눠 그릴 수 있어 조각 단위로 맞춘다).
  // 직선이 짧고 곡선 도형(원 등)이 크면 그 곡선 도형을 기준으로 삼는다.
  const tdiag = Math.hypot(x1 - x0, y1 - y0);
  let seg = null;
  for (const p of prims) {
    if (p.dash || p.curves) continue;
    for (let i = 1; i < p.pts.length; i++) {
      const [ax, ay] = p.pts[i - 1], [bx, by] = p.pts[i];
      const L = Math.hypot(bx - ax, by - ay);
      if (!seg || L > seg.len) seg = { len: L, ax, ay, bx, by };
    }
  }
  const curved = prims.filter((p) => p.curves && !p.dash).sort((a, b) => diag(b.bb) - diag(a.bb))[0];
  let anchor;
  if (seg && (seg.len >= 0.4 * tdiag || !curved)) {
    anchor = { type: 'seg', len: +seg.len.toFixed(2), dx: +((seg.bx - seg.ax) / seg.len).toFixed(4), dy: +((seg.by - seg.ay) / seg.len).toFixed(4),
      cx: +((seg.ax + seg.bx) / 2 - cx).toFixed(2), cy: +((seg.ay + seg.by) / 2 - cy).toFixed(2) };
  } else {
    const A = curved || prims[0];
    anchor = { type: 'curve', w: +(A.bb[2] - A.bb[0]).toFixed(2), h: +(A.bb[3] - A.bb[1]).toFixed(2),
      cx: +((A.bb[0] + A.bb[2]) / 2 - cx).toFixed(2), cy: +((A.bb[1] + A.bb[3]) / 2 - cy).toFixed(2) };
  }
  return { ...meta, w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2), anchor, pts };
}

/** 점 격자 색인 */
function pointGrid(xs, ys, ks, cell, ls = null) {
  const map = new Map();
  for (let i = 0; i < xs.length; i++) {
    const k = Math.floor(xs[i] / cell) * 100003 + Math.floor(ys[i] / cell);
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(i);
  }
  return {
    /** (x,y)에서 tol 안의 점이 있는가 (needFill이면 채움 점만) */
    /** maxLen: 그보다 큰 도형(긴 배관 선 등)의 점은 세지 않는다 */
    has(x, y, tol, needFill, maxLen = Infinity) {
      const r = Math.ceil(tol / cell), cx = Math.floor(x / cell), cy = Math.floor(y / cell), t2 = tol * tol;
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gy = cy - r; gy <= cy + r; gy++) {
          const a = map.get(gx * 100003 + gy);
          if (!a) continue;
          for (const i of a) {
            if (needFill && ks[i] !== 2) continue;
            if (ls && ls[i] > maxLen) continue;
            const dx = xs[i] - x, dy = ys[i] - y;
            if (dx * dx + dy * dy <= t2) return true;
          }
        }
      }
      return false;
    },
    /** 사각형 안의 점 번호 */
    within(x0, y0, x1, y1) {
      const out = [];
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
        for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
          for (const i of map.get(gx * 100003 + gy) || []) if (xs[i] >= x0 && xs[i] <= x1 && ys[i] >= y0 && ys[i] <= y1) out.push(i);
        }
      }
      return out;
    },
  };
}

// 회전(0/90/180/270) × 뒤집기: (x,y) → (a*x + b*y, c*x + d*y)
const XFORMS = [
  [1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0],
  [-1, 0, 0, 1], [0, 1, 1, 0], [1, 0, 0, -1], [0, -1, -1, 0],
];
const XFORM_NAMES = ['0', '90', '180', '270', 'm0', 'm90', 'm180', 'm270'];

/** 도면 전체 점 집합 준비 (기호 찾기 전에 한 번) */
export function prepareTarget(prims) {
  const raw = [], lens = [];
  for (const p of prims) primPoints(p, raw, lens);
  const n = raw.length / 3;
  const xs = new Float32Array(n), ys = new Float32Array(n), ks = new Uint8Array(n), ls = Float32Array.from(lens);
  for (let i = 0; i < n; i++) { xs[i] = raw[i * 3]; ys[i] = raw[i * 3 + 1]; ks[i] = raw[i * 3 + 2]; }
  // 직선 조각 목록(길이순): 기준 조각 후보를 길이로 빨리 고른다
  const segs = [];
  for (const p of prims) {
    if (p.dash || p.curves) continue;
    for (let i = 1; i < p.pts.length; i++) {
      const [ax, ay] = p.pts[i - 1], [bx, by] = p.pts[i];
      const L = Math.hypot(bx - ax, by - ay);
      if (L >= 1) segs.push({ len: L, mx: (ax + bx) / 2, my: (ay + by) / 2, dx: (bx - ax) / L, dy: (by - ay) / L });
    }
  }
  segs.sort((a, b) => a.len - b.len);
  const curved = prims.filter((p) => p.curves && !p.dash);
  return { prims, segs, curved, xs, ys, ks, ls, grid: pointGrid(xs, ys, ks, 2, ls) };
}

/**
 * 템플릿 목록으로 도면에서 기호를 찾는다.
 * @param {{prims, xs, ys, ks, grid}} target  prepareTarget 결과
 * @param {Array} library  makeTemplate 결과 목록 (scale: [min,max] 허용 배율을 가질 수 있음)
 * @returns {Array<{id, label, kind, bb:number[], rot:string, scale:number, score:number, fwd:number, rev:number}>}  bb는 pt
 */
export function detectSymbols(target, library, opts = {}) {
  const { segs, curved, xs, ys, ls, grid } = target;
  const minFwd = opts.minFwd ?? 0.9, minRev = opts.minRev ?? 0.75, minScore = opts.minScore ?? 0.8;
  const found = [];
  const lowerBound = (L) => { let lo = 0, hi = segs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].len < L) lo = m + 1; else hi = m; } return lo; };
  for (const T of library) {
    if (T.disabled) continue;
    // 너무 작거나 단순한 기호(글자 조각과 구별되지 않음)는 찾지 않는다
    if (!T.small && (T.pts.length < 25 || Math.max(T.w, T.h) < 9)) continue;
    const A = T.anchor;
    const [smin, smax] = T.scale || [0.8, 1.25];
    const xforms = T.rotate === false ? [0] : T.mirror === false ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5, 6, 7];
    const stepS = Math.max(1, Math.floor(T.pts.length / 16));
    const sample = T.pts.filter((_, i) => i % stepS === 0);
    const seen = new Set();
    // 가설: (배율 s, 변환 xi, 템플릿 중심 ox, oy)
    const hyps = [];
    if (A.type === 'seg') {
      for (let k = lowerBound(A.len * smin); k < segs.length && segs[k].len <= A.len * smax; k++) {
        const g = segs[k];
        const s = g.len / A.len;
        for (const xi of xforms) {
          const [a, b, c, d] = XFORMS[xi];
          const rx = a * A.dx + b * A.dy, ry = c * A.dx + d * A.dy;
          if (Math.abs(rx * g.dy - ry * g.dx) > 0.04) continue; // 방향이 평행해야
          hyps.push([s, xi, g.mx - s * (a * A.cx + b * A.cy), g.my - s * (c * A.cx + d * A.cy)]);
        }
      }
    } else {
      const tdiag = Math.hypot(A.w, A.h);
      for (const P of curved) {
        const pw = P.bb[2] - P.bb[0], ph = P.bb[3] - P.bb[1];
        const s = tdiag > 0.5 ? Math.hypot(pw, ph) / tdiag : 1;
        if (s < smin || s > smax) continue;
        const pcx = (P.bb[0] + P.bb[2]) / 2, pcy = (P.bb[1] + P.bb[3]) / 2;
        for (const xi of xforms) {
          const [a, b, c, d] = XFORMS[xi];
          const rw = Math.abs(a) * A.w + Math.abs(b) * A.h, rh = Math.abs(c) * A.w + Math.abs(d) * A.h;
          if (Math.abs(rw * s - pw) > Math.max(1.2, 0.12 * pw) || Math.abs(rh * s - ph) > Math.max(1.2, 0.12 * ph)) continue;
          hyps.push([s, xi, pcx - s * (a * A.cx + b * A.cy), pcy - s * (c * A.cx + d * A.cy)]);
        }
      }
    }
    for (const [s, xi, ox, oy] of hyps) {
      const key = `${xi}:${Math.round(ox)}:${Math.round(oy)}:${Math.round(s * 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b, c, d] = XFORMS[xi];
      const tol = Math.max(1.3, 0.9 * s);
      // 기호보다 훨씬 긴 도형(지나가는 배관·신호선, 표 테두리)은 기호의 일부로 세지 않는다
      const maxLen = Math.max(20, 1.5 * s * Math.hypot(T.w, T.h));
      const map = (q) => [ox + s * (a * q[0] + b * q[1]), oy + s * (c * q[0] + d * q[1])];
      let hit = 0;
      for (const q of sample) { const [x, y] = map(q); if (grid.has(x, y, tol, q[2] === 2, maxLen)) hit++; }
      if (hit < sample.length * (minFwd - 0.12)) continue;
      hit = 0;
      const tp = T.pts.map(map);
      const hits = new Uint8Array(tp.length);
      for (let i = 0; i < tp.length; i++) if (grid.has(tp[i][0], tp[i][1], tol, T.pts[i][2] === 2, maxLen)) { hit++; hits[i] = 1; }
      const fwd = hit / tp.length;
      if (fwd < minFwd) continue;
      // 역방향: 템플릿 범위 안의 도면 점이 템플릿 점 가까이에 있는가
      const hw = (Math.abs(a) * T.w + Math.abs(b) * T.h) * s / 2, hh = (Math.abs(c) * T.w + Math.abs(d) * T.h) * s / 2;
      const tx = new Float32Array(tp.length), ty = new Float32Array(tp.length);
      tp.forEach(([x, y], i) => { tx[i] = x; ty[i] = y; });
      const tg = pointGrid(tx, ty, new Uint8Array(tp.length), 2);
      const inside = grid.within(ox - hw - 0.5, oy - hh - 0.5, ox + hw + 0.5, oy + hh + 0.5).filter((i) => ls[i] <= maxLen);
      let ok = 0;
      for (const i of inside) if (tg.has(xs[i], ys[i], tol + 0.4, false)) ok++;
      const rev = inside.length ? ok / inside.length : 0;
      if (rev < minRev || fwd * rev < (T.minScore ?? minScore)) continue;
      found.push({
        id: T.id, label: T.label, kind: T.kind, rot: XFORM_NAMES[xi], scale: +s.toFixed(3),
        bb: [ox - hw, oy - hh, ox + hw, oy + hh], score: +(fwd * rev).toFixed(3), fwd: +fwd.toFixed(3), rev: +rev.toFixed(3),
        size: T.pts.length, _tp: tp, _hit: hits,
      });
    }
  }
  return suppress(found, target);
}

/** 겹치는 결과 정리: 점수가 높은 것(비슷하면 점이 많은 = 더 복잡한 기호) 먼저, 많이 겹치는 나머지는 버린다 */
function suppress(found, target) {
  found.sort((p, q) => q.score - p.score || q.size - p.size);
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const overlap = (k, f) => {
    const ix = Math.max(0, Math.min(k.bb[2], f.bb[2]) - Math.max(k.bb[0], f.bb[0]));
    const iy = Math.max(0, Math.min(k.bb[3], f.bb[3]) - Math.max(k.bb[1], f.bb[1]));
    return (ix * iy) / (Math.min(area(k.bb), area(f.bb)) || 1);
  };
  // f의 점 대부분이 k의 점 위에 있으면 f는 k의 일부 (예: 볼 밸브 몸체 반쪽이 다이어프램 구동기 모양에 맞는 경우)
  const gridOf = (f) => {
    if (!f._g) {
      const xs = new Float32Array(f._tp.length), ys = new Float32Array(f._tp.length);
      f._tp.forEach(([x, y], i) => { xs[i] = x; ys[i] = y; });
      f._g = pointGrid(xs, ys, new Uint8Array(xs.length), 2);
    }
    return f._g;
  };
  // 두 기호가 같은 자리에 맞았을 때: 큰 기호에만 있는 부분(작은 기호 점에서 1.6pt 넘게 떨어진 점)이
  // 도면에 실제로 그려져 있으면 큰 기호, 아니면 작은 기호 (예: 글로브 밸브 = 게이트 밸브 + 가운데 원)
  const better = (p, q) => {
    // 1) 두 기호 범위를 합친 곳의 도면 점을 누가 더 많이 설명하는가 (5% 넘게 차이 나면 그쪽)
    if (target) {
      const u = [Math.min(p.bb[0], q.bb[0]), Math.min(p.bb[1], q.bb[1]), Math.max(p.bb[2], q.bb[2]), Math.max(p.bb[3], q.bb[3])];
      const pts = target.grid.within(u[0] - 0.5, u[1] - 0.5, u[2] + 0.5, u[3] + 0.5);
      if (pts.length) {
        const gp = gridOf(p), gq = gridOf(q);
        let ep = 0, eq = 0;
        for (const i of pts) {
          if (gp.has(target.xs[i], target.ys[i], 1.6, false)) ep++;
          if (gq.has(target.xs[i], target.ys[i], 1.6, false)) eq++;
        }
        if (Math.abs(ep - eq) > 0.05 * pts.length) return ep > eq ? p : q;
      }
    }
    const [big, small] = p.size >= q.size ? [p, q] : [q, p];
    const sx = new Float32Array(small._tp.length), sy = new Float32Array(small._tp.length);
    small._tp.forEach(([x, y], i) => { sx[i] = x; sy[i] = y; });
    const g = pointGrid(sx, sy, new Uint8Array(sx.length), 2);
    let extra = 0, ok = 0;
    big._tp.forEach(([x, y], i) => { if (!g.has(x, y, 1.6, false)) { extra++; ok += big._hit[i]; } });
    if (extra < 6) return p.score !== q.score ? (p.score > q.score ? p : q) : big;
    // 큰 기호에만 있는 부분이 그려져 있고, 자기 범위 안의 도면도 작은 기호만큼 깔끔하게 설명할 때만 큰 기호
    // (예: 볼 밸브 반쪽 + 지나가는 점선이 다이어프램 구동기 모양에 맞아도, 그 범위의 사다리꼴 선을 설명하지 못한다)
    return ok / extra >= 0.85 && big.rev >= small.rev - 0.05 ? big : small;
  };
  const touch = (k, f) => !(k.bb[0] > f.bb[2] || f.bb[0] > k.bb[2] || k.bb[1] > f.bb[3] || f.bb[1] > k.bb[3]);
  const covered = (f, k) => {
    const g = gridOf(k);
    let n = 0;
    for (const [x, y] of f._tp) if (g.has(x, y, 1.6, false)) n++;
    return n / f._tp.length;
  };
  let keep = [];
  for (const f of found) {
    const clash = keep.filter((k) => touch(k, f) && (overlap(k, f) > 0.5 || covered(f, k) >= 0.6 || covered(k, f) >= 0.6));
    if (!clash.length) { keep.push(f); continue; }
    // 겹치는 기존 결과를 모두 이겨야 대신 들어간다
    if (clash.every((k) => better(k, f) === f)) keep = keep.filter((k) => !clash.includes(k)).concat(f);
  }
  // 계기 쪽 기호(구동기 등)의 점이 옆 밸브 기호의 선을 상당 부분 빌려 쓰고 있으면 밸브의 일부다
  // (예: 닫힌 볼 밸브의 원 반쪽 + 배관 토막이 다이어프램 구동기 모양에 맞는 경우. 진짜 구동기는 밸브 위에 따로 그려진다)
  const valves = keep.filter((k) => k.kind === 'valve');
  keep = keep.filter((f) => f.kind !== 'instrument' || !valves.some((v) => touch(v, f) && covered(f, v) >= 0.25));
  return keep.map(({ _tp, _hit, _g, ...r }) => r);
}

/**
 * 범례 시트의 도형을 기호 단위로 묶는다: 가까이 붙은(gap pt 이내) 도형끼리 한 묶음.
 * 표 테두리 같은 긴 선(maxLen 초과)은 뺀다.
 */
export function clusterPrims(prims, { gap = 2.5, maxLen = 70, region } = {}) {
  const items = prims.map((p, i) => ({ p, i })).filter(({ p }) => diag(p.bb) <= maxLen && (!region || (p.bb[0] >= region[0] && p.bb[2] <= region[2] && p.bb[1] >= region[1] && p.bb[3] <= region[3])));
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = 20;
  const grid = new Map();
  items.forEach(({ p }, i) => {
    for (let gx = Math.floor((p.bb[0] - gap) / cell); gx <= Math.floor((p.bb[2] + gap) / cell); gx++) {
      for (let gy = Math.floor((p.bb[1] - gap) / cell); gy <= Math.floor((p.bb[3] + gap) / cell); gy++) {
        const k = gx * 100003 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  const near = (a, b) => {
    // 도형 사이 최소 거리(점-선분)가 gap 이내
    for (let i = 0; i < a.pts.length; i++) {
      for (let j = 1; j < b.pts.length; j++) if (psd(a.pts[i], b.pts[j - 1], b.pts[j]) <= gap) return true;
    }
    for (let i = 0; i < b.pts.length; i++) {
      for (let j = 1; j < a.pts.length; j++) if (psd(b.pts[i], a.pts[j - 1], a.pts[j]) <= gap) return true;
    }
    return false;
  };
  for (const ids of grid.values()) {
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const i = ids[x], j = ids[y];
        if (find(i) === find(j)) continue;
        const a = items[i].p.bb, b = items[j].p.bb;
        if (a[0] > b[2] + gap || b[0] > a[2] + gap || a[1] > b[3] + gap || b[1] > a[3] + gap) continue;
        if (near(items[i].p, items[j].p)) parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it.i); });
  return [...groups.values()].map((ids) => {
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const i of ids) { const b = prims[i].bb; bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
    return { ids, bb };
  });
}
function psd(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
