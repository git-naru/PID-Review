// PDF 도면의 선(벡터) 추출과 라인 경로 추적 (브라우저·Node 공용).
// 좌표는 페이지 기준 정규화 값(0~1, 좌상단 원점)이다. pdf.js(OPS, Util)는 호출하는 쪽에서 넣는다.
//
// 추적 방식: Line No. 글자 가까이 지나는 선분에서 시작해, 이어진 선을 모두 따라간다.
// 갈림길·T자 연결(다른 선의 중간에 닿음)도 건너가며, 다른 스트림의 Line No. 표식과 설비 기호(닫힌 도형·곡선)에서 멈춘다.
// 너무 넓게 퍼지면(도면 전체 배관망 등) 갈림길에서 멈추는 한 줄 추적으로 대신한다.
// 화살촉(작은 채운 다각형)이 경로에 닿아 있으면 함께 돌려준다.
// 점선은 짧은 선분(대시)들이 같은 방향으로 늘어선 것이라, 끊긴 틈을 건너 같은 방향의 다음 대시로 이어 간다.

const MOVE = 0, LINE = 1, CURVE = 2, QUAD = 3, CLOSE = 4;

/**
 * @returns {Promise<{segs: Array<{a:number[], b:number[], dashed:boolean}>, fills: Array<number[][]>}>}
 */
export async function extractGeometry(page, OPS, Util) {
  // 화면 그리기와 같은 연산 목록을 공유하면 경로 데이터가 Path2D로 바뀌어 있을 수 있어 별도 intent로 받는다
  const list = await page.getOperatorList({ intent: 'print' });
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  let ctm = [1, 0, 0, 1, 0, 0];
  let dashed = false, lw = 1, color = '';
  const stack = [];
  const segs = [], fills = [];
  const pt = (x, y) => {
    const m = Util.transform(vp.transform, ctm);
    return [(x * m[0] + y * m[2] + m[4]) / W, (x * m[1] + y * m[3] + m[5]) / H];
  };
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, dashed, lw, color]);
    else if (fn === OPS.restore) [ctm, dashed, lw, color] = stack.pop() || [ctm, dashed, lw, color];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, dashed, lw, color]); if (args[0]) ctm = Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) [ctm, dashed, lw, color] = stack.pop() || [ctm, dashed, lw, color];
    else if (fn === OPS.setDash) dashed = Array.isArray(args[0]) ? args[0].length > 0 : !!args[0]?.length;
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeColor) color = String(args[0] ?? args);
    else if (fn === OPS.constructPath) {
      const [op, data] = args;
      const d = data?.[0];
      if (!d || typeof d.length !== 'number') continue;
      // 채운 도형(화살촉·기호)은 선 추적에서 빼고 따로 모은다
      const stroke = op === OPS.stroke || op === OPS.closeStroke;
      const fill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op);
      if (!stroke && !fill) continue;
      // 하위 경로별 점 목록 (곡선은 끝점만)
      // shape: 닫힌 도형이나 곡선이 섞인 하위 경로 (설비·계기 기호) → 배관 추적에서 건너가지 않는다
      const subs = [];
      let cur = null, start = null;
      for (let k = 0; k < d.length;) {
        const c = d[k++];
        if (c === MOVE) { start = pt(d[k++], d[k++]); cur = [start]; cur.shape = false; subs.push(cur); }
        else if (c === LINE) cur?.push(pt(d[k++], d[k++]));
        else if (c === CURVE) { k += 4; if (cur) { cur.push(pt(d[k++], d[k++])); cur.shape = true; } else k += 2; }
        else if (c === QUAD) { k += 2; if (cur) { cur.push(pt(d[k++], d[k++])); cur.shape = true; } else k += 2; }
        else if (c === CLOSE) { if (cur && start) { cur.push(start); cur.shape = true; } }
        else break;
      }
      for (const s of subs) {
        // 선 굵기(화면 기준)와 색: 같은 종류의 배관선만 이어 가는 데 쓴다
        const w = lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
        if (stroke) for (let k = 1; k < s.length; k++) segs.push({ a: s[k - 1], b: s[k], dashed, shape: s.shape, w, color });
        if (fill && s.length >= 3 && s.length <= 8) fills.push(s);
      }
    }
  }
  return { segs, fills };
}

