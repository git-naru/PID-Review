// 범례 시트에서 기호 모양을 배워 기호 사전(템플릿 목록)을 만든다.
//
// 사용: node scripts/session/learn-symbols.mjs <설정.json> <OCR 폴더> <출력 library.json> <fi>:<pdf> [<fi>:<pdf> ...]
//   설정: scripts/session/legend-BL2U.json 참고
//     sheets.<fi>.sections: [{bb:[x0,y0,x1,y1] 0-1, kind, split_x?, variants?}]  설명 글자(OCR)를 오른쪽에 둔 기호 목록 구역
//     sheets.<fi>.manual:   [{bb, label, kind}]  표 칸·Typical처럼 설명이 옆에 없는 기호는 구역을 직접 지정
//     labels.<id>: {label?, kind?, skip?, scale?, rotate?, mirror?}  자동으로 읽은 이름 고치기·빼기
//   OCR 폴더: scripts/session/ocr-legend.py 결과 (f<fi>.json)
//   출력: [{id, label, kind, source:{file_index, bb}, w, h, anchor, pts, scale?}] — shared/pidSymbols.js detectSymbols에 그대로 넣는다
// --sheet <png 폴더>: 배운 기호마다 테두리와 id를 그린 확인용 그림(<fi>.svg)도 만든다
import fs from 'fs';
import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPrimitives, clusterPrims, makeTemplate } from '../../shared/pidSymbols.js';

const args = process.argv.slice(2);
let sheetDir = null;
const si = args.indexOf('--sheet');
if (si >= 0) { sheetDir = args[si + 1]; args.splice(si, 2); }
const [cfgPath, ocrDir, outPath, ...specs] = args;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const library = [];
const used = new Set();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'symbol';
const uniq = (base) => { let id = base, k = 2; while (used.has(id)) id = `${base}-${k++}`; used.add(id); return id; };

