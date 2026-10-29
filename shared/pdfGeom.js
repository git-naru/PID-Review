// PDF 도면의 선(벡터) 추출과 라인 경로 추적 (브라우저·Node 공용).
// 좌표는 페이지 기준 정규화 값(0~1, 좌상단 원점)이다. pdf.js(OPS, Util)는 호출하는 쪽에서 넣는다.
//
// 추적 방식: Line No. 글자 가까이 지나는 선분에서 시작해, 끝점이 한 선분과만 이어지는 동안 양쪽으로 따라간다.
// 갈림길(끝점에 선분 2개 이상), 다른 선의 중간에 닿는 T자 연결, 설비 외곽선에서 멈춘다.
// 화살촉(작은 채운 다각형)이 경로에 닿아 있으면 함께 돌려준다.

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
  let dashed = false;
  const stack = [];
  const segs = [], fills = [];
  const pt = (x, y) => {
    const m = Util.transform(vp.transform, ctm);
    return [(x * m[0] + y * m[2] + m[4]) / W, (x * m[1] + y * m[3] + m[5]) / H];
  };
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, dashed]);
    else if (fn === OPS.restore) [ctm, dashed] = stack.pop() || [ctm, dashed];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, dashed]); if (args[0]) ctm = Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) [ctm, dashed] = stack.pop() || [ctm, dashed];
    else if (fn === OPS.setDash) dashed = Array.isArray(args[0]) ? args[0].length > 0 : !!args[0]?.length;
    else if (fn === OPS.constructPath) {
      const [op, data] = args;
      const d = data?.[0];
      if (!d || typeof d.length !== 'number') continue;
      // 채운 도형(화살촉·기호)은 선 추적에서 빼고 따로 모은다
      const stroke = op === OPS.stroke || op === OPS.closeStroke;
      const fill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op);
      if (!stroke && !fill) continue;
      // 하위 경로별 점 목록 (곡선은 끝점만)
      const subs = [];
      let cur = null, start = null;
      for (let k = 0; k < d.length;) {
        const c = d[k++];
        if (c === MOVE) { start = pt(d[k++], d[k++]); cur = [start]; subs.push(cur); }
        else if (c === LINE) cur?.push(pt(d[k++], d[k++]));
        else if (c === CURVE) { k += 4; cur?.push(pt(d[k++], d[k++])); }
        else if (c === QUAD) { k += 2; cur?.push(pt(d[k++], d[k++])); }
        else if (c === CLOSE) { if (cur && start) cur.push(start); }
        else break;
      }
      for (const s of subs) {
        if (stroke) for (let k = 1; k < s.length; k++) segs.push({ a: s[k - 1], b: s[k], dashed });
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
    if (s.dashed) return;
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
  segs.forEach((s, i) => {
    if (s.dashed) return;
    const L = segLen(s);
    if (L < textH * 1.5) return;
    if (inLabel(s.a) && inLabel(s.b)) return;
    const dd = pointSegDist(c, s.a, s.b);
    if (dd > maxD) return;
    const d = dir(s.a, s.b);
    const parallel = horizontalText ? Math.abs(d[0]) > 0.9 : Math.abs(d[1]) > 0.9;
    if (!parallel && dd > textH * 1.2) return;
    const score = dd - (parallel ? textH * 0.8 : 0);
    if (score < best) { best = score; seed = i; }
  });
  if (seed < 0) return null;

  // 2) 양쪽으로 따라가기
  const used = new Set([seed]);
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
        if (cand.length !== 1) return;
        next = cand;
      }
      if (next.length !== 1) return; // 갈림길
      used.add(next[0].i);
      i = next[0].i;
      end = next[0].end ? 0 : 1; // 들어온 반대쪽 끝으로 진행
    }
  };
  walk(seed, 1);
  walk(seed, 0);
  const path = [...used].map((i) => segs[i]);

  // 3) 경로 끝에 닿은 화살촉
  // 삼각형 모양의 작은 채운 도형 중, 무게중심이 경로 위에 있는 것 (Line No. 표식 도형은 제외)
  const arrows = geom.fills.filter((poly) => {
    const pts = poly.filter((p, k) => poly.findIndex((q) => dist2(p, q) < 1e-10) === k);
    if (pts.length !== 3) return false;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (x1 - x0 > 0.012 || y1 - y0 > 0.012) return false;
    if (x1 >= bbox[0] && x0 <= bbox[2] && y1 >= bbox[1] && y0 <= bbox[3]) return false;
    const m = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3];
    return path.some((s) => pointSegDist(m, s.a, s.b) < 0.0015) || pts.some((p) => path.some((s) => dist2(p, s.a) < 4e-6 || dist2(p, s.b) < 4e-6));
  });
  return { segs: path.map((s) => [s.a[0], s.a[1], s.b[0], s.b[1]]), arrows };
}