const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
function pointSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.sqrt(dist2(p, [a[0] + t * dx, a[1] + t * dy]));
}
const segLen = (s) => Math.sqrt(dist2(s.a, s.b));
const dir = (p, q) => { const l = Math.sqrt(dist2(p, q)) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };

/** 끝점 검색용 격자 */
function buildIndex(segs, cell) {
  const map = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  segs.forEach((s, i) => {
    for (const end of [0, 1]) {
      const p = end ? s.b : s.a;
      const k = key(p[0], p[1]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ i, end });
    }
  });
  return {
    near(p, tol) {
      const out = [];
      const r = Math.ceil(tol / cell);
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
      for (let x = cx - r; x <= cx + r; x++) {
        for (let y = cy - r; y <= cy + r; y++) {
          for (const e of map.get(`${x},${y}`) || []) {
            const s = segs[e.i];
            if (dist2(e.end ? s.b : s.a, p) <= tol * tol) out.push(e);
          }
        }
      }
      return out;
    },
  };
}

/**
 * Line No. 글자 위치(bbox)에서 시작해 그 라인의 선 경로를 찾는다.
 * @returns {{segs: number[][], arrows: number[][][]} | null}  segs: [x1,y1,x2,y2]
 */
export function traceLine(geom, bbox, opts = {}) {
  if (!geom?.segs.length || !bbox) return null;
  const eps = opts.eps ?? 0.0012;
  geom.index ||= buildIndex(geom.segs, 0.004);
  const { segs } = geom;
  const c = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
  const textH = Math.min(bw, bh) || 0.004;
  const pad = Math.max(textH, (bw + bh) * 0.25);
  const inLabel = (p) => p[0] >= bbox[0] - pad && p[0] <= bbox[2] + pad && p[1] >= bbox[1] - pad && p[1] <= bbox[3] + pad;
  const horizontalText = bw >= bh;

  // 1) 시작 선분: 글자 가까이 지나고, 글자 표식(타원·마름모) 자체가 아닌 것
  let seed = -1, best = Infinity;
  // 라인 번호는 선 위에 있거나(PFD 표식) 선과 나란히 조금 떨어져 적힌다(P&ID)
  const maxD = Math.max(textH * 3.5, 0.008);
  // 같은 방향으로 바로 앞에 이어지는 대시가 있는지 (점선 판별)
  const dashRun = (s) => {
    const d = dir(s.a, s.b), L = segLen(s);
    return [s.a, s.b].some((p) => geom.index.near(p, Math.max(L * 2, 0.004)).some((e) => {
      const t = segs[e.i];
      if (t === s) return false;
      const dt = dir(t.a, t.b);
      return Math.abs(dt[0] * d[0] + dt[1] * d[1]) > 0.97 && pointSegDist(e.end ? t.b : t.a, s.a.map((v, k) => v - d[k] * 10), s.b.map((v, k) => v + d[k] * 10)) < 0.0008;
    }));
  };
  const pick = (minLen, needRun) => segs.forEach((s, i) => {
    const L = segLen(s);
    if (L < minLen) return;
    if (inLabel(s.a) && inLabel(s.b)) return;
    const dd = pointSegDist(c, s.a, s.b);
    if (dd > maxD) return;
    const d = dir(s.a, s.b);
    const parallel = horizontalText ? Math.abs(d[0]) > 0.9 : Math.abs(d[1]) > 0.9;
    if (!parallel && dd > textH * 1.2) return;
    if (needRun && !dashRun(s)) return;
    const score = dd - (parallel ? textH * 0.8 : 0);
    if (score < best) { best = score; seed = i; }
  });
  pick(textH * 1.5, false);
  if (seed < 0) pick(textH * 0.3, true); // 점선: 대시 하나가 글자보다 짧다
  if (seed < 0) return null;

  // 2) 이어진 선 모두 따라가기 (갈림길·T자 포함), 넓게 퍼지면 한 줄 추적으로
  let used = flood(geom, seed, { eps, inLabel, bw, bh, stops: opts.stops || [] });
  if (!used) {
    used = new Set([seed]);
    linearWalk(geom, used, seed, { eps, inLabel, bw, bh });
  }
  const path = [...used].map((i) => segs[i]);
  return finish(geom, path, bbox);
}

