// 범례에서 배운 기호(learn-symbols.mjs 결과)를 P&ID 시트에서 찾아 분석 결과에 넣는다.
//
// 사용: node scripts/session/detect-symbols.mjs <result.json> <library.json> <PDF 폴더> <출력 result.json>
//   PDF 폴더: 결과 JSON의 files[].name 그대로인 PDF들
// 결과 JSON에 더하는 것
//   symbols: [{id, sym, label, kind, loc:{file_index, page, bbox, source:'symbol'}, rot, score, text?, node_id?}]
//     kind: instrument(계기) | valve(밸브) | piping(배관 부속) | equipment(설비)
//     text: 기호 안의 글자(텍스트 레이어, 계기 버블의 태그 등), node_id: 연결한 분석 결과 항목
//   symbol_library: [{id, label, kind, source}]  (범례 어디서 배웠는지; 점 데이터는 빼고)
//   위치가 없던 항목에 기호가 연결되면 그 항목의 loc를 기호 위치로 채운다(source: 'symbol').
import fs from 'fs';
import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPrimitives, prepareTarget, detectSymbols } from '../../shared/pidSymbols.js';

const [resPath, libPath, pdfDir, outPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resPath, 'utf8'));
const library = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 기호 이름과 분석 결과 항목 형식이 어울리는지 (예: BALL VALVE ↔ Ball Valve, 형식이 'Manual Valve'처럼 일반적이면 아무 밸브나)
const WORDS = ['BALL', 'GATE', 'GLOBE', 'CHECK', 'BUTTERFLY', 'PLUG', 'KNIFE', 'PINCH', 'DIAPHRAGM', 'HOSE', 'REDUCER', 'STRAINER', 'FILTER',
  'PUMP', 'TANK', 'MOTOR', 'AGITATOR', 'MIXER', 'FAN', 'BLOWER', 'COMPRESSOR', 'EXCHANGER', 'CONVEYOR', 'FEEDER', 'THICKENER', 'CENTRIFUGE',
  'CYCLON', 'HOPPER', 'BIN', 'DRYER', 'CRANE', 'SCREEN', 'BLIND', 'TRAP', 'VENT', 'DRAIN', 'POND', 'DRIVE', 'VFD', 'ACTUATOR', 'REGULATOR', 'AIR'];
const words = (s) => WORDS.filter((w) => String(s || '').toUpperCase().includes(w));
function compatible(sym, node) {
  const a = words(sym.label);
  const b = words(`${node.equipment_type || ''} ${node.name || ''}`);
  if (sym.kind === 'valve') return node.category === 'valve' && (!b.length || !a.length || a.some((w) => b.includes(w)));
  if (sym.kind === 'piping') return (node.category === 'valve' || node.category === 'other') && a.some((w) => b.includes(w));
  if (sym.kind === 'equipment') return node.category === 'equipment' && a.some((w) => b.includes(w) || (w === 'CYCLON' && b.includes('CYCLONE')));
  return false;
}

