// PFD 스트림 번호 표식(마름모, 예: 윗줄 "1114" 아랫줄 "001" = Stream 1114-001)을 PDF 벡터에서 찾아
// 번호 있는 스트림 위치를 그 마름모에 정확히 맞춘다. (판독 결과의 위치는 그림을 보고 짐작한 값이라 조금씩 어긋난다)
//
// 사용: node scripts/session/snap-streams.mjs <result.json> <PDF 폴더(원래 파일명)> [출력 result.json]
//   - 시트마다 마름모(꼭짓점 4개가 위·오른쪽·아래·왼쪽, 폭≈높이, 8~40pt)를 찾는다.
//   - 같은 시트의 번호 있는 스트림 중 판독 위치가 15pt 안에 있는 가장 가까운 마름모에 붙이고 loc.source = 'symbol'
//   - 스트림이 붙지 않은 마름모는 목록으로 알려 준다(설비 안 기호일 수 있음)
import fs from 'fs';
import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPrimitives } from '../../shared/pidSymbols.js';

const [resPath, pdfDir, outPath = resPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resPath, 'utf8'));

/** 마름모 표식 (정규화 bbox) */
export function findDiamonds(prims, W, H) {
  const out = [];
  for (const p of prims) {
    const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1];
    if (w < 8 || w > 40 || Math.abs(w - h) > 0.25 * w) continue;
    let v = p.pts.filter((q, i) => i === 0 || Math.hypot(q[0] - p.pts[i - 1][0], q[1] - p.pts[i - 1][1]) > 0.3);
    if (v.length > 1 && Math.hypot(v[0][0] - v.at(-1)[0], v[0][1] - v.at(-1)[1]) < 0.5) v = v.slice(0, -1);
    if (v.length !== 4) continue;
    const cx = (p.bb[0] + p.bb[2]) / 2, cy = (p.bb[1] + p.bb[3]) / 2;
    const near = (a, b, s) => Math.abs(a - b) < 0.15 * s;
    const ok = v.every(([x, y]) => (near(x, cx, w) && (near(y, p.bb[1], h) || near(y, p.bb[3], h)))
      || (near(y, cy, h) && (near(x, p.bb[0], w) || near(x, p.bb[2], w))));
    if (ok) out.push([p.bb[0] / W, p.bb[1] / H, p.bb[2] / W, p.bb[3] / H].map((x) => +x.toFixed(5)));
  }
  return out;
}

const docs = new Map();
let snapped = 0, total = 0;
const stray = [];
for (const d of result.drawings.filter((x) => x.sheet_type !== 'legend' && x.sheet_type !== 'other')) {
  const f = result.files[d.file_index];
  const file = path.join(pdfDir, f.name);
  if (!fs.existsSync(file)) { console.warn('PDF 없음:', f.name); continue; }
  if (!docs.has(file)) {
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 });
    docs.set(file, { task, doc: await task.promise });
  }
  const page = await docs.get(file).doc.getPage(d.page || 1);
  const { W, H, prims } = await extractPrimitives(page, pdfjs.OPS, pdfjs.Util);
  const diamonds = findDiamonds(prims, W, H);
  const lines = result.lines.filter((l) => l.line_no && l.loc?.file_index === d.file_index && (l.loc.page || 1) === (d.page || 1) && l.loc.bbox);
  total += lines.length;
  const center = (b) => [((b[0] + b[2]) / 2) * W, ((b[1] + b[3]) / 2) * H];
  const used = new Set();
  // 가까운 짝부터 하나씩 (한 마름모 = 한 스트림)
  const pairs = [];
  for (const l of lines) for (const [k, b] of diamonds.entries()) {
    const [ax, ay] = center(l.loc.bbox), [bx, by] = center(b);
    const dist = Math.hypot(ax - bx, ay - by);
    if (dist < 15) pairs.push([dist, l, k]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const done = new Set();
  for (const [, l, k] of pairs) {
    if (done.has(l.id) || used.has(k)) continue;
    l.loc = { ...l.loc, bbox: diamonds[k], source: 'symbol' };
    done.add(l.id); used.add(k); snapped++;
  }
  diamonds.forEach((b, k) => { if (!used.has(k)) stray.push(`${d.drawing_no || `p${d.page}`} [${b.join(', ')}]`); });
}
for (const { task } of docs.values()) await task.destroy();
fs.writeFileSync(outPath, JSON.stringify(result));
console.log(`스트림 ${total}개 중 ${snapped}개를 마름모 표식에 맞춤`);
if (stray.length) console.log(`스트림이 붙지 않은 마름모 ${stray.length}개:\n  ${stray.join('\n  ')}`);