for (const spec of specs) {
  const [fiStr, pdf] = spec.split(/:(.+)/);
  const fi = Number(fiStr);
  const sc = cfg.sheets?.[fi];
  if (!sc) continue;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const { W, H, prims } = await extractPrimitives(page, pdfjs.OPS, pdfjs.Util);
  const ocr = JSON.parse(fs.readFileSync(path.join(ocrDir, `f${fi}.json`), 'utf8'));
  // 글자로 믿을 만한 OCR 단어 (기호를 글자로 잘못 읽은 것은 대개 신뢰도가 낮다)
  const words = ocr.words
    .filter((w) => (w.c >= 55 && /[A-Za-z0-9]/.test(w.t)) || (w.c >= 30 && /^[A-Z0-9][A-Z0-9.\/:()-]+$/.test(w.t)))
    .map((w) => ({ t: w.t, b: [w.b[0] * W, w.b[1] * H, w.b[2] * W, w.b[3] * H] }));
  // 글자 묶음: 글자 높이(약 7pt) 이하이고, 묶음 범위의 대부분이 OCR 단어 상자에 덮인다 (붙어 있는 여러 단어도)
  const isText = (c) => {
    const h = c.bb[3] - c.bb[1], w = c.bb[2] - c.bb[0];
    if (h > 9.5) return false;
    let cov = 0;
    for (const t of words) {
      if (t.b[3] - t.b[1] >= 10) continue;
      const ix = Math.min(c.bb[2], t.b[2] + 1.5) - Math.max(c.bb[0], t.b[0] - 1.5);
      const iy = Math.min(c.bb[3], t.b[3] + 1.5) - Math.max(c.bb[1], t.b[1] - 1.5);
      if (ix > 0 && iy > 0) cov += ix * iy;
    }
    return cov >= 0.6 * Math.max(w, 1) * Math.max(h, 1);
  };
  const px = (bb) => [bb[0] * W, bb[1] * H, bb[2] * W, bb[3] * H];
  const norm = (bb) => [bb[0] / W, bb[1] / H, bb[2] / W, bb[3] / H].map((v) => +v.toFixed(4));
  const add = (ids, label, kind, extra = {}) => {
    const ps = ids.map((i) => prims[i]);
    if (!ps.length) return;
    const t = makeTemplate(ps, {});
    const bb = [Math.min(...ps.map((p) => p.bb[0])), Math.min(...ps.map((p) => p.bb[1])), Math.max(...ps.map((p) => p.bb[2])), Math.max(...ps.map((p) => p.bb[3]))];
    const id = uniq(`f${fi}-${slug(label)}`);
    const o = cfg.labels?.[id] || {};
    if (o.skip) return;
    const k = o.kind || kind;
    library.push({ id, label: o.label || label, kind: k, source: { file_index: fi, bb: norm(bb) }, ...extra, ...(cfg.defaults?.[k] || {}), ...pick(o, ['scale', 'rotate', 'mirror', 'small', 'minScore']), w: t.w, h: t.h, anchor: t.anchor, pts: t.pts });
  };

  // 1) 설명 글자가 오른쪽에 있는 기호 목록
  for (const sec of sc.sections || []) {
    const R = px(sec.bb);
    const clusters = clusterPrims(prims, { gap: 2.5, maxLen: sec.maxLen || 80, region: R });
    const sym = clusters.filter((c) => !isText(c) && Math.max(c.bb[2] - c.bb[0], c.bb[3] - c.bb[1]) >= 3);
    // 설명 글자 줄 → 문단
    const ws = words.filter((w) => w.b[0] >= R[0] && w.b[2] <= R[2] && w.b[1] >= R[1] && w.b[3] <= R[3]).sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
    const lines = [];
    for (const w of ws) {
      const h = w.b[3] - w.b[1], cy = (w.b[1] + w.b[3]) / 2;
      const ln = lines.find((l) => Math.abs(l.cy - cy) < h * 0.5 && w.b[0] - l.b[2] < h * 3 && w.b[0] >= l.b[0] - 1);
      if (ln) { ln.t.push(w.t); ln.b[2] = Math.max(ln.b[2], w.b[2]); ln.b[1] = Math.min(ln.b[1], w.b[1]); ln.b[3] = Math.max(ln.b[3], w.b[3]); }
      else lines.push({ t: [w.t], b: [...w.b], cy, h });
    }
    const blocks = [];
    for (const l of lines.sort((a, b) => a.b[1] - b.b[1])) {
      const bl = blocks.find((k) => Math.abs(k.b[0] - l.b[0]) < 12 && l.b[1] - k.b[3] < l.h * 0.9 && l.b[1] >= k.b[1]);
      if (bl) { bl.t.push(...l.t); bl.b = [Math.min(bl.b[0], l.b[0]), bl.b[1], Math.max(bl.b[2], l.b[2]), Math.max(bl.b[3], l.b[3])]; }
      else blocks.push({ t: [...l.t], b: [...l.b], h: l.h, syms: [] });
    }
    // 기호마다 오른쪽 가장 가까운 설명 문단
    const note = (b) => /^(N\.?C\.?|N\.?O\.?)$/.test(b.t.join(''));
    for (const c of sym) {
      const cy = (c.bb[1] + c.bb[3]) / 2;
      let best = null, bs = Infinity;
      for (const b of blocks) {
        if (note(b)) continue; // 기호 밑의 N.C. 같은 주석은 설명이 아니다
        const dx = b.b[0] - c.bb[2];
        if (dx < -4 || dx > (sec.maxGap || 170)) continue;
        const dy = cy < b.b[1] ? b.b[1] - cy : cy > b.b[3] ? cy - b.b[3] : 0;
        if (dy > Math.max(18, (c.bb[3] - c.bb[1]) / 2)) continue;
        const s = dx + dy * 4;
        if (s < bs) { bs = s; best = b; }
      }
      if (best) best.syms.push(c);
    }
    for (const b of blocks) {
      if (!b.syms.length) continue;
      const label = b.t.join(' ').replace(/\s+/g, ' ').trim();
      if (sec.split_x != null) {
        const sx = sec.split_x * W;
        const groups = [b.syms.filter((c) => (c.bb[0] + c.bb[2]) / 2 < sx), b.syms.filter((c) => (c.bb[0] + c.bb[2]) / 2 >= sx)];
        groups.forEach((g, k) => { if (g.length) add(g.flatMap((c) => c.ids), `${label}${sec.variants?.[k] ? ` (${sec.variants[k]})` : ''}`, sec.kind); });
      } else add(b.syms.flatMap((c) => c.ids), label, sec.kind);
    }
  }
  // 2) 구역을 직접 지정한 기호
  for (const m of sc.manual || []) {
    const R = px(m.bb);
    const clusters = clusterPrims(prims, { gap: 2.5, maxLen: m.maxLen || 120, region: R });
    const ids = clusters.filter((c) => !isText(c)).flatMap((c) => c.ids);
    add(ids, m.label, m.kind, m.id ? {} : {});
  }
  if (sheetDir) {
    fs.mkdirSync(sheetDir, { recursive: true });
    const mine = library.filter((t) => t.source.file_index === fi);
    const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}"><rect width="100%" height="100%" fill="#fff"/>`];
    for (const p of prims) svg.push(`<polyline fill="${p.fill ? '#000' : 'none'}" stroke="#000" stroke-width="0.4" points="${p.pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`);
    for (const t of mine) {
      const [x0, y0, x1, y1] = [t.source.bb[0] * W, t.source.bb[1] * H, t.source.bb[2] * W, t.source.bb[3] * H];
      svg.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${t.kind === 'valve' ? '#d00' : t.kind === 'instrument' ? '#06c' : t.kind === 'piping' ? '#090' : '#c60'}" stroke-width="0.6"/><text x="${x0}" y="${y0 - 1}" font-size="3.2" fill="#00f">${t.id.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
    }
    svg.push('</svg>');
    fs.writeFileSync(path.join(sheetDir, `f${fi}.svg`), svg.join('\n'));
  }
}
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

fs.writeFileSync(outPath, JSON.stringify(library));
const by = {};
for (const t of library) by[t.kind] = (by[t.kind] || 0) + 1;
console.log(`기호 ${library.length}개`, by);
for (const t of library) console.log(t.id.padEnd(52), t.kind.padEnd(10), t.label);