const symbols = [];
const counts = {};
const byId = new Map(result.nodes.map((n) => [n.id, n]));
const sheets = result.drawings.filter((d) => d.sheet_type === 'pid');
let t0 = Date.now();
for (const [k, d] of sheets.entries()) {
  const f = result.files[d.file_index];
  const file = path.join(pdfDir, f.name);
  if (!fs.existsSync(file)) { console.warn('PDF 없음:', f.name); continue; }
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(d.page || 1);
  const { W, H, prims } = await extractPrimitives(page, pdfjs.OPS, pdfjs.Util);
  const found = detectSymbols(prepareTarget(prims), library);
  // 기호 안의 글자 (텍스트 레이어)
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const texts = tc.items.filter((it) => it.str?.trim()).map((it) => {
    const [x, y] = [it.transform[4], vp.height - it.transform[5]];
    const h = Math.hypot(it.transform[2], it.transform[3]) || 6;
    return { s: it.str.trim(), cx: x + (it.width || 0) / 2, cy: y - h / 2 };
  });
  await task.destroy();
  const here = result.nodes.filter((n) => n.loc?.file_index === d.file_index && (n.loc.page || 1) === (d.page || 1));
  const taken = new Set();
  const list = found.map((s, i) => {
    const inside = texts.filter((t) => t.cx >= s.bb[0] - 1 && t.cx <= s.bb[2] + 1 && t.cy >= s.bb[1] - 1 && t.cy <= s.bb[3] + 1)
      .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const text = inside.map((t) => t.s).join(' ');
    const bbox = [s.bb[0] / W, s.bb[1] / H, s.bb[2] / W, s.bb[3] / H].map((v) => +Math.min(1, Math.max(0, v)).toFixed(5));
    const sym = { id: `SYM-${d.file_index}-${String(i + 1).padStart(3, '0')}`, sym: s.id, label: s.label, kind: s.kind, loc: { file_index: d.file_index, page: d.page || 1, bbox, source: 'symbol' }, rot: s.rot, score: s.score };
    if (text) sym.text = text;
    // 기호 안 글자가 ES / AS면 전원·공기 공급 표시
    if (/^ES$/.test(text)) sym.label = 'ELECTRICAL POWER SUPPLY';
    if (/^AS$/.test(text)) sym.label = 'AIR SUPPLY';
    return sym;
  });
  // 1) 계기: 버블 안 태그 글자로
  for (const s of list) {
    if (s.kind !== 'instrument' || !s.text) continue;
    const key = norm(s.text);
    if (key.length < 3) continue;
    const n = here.find((x) => x.category === 'instrument' && norm(x.tag) === key && !taken.has(x.id))
      || here.find((x) => x.category === 'instrument' && norm(x.tag) === key);
    if (n) { s.node_id = n.id; taken.add(n.id); }
  }
  // 2) 밸브·배관 부속·설비: 가까운 태그(분석 결과 위치) 중 형식이 맞는 것, 가까운 순서로 하나씩
  const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const pairs = [];
  for (const s of list) {
    if (s.kind === 'instrument') continue;
    const [sx, sy] = center(s.loc.bbox);
    const reach = s.kind === 'equipment' ? 0.06 : 0.035;
    for (const n of here) {
      if (!n.loc?.bbox || n.loc.source === 'symbol' || !compatible(s, n)) continue;
      const b = n.loc.bbox;
      const dx = Math.max(b[0] - sx, 0, sx - b[2]), dy = Math.max(b[1] - sy, 0, sy - b[3]) * (H / W);
      const dist = Math.hypot(dx, dy);
      if (dist < reach) pairs.push([dist, s, n]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const used = new Set();
  for (const [, s, n] of pairs) {
    if (s.node_id || used.has(n.id)) continue;
    s.node_id = n.id;
    used.add(n.id);
  }
  // 3) 위치가 없던 항목: 형식이 맞는 기호가 그 시트에 하나뿐이고, 위치 없는 같은 형식 항목도 하나뿐이면 연결
  for (const s of list) {
    if (s.node_id || s.kind === 'instrument') continue;
    const cands = here.filter((n) => !n.loc?.bbox && compatible(s, n));
    const syms = list.filter((o) => !o.node_id && o.label === s.label);
    if (cands.length === 1 && syms.length === 1) s.node_id = cands[0].id;
  }
  for (const s of list) {
    const n = s.node_id && byId.get(s.node_id);
    if (n && !n.loc?.bbox) n.loc = { file_index: s.loc.file_index, page: s.loc.page, bbox: s.loc.bbox, source: 'symbol' };
    counts[s.kind] = (counts[s.kind] || 0) + 1;
  }
  symbols.push(...list);
  const linked = list.filter((s) => s.node_id).length;
  console.log(`${k + 1}/${sheets.length} f${d.file_index} ${d.drawing_no}: 기호 ${list.length} (연결 ${linked}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  t0 = Date.now();
}
result.symbols = symbols;
result.symbol_library = library.map(({ id, label, kind, source }) => ({ id, label, kind, source }));
result.stats = { ...result.stats, symbols: symbols.length };
fs.writeFileSync(outPath, JSON.stringify(result));
console.log('기호 합계', symbols.length, counts, '연결', symbols.filter((s) => s.node_id).length);