/** 끝점이 한 선분과만 이어지는 동안 양쪽으로 (갈림길에서 멈춤) */
function linearWalk(geom, used, seed, { eps, inLabel, bw, bh }) {
  const { segs } = geom;
  const walk = (i, end) => {
    for (let steps = 0; steps < 600; steps++) {
      const s = segs[i];
      const p = end ? s.b : s.a, q = end ? s.a : s.b;
      let next = geom.index.near(p, eps).filter((e) => e.i !== i && !used.has(e.i));
      if (!next.length) {
        // 선이 끊긴 곳(라인 표식, 교차 회피): 같은 방향으로 이어지는 선분을 조금 더 멀리서 찾는다
        const d = dir(q, p);
        const gap = inLabel(p) ? Math.max(bw, bh) * 1.4 : 0.006;
        const cand = geom.index.near(p, gap).filter((e) => {
          if (e.i === i || used.has(e.i)) return false;
          const t = segs[e.i];
          const from = e.end ? t.b : t.a, to = e.end ? t.a : t.b;
          const dd = dir(from, to);
          const toward = dir(p, from);
          return dd[0] * d[0] + dd[1] * d[1] > 0.97 && (dist2(p, from) < eps * eps || toward[0] * d[0] + toward[1] * d[1] > 0.97);
        });
        if (cand.length !== 1) {
          // 점선이 꺾이는 모서리: 아주 가까이 다른 방향 대시가 하나만 있으면 이어 간다
          const corner = geom.index.near(p, Math.max(segLen(s), 0.003)).filter((e) => e.i !== i && !used.has(e.i));
          if (cand.length || corner.length !== 1 || segLen(s) > 0.012) return;
          next = corner;
        } else next = cand;
      }
      if (next.length !== 1) return; // 갈림길
      used.add(next[0].i);
      i = next[0].i;
      end = next[0].end ? 0 : 1; // 들어온 반대쪽 끝으로 진행
    }
  };
  walk(seed, 1);
  walk(seed, 0);
}

/** 선분이 지나는 격자 칸 (T자 연결 검색용) */
function segGrid(geom) {
  if (geom.grid) return geom.grid;
  const cell = 0.01, map = new Map();
  geom.segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return; // 도면 테두리 같은 아주 긴 선
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    }
  });
  geom.grid = { cell, map };
  return geom.grid;
}

const MAX_FLOOD = 500;

/** 화살촉(작은 채운 삼각형) 목록과 격자 */
function arrowIndex(geom) {
  if (geom.tris) return geom.tris;
  const cell = 0.01, map = new Map(), list = [];
  for (const poly of geom.fills) {
    const pts = poly.filter((p, k) => poly.findIndex((q) => dist2(p, q) < 1e-10) === k);
    if (pts.length !== 3) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) > 0.012 || Math.max(...ys) - Math.min(...ys) > 0.012) continue;
    const k = `${Math.floor((xs[0] + xs[1] + xs[2]) / 3 / cell)},${Math.floor((ys[0] + ys[1] + ys[2]) / 3 / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(list.length);
    list.push(pts);
  }
  geom.tris = { cell, map, list };
  return geom.tris;
}

/** 이 점에 화살촉이 있는지 (선 끝이 화살 머리에 닿음) */
function arrowAt(geom, p) {
  const { cell, map, list } = arrowIndex(geom);
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    for (const t of map.get(`${x},${y}`) || []) if (traceDistance({ segs: [], arrows: [list[t]] }, p) < 0.0015) return true;
  }
  return false;
}

/**
 * 이어진 배관선 전체 = 하나의 스트림.
 * - 스트림은 최소한 화살 머리까지 이어지고, 화살 머리에서 다시 이어지는 선이 있으면 같은 스트림으로 계속 간다
 * - 교차(양쪽으로 지나가는 선)는 끊지 않고 직진, 다른 선에 T자로 합류·분기하면 그 선으로 이어 간다
 * - 다른 스트림의 Line No. 표식, 설비 기호, 색·선 모양이 다른 선에서 멈춘다
 *   (굵기만 다른 가지는 끝에 화살 머리가 있으면 배관으로 보고 이어 간다)
 */
function flood(geom, seed, { eps, inLabel, bw, bh, stops }) {
  const { segs } = geom;
  const grid = segGrid(geom);
  const s0 = segs[seed];
  const dashLen = segLen(s0) < 0.012 ? segLen(s0) : 0;
  const sameKind = (t) => Math.abs((t.w ?? 1) - (s0.w ?? 1)) <= Math.max(0.05 * (s0.w ?? 1), 1e-6) && (t.color ?? '') === (s0.color ?? '')
    && (!dashLen || (segLen(t) > dashLen * 0.5 && segLen(t) < dashLen * 2));
  const blocked = (s) => s.shape || !sameKind(s) || stops.some((b) => {
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.3;
    return [s.a, s.b, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]].some((p) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad);
  });
  const ortho = (s) => { const d = dir(s.a, s.b); return Math.abs(d[0]) > 0.995 || Math.abs(d[1]) > 0.995; };
  const away = (t, p) => (dist2(t.a, p) < dist2(t.b, p) ? dir(t.a, t.b) : dir(t.b, t.a)); // p에서 멀어지는 방향
  const cross = (u, w) => u[0] * w[1] - u[1] * w[0];
  const used = new Set([seed]);
  const queue = [seed];
  // 굵기만 다른 가지(예: 굵은 주 배관에서 갈라지는 가는 배관)는 끝에 화살 머리가 있으면 같은 흐름으로 본다
  const looseBlocked = (t) => t.shape || (t.color ?? '') !== (s0.color ?? '') || !ortho(t) || (dashLen && !(segLen(t) > dashLen * 0.5 && segLen(t) < dashLen * 2)) || blocked({ ...t, w: s0.w, color: s0.color });
  const tried = new Set();
  const tryBranch = (j) => {
    if (tried.has(j)) return;
    tried.add(j);
    const w = segs[j].w ?? 1;
    const set = new Set([j]), q = [j];
    let arrow = false;
    while (q.length && set.size <= 150) {
      const k = q.shift();
      const t = segs[k];
      for (const p of [t.a, t.b]) {
        const nb = geom.index.near(p, eps).map((e) => e.i).filter((m) => m !== k);
        const same = nb.filter((m) => !used.has(m) && Math.abs((segs[m].w ?? 1) - w) <= Math.max(0.05 * w, 1e-6) && !looseBlocked(segs[m]));
        same.forEach((m) => { if (!set.has(m)) { set.add(m); q.push(m); } });
        if (!nb.length && arrowAt(geom, p)) arrow = true;
      }
    }
    if (!arrow || set.size > 150) return;
    for (const m of set) { tried.add(m); if (!used.has(m)) { used.add(m); queue.push(m); } }
  };
  const add = (i) => {
    if (used.has(i)) return false;
    if (!blocked(segs[i])) { used.add(i); queue.push(i); return true; }
    if (!looseBlocked(segs[i])) tryBranch(i);
    return false;
  };
  const cellsOf = (s) => {
    const out = [];
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / grid.cell), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / grid.cell);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / grid.cell), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / grid.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(...(grid.map.get(`${x},${y}`) || []));
    return [...new Set(out)];
  };
  while (queue.length) {
    if (used.size > MAX_FLOOD) return null;
    const i = queue.shift();
    const s = segs[i];
    for (const [p, q] of [[s.b, s.a], [s.a, s.b]]) {
      const d = dir(q, p); // 이 끝에서 바깥쪽 방향
      const shared = geom.index.near(p, eps).filter((e) => e.i !== i).map((e) => e.i);
      const straight = shared.filter((j) => { const w = away(segs[j], p); return w[0] * d[0] + w[1] * d[1] > 0.97; });
      const left = shared.filter((j) => cross(d, away(segs[j], p)) > 0.5), right = shared.filter((j) => cross(d, away(segs[j], p)) < -0.5);
      if (straight.length && left.length && right.length) straight.forEach(add); // 교차: 직진만
      else shared.forEach(add);
      // T자 합류: 이 끝점이 다른 배관선의 중간에 닿음 → 그 선으로 이어 간다
      let touched = false;
      const cx = Math.floor(p[0] / grid.cell), cy = Math.floor(p[1] / grid.cell);
      for (const j of grid.map.get(`${cx},${cy}`) || []) {
        if (j === i) continue;
        const t = segs[j];
        if (t.shape || !ortho(t) || segLen(t) < 0.004) continue;
        if (pointSegDist(p, t.a, t.b) < eps && dist2(p, t.a) > eps * eps && dist2(p, t.b) > eps * eps) { touched = true; add(j); }
      }
      if (shared.length || touched) continue;
      // 끝난 곳: 점선 틈·라인 표식·교차 회피 틈을 같은 방향으로 건너기 (다른 선이 가로지르는 틈은 더 멀리까지)
      const gap = inLabel(p) ? Math.max(bw, bh) * 1.4 : 0.015;
      geom.index.near(p, gap).forEach((e) => {
        if (e.i === i) return;
        const t = segs[e.i];
        const from = e.end ? t.b : t.a, to = e.end ? t.a : t.b;
        const dd = dir(from, to), toward = dir(p, from);
        if (dd[0] * d[0] + dd[1] * d[1] <= 0.97 || toward[0] * d[0] + toward[1] * d[1] <= 0.97) return;
        if (pointSegDist(from, p, [p[0] + d[0], p[1] + d[1]]) > eps) return; // 같은 직선 위
        const far = Math.sqrt(dist2(p, from));
        if (far > 0.006 && !inLabel(p)) {
          // 먼 틈은 그 사이를 다른 선이 가로지를 때만 (교차 회피로 끊어 그린 곳)
          const mid = [(p[0] + from[0]) / 2, (p[1] + from[1]) / 2];
          const crossing = cellsOf({ a: p, b: from }).some((j) => j !== i && j !== e.i && !segs[j].shape && pointSegDist(mid, segs[j].a, segs[j].b) < far / 2 + eps);
          if (!crossing) return;
        }
        add(e.i);
      });
      // 점선이 꺾이는 모서리
      if (segLen(s) <= 0.012) geom.index.near(p, Math.max(segLen(s), 0.003)).forEach((e) => { if (e.i !== i && ortho(segs[e.i])) add(e.i); });
    }
    // 이 선분의 중간에 닿는 가지: 한쪽에서만 닿으면 가지(화살촉으로 들어오는 다른 흐름은 제외), 양쪽이면 교차라 건너지 않음
    if (ortho(s) && segLen(s) >= 0.004) {
      const touches = [];
      for (const j of cellsOf(s)) {
        if (j === i || used.has(j)) continue;
        const t = segs[j];
        if (t.shape || !ortho(t) || segLen(t) < 0.004) continue;
        for (const p of [t.a, t.b]) {
          if (pointSegDist(p, s.a, s.b) < eps && dist2(p, s.a) > eps * eps && dist2(p, s.b) > eps * eps) { touches.push({ j, p }); break; }
        }
      }
      const ds = dir(s.a, s.b);
      for (const { j, p } of touches) {
        const side = Math.sign(cross(ds, away(segs[j], p)));
        const opposite = touches.some((o) => o.j !== j && dist2(o.p, p) < eps * eps * 4 && Math.sign(cross(ds, away(segs[o.j], o.p))) === -side);
        if (opposite) continue;
        add(j);
      }
    }
  }
  return used;
}

/** 경로 끝에 닿은 화살촉을 붙여 결과로 */
function finish(geom, path, bbox) {
  // 3) 경로 끝에 닿은 화살촉
  // 삼각형 모양의 작은 채운 도형 중, 무게중심이 경로 위에 있는 것 (Line No. 표식 도형은 제외)
  const arrows = geom.fills.map((poly) => poly.filter((p, k) => poly.findIndex((q) => dist2(p, q) < 1e-10) === k)).filter((pts) => {
    if (pts.length !== 3) return false;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (x1 - x0 > 0.012 || y1 - y0 > 0.012) return false;
    if (bbox && x1 >= bbox[0] && x0 <= bbox[2] && y1 >= bbox[1] && y0 <= bbox[3]) return false;
    const m = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3];
    if (path.some((s) => pointSegDist(m, s.a, s.b) < 0.0015)) return true;
    // 선 끝이 화살촉에 닿아 있음 (끝점이 삼각형 안이거나 변에 가까움)
    const tri = { segs: [], arrows: [pts] };
    return path.some((s) => traceDistance(tri, s.a) < 0.0015 || traceDistance(tri, s.b) < 0.0015);
  });
  return { segs: path.map((s) => [s.a[0], s.a[1], s.b[0], s.b[1], s.dashed ? 1 : 0]), arrows };
}

/** 점 p 가까이(tol 이내) 있는 배관선 선분 (기호 도형·도면 테두리 제외). 없으면 -1 */
export function nearestSegment(geom, p, tol) {
  if (!geom?.segs.length) return -1;
  const grid = segGrid(geom);
  const r = Math.ceil(tol / grid.cell);
  const cx = Math.floor(p[0] / grid.cell), cy = Math.floor(p[1] / grid.cell);
  let best = -1, bestD = tol;
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
    for (const j of grid.map.get(`${x},${y}`) || []) {
      const t = geom.segs[j];
      if (t.shape) continue;
      const d = pointSegDist(p, t.a, t.b);
      if (d < bestD) { bestD = d; best = j; }
    }
  }
  return best;
}

/** Line No. 없이 선분 하나에서 시작해 이어진 경로 (도면에서 선을 직접 고를 때) */
export function traceFromSegment(geom, seed, opts = {}) {
  const eps = opts.eps ?? 0.0012;
  geom.index ||= buildIndex(geom.segs, 0.004);
  const ctx = { eps, inLabel: () => false, bw: 0, bh: 0 };
  let used = flood(geom, seed, { ...ctx, stops: opts.stops || [] });
  if (!used) {
    used = new Set([seed]);
    linearWalk(geom, used, seed, ctx);
  }
  return finish(geom, [...used].map((i) => geom.segs[i]), null);
}

/** 점 p(정규화 좌표)에서 추적한 경로(선·화살촉)까지의 거리 */
export function traceDistance(trace, p) {
  if (!trace) return Infinity;
  let d = Infinity;
  for (const s of trace.segs) d = Math.min(d, pointSegDist(p, [s[0], s[1]], [s[2], s[3]]));
  for (const a of trace.arrows) {
    // 삼각형 안이면 0
    const [p0, p1, p2] = a;
    const sign = (u, v, w) => (u[0] - w[0]) * (v[1] - w[1]) - (v[0] - w[0]) * (u[1] - w[1]);
    const d1 = sign(p, p0, p1), d2 = sign(p, p1, p2), d3 = sign(p, p2, p0);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
    for (let k = 0; k < a.length; k++) d = Math.min(d, pointSegDist(p, a[k], a[(k + 1) % a.length]));
  }
  return d;
}

/**
 * 도면 범례(SYMBOLS)의 "MAIN FLOW" 견본 선과 같은 굵기·색으로 그려진 선 = 주 흐름(Main Stream).
 * label: 범례 글자의 위치 {x, y, h} (정규화, y는 글자 기준선). 견본을 못 찾으면 [] (짐작하지 않는다)
 */
export function mainFlowSegments(geom, label) {
  if (!geom?.segs.length || !label) return [];
  const yMid = label.y - label.h / 2;
  const sample = geom.segs
    .filter((s) => !s.shape && Math.abs(s.a[1] - s.b[1]) < 1e-6 && Math.abs(s.a[1] - yMid) < 0.008
      && Math.max(s.a[0], s.b[0]) <= label.x + 0.002 && Math.max(s.a[0], s.b[0]) > label.x - 0.08)
    .sort((a, b) => segLen(b) - segLen(a))[0];
  if (!sample) return [];
  const w = sample.w ?? 1;
  return geom.segs.filter((s) => !s.shape && !s.dashed && Math.abs((s.w ?? 1) - w) <= Math.max(0.05 * w, 1e-6) && (s.color ?? '') === (sample.color ?? ''))
    .map((s) => [s.a[0], s.a[1], s.b[0], s.b[1]]);
}
