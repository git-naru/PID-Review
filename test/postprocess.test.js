import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, findTagOnPages } from '../server/pdfText.js';
import { postprocess } from '../shared/postprocess.js';

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

async function loadSamples() {
  const files = [];
  for (const name of ['PID-100-000.pdf', 'PID-100-001.pdf', 'PID-100-002.pdf']) {
    files.push({ name, text: await extractPdfText(await fs.readFile(path.join(SAMPLES, name))) });
  }
  const raw = JSON.parse(await fs.readFile(path.join(SAMPLES, 'demo-analysis.json'), 'utf8'));
  return { files, raw };
}

test('텍스트 레이어에서 태그 위치를 찾는다 (일반/세로/계기 버블 분리형)', async () => {
  const { files } = await loadSamples();
  const pages = files[1].text.pages;
  const pump = findTagOnPages('P-101A', pages, 1);
  assert.ok(pump, 'P-101A');
  const [x0, y0, x1, y1] = pump.bbox;
  // 샘플 도면에서 P-101A 라벨은 페이지 좌측 하단부 (x≈0.25, y≈0.69)
  assert.ok(x0 > 0.2 && x1 < 0.3 && y0 > 0.65 && y1 < 0.72, `bbox ${pump.bbox}`);
  assert.ok(findTagOnPages('3"-CW-1101-B1A', pages, 1), '세로 라인 번호');
  assert.ok(findTagOnPages('FIC-101', pages, 1), '분리 표기된 계기 태그');
  assert.equal(findTagOnPages('X-999', pages, 1), null);
});

test('기준선이 비슷하지만 떨어져 있는 텍스트는 병합하지 않는다', async () => {
  const { files } = await loadSamples();
  const texts = files[0].text.pages[0].runs.map((r) => r.text);
  // 범례의 계기 문자표 "L"과 기호 설명 "CONTROL VALVE"는 거의 같은 높이에 있지만 별개 항목
  assert.ok(texts.includes('CONTROL VALVE'));
  assert.ok(!texts.some((t) => t.includes('CONTROL VALVE') && t !== 'CONTROL VALVE'));
});

test('연결성 검증으로 의도된 결함을 모두 검출한다', async () => {
  const { files, raw } = await loadSamples();
  const r = postprocess(raw, files);
  const has = (pred) => r.issues.some(pred);

  assert.equal(r.stats.equipment, 9);
  assert.ok(has((i) => i.category === 'unconnected' && i.related_ids.includes('TK-102')), '미연결 설비');
  assert.ok(has((i) => i.category === 'unconnected' && i.related_ids.includes('2"-P-1006-A1A')), '끝단 미연결 라인');
  assert.ok(has((i) => i.category === 'missing_info' && i.related_ids.includes('4"-P-1004')), 'Spec 누락');
  assert.ok(has((i) => i.category === 'offpage_unmatched' && i.title.includes('PID-100-003')), '미입력 도면 참조');
  const dup = r.issues.find((i) => i.category === 'duplicate' && i.related_ids.includes('LT-201'));
  assert.ok(dup, '중복 태그');
  assert.equal(dup.loc.marks.length, 2, '중복 위치 2곳 표시');

  // 도면 간 Off-page 연결은 이슈가 아니라 링크로 연결
  assert.equal(r.links.length, 1);
  assert.ok(!has((i) => i.related_ids.includes('OPC:PID-100-001:1')));
  // 모델이 이미 보고한 TK-102 이슈는 규칙 이슈와 중복되지 않음
  assert.equal(r.issues.filter((i) => i.related_ids.includes('TK-102')).length, 1);
});

test('모든 설비/이슈에 도면 위치가 지정된다', async () => {
  const { files, raw } = await loadSamples();
  const r = postprocess(raw, files);
  for (const n of r.nodes) assert.equal(n.loc.source, 'text', `${n.id} 위치`);
  for (const i of r.issues) assert.ok(i.loc?.bbox, `${i.id} ${i.title} 위치`);
});

test('범례를 반영한다: 예시 라인 번호는 위치 검색에서 제외, 코드 설명 부여, 범례 위반 검출', async () => {
  const { files, raw } = await loadSamples();
  // 모델이 위치를 범례 시트로 잘못 지정한 경우에도 실제 도면에서 찾아야 함
  const l = raw.lines.find((x) => x.line_no === '6"-P-1001-A1A');
  l.loc = { file_index: 0, page: 1, bbox: null };
  const r = postprocess(raw, files);
  assert.ok(r.legend.found);
  assert.deepEqual(r.legend.pages, [{ file_index: 0, page: 1 }]);
  // 범례 시트(file 0)에도 6"-P-1001-A1A 예시가 있지만 실제 라인은 PID-100-001(file 1)에 위치해야 함
  const l1001 = r.lines.find((l) => l.line_no === '6"-P-1001-A1A');
  assert.equal(l1001.loc.file_index, 1);
  assert.match(l1001.class_desc, /ASME 150#/);
  assert.equal(l1001.fluid_desc, 'PROCESS');
  assert.ok(r.issues.some((i) => i.category === 'inconsistent' && i.related_ids.includes('3"-P-2003-A2A')), '범례에 없는 Class');
  assert.ok(!r.issues.some((i) => i.title.includes('범례(Legend) 시트 미입력')));
});

test('범례가 없으면 그 사실을 검토 항목으로 알린다', async () => {
  const { files, raw } = await loadSamples();
  const r = postprocess({ ...raw, legend: { found: false, pages: [] }, drawings: raw.drawings.filter((d) => d.sheet_type !== 'legend') }, files);
  assert.equal(r.legend.found, false);
  assert.ok(r.issues.some((i) => i.title.includes('범례(Legend) 시트 미입력')));
  assert.ok(!r.issues.some((i) => i.title.includes('범례에 없는')));
});

test('잘못된 참조와 0-1000 스케일 bbox를 정규화한다', async () => {
  const { files } = await loadSamples();
  const r = postprocess({
    summary: '', drawings: [],
    nodes: [{ id: 'A', tag: 'ZZ-1', name: 'X', category: 'equipment', specs: [], loc: { file_index: 9, page: 5, bbox: [100, 200, 300, 400] } }],
    lines: [{ id: 'L1', line_no: '', kind: 'process', from_id: 'A', to_id: 'NOPE', inline_items: [], loc: { file_index: 0, page: 1, bbox: null } }],
    issues: [],
  }, files);
  assert.deepEqual(r.nodes[0].loc, { file_index: 0, page: 1, bbox: [0.1, 0.2, 0.3, 0.4], source: 'model' });
  assert.equal(r.lines[0].to_id, '');
  assert.ok(r.issues.some((i) => i.category === 'inconsistent' && i.title.includes('NOPE')));
  assert.ok(r.issues.some((i) => i.category === 'unconnected' && i.related_ids.includes('L1')));
});

test('PFD: 스트림 데이터를 유지하고 관경·Spec·범례 같은 P&ID 전용 검사는 하지 않는다', async () => {
  const { files } = await loadSamples();
  const r = postprocess({
    doc_type: 'pfd', summary: '', drawings: [], legend: { found: false },
    nodes: [
      { id: 'A', tag: '', name: 'OP 1 - LIME SLAKER', category: 'equipment', specs: [], loc: { file_index: 1, page: 1, bbox: null } },
      { id: 'B', tag: '', name: 'OP 1 - LIME AGING TANK', category: 'equipment', specs: [], loc: { file_index: 1, page: 1, bbox: null } },
    ],
    lines: [{ id: 'S-1201', line_no: '1201', kind: 'process', from_id: 'A', to_id: 'B', inline_items: [], specs: [{ name: 'Mass flow', value: '36.1 t/h' }], loc: { file_index: 1, page: 1, bbox: null } }],
    issues: [],
  }, files);
  assert.equal(r.doc_type, 'pfd');
  assert.deepEqual(r.lines[0].specs, [{ name: 'Mass flow', value: '36.1 t/h' }]);
  assert.ok(!r.issues.some((i) => /관경|Spec|라인 번호|범례|사양 정보/.test(i.title)), r.issues.map((i) => i.title).join(', '));
});

test('같은 글자가 여러 곳에 있으면 모델이 짚은 위치에 가까운 쪽을 고른다', () => {
  const pg = { page: 1, runs: [
    { text: '1101', bbox: [0.30, 0.10, 0.32, 0.11], vertical: false }, // 도면 위 스트림 표식
    { text: '1101', bbox: [0.10, 0.80, 0.12, 0.81], vertical: false }, // 물질수지표 머리글
  ] };
  assert.equal(findTagOnPages('1101', [pg], 1, [0.11, 0.8]).bbox[1], 0.80);
  assert.equal(findTagOnPages('1101', [pg], 1, [0.31, 0.1]).bbox[1], 0.10);
});

test('시트별 판독에서 겹치는 id는 시트 안의 연결을 유지한 채 구분된다', async () => {
  const { mergeSheets } = await import('../shared/merge.js');
  const sheet = (fi, dwg) => ({ file_index: fi, page: 1, sheet_type: 'pid', drawing_no: dwg, title: '', revision: '' });
  const s1 = sheet(1, 'X-PFD-00001'), s2 = sheet(2, 'X-PFD-00002');
  const out = (tank) => ({
    nodes: [{ id: 'PUMP-1', name: 'PUMP-1', category: 'equipment', tag: '' }, { id: tank, name: tank, category: 'equipment', tag: '' }],
    lines: [{ id: 'LINE-1', line_no: '', kind: 'process', from_id: tank, to_id: 'PUMP-1', inline_items: ['PUMP-1'] }],
    issues: [{ title: 'x', related_ids: ['PUMP-1', 'LINE-1'] }],
  });
  const raw = mergeSheets([s1, s2], null, [{ sheet: s1, out: out('TANK-A') }, { sheet: s2, out: out('TANK-B') }]);
  assert.deepEqual(raw.nodes.map((n) => n.id), ['PUMP-1', 'TANK-A', 'PUMP-1@PFD-00002', 'TANK-B']);
  assert.equal(raw.lines[1].id, 'LINE-1@PFD-00002');
  assert.equal(raw.lines[1].to_id, 'PUMP-1@PFD-00002');
  assert.deepEqual(raw.issues[1].related_ids, ['PUMP-1@PFD-00002', 'LINE-1@PFD-00002']);
  assert.deepEqual(raw.lines[1].inline_items, ['PUMP-1@PFD-00002']);
});

test('도면 선 추적: Line No.에서 시작해 이어진 배관(갈림길 포함)을 따라가고 설비 기호에서 멈춘다', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { extractGeometry, traceLine } = await import('../shared/pdfGeom.js');
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(path.join(SAMPLES, 'PID-100-001.pdf'))) });
  try {
    const g = await extractGeometry(await (await task.promise).getPage(1), pdfjs.OPS, pdfjs.Util);
    const { files } = await loadSamples();
    // 6"-P-1001-A1A: TK-101 출구에서 갈라져 P-101A·P-101B 흡입까지 (펌프 기호에서 멈춤)
    const t = traceLine(g, findTagOnPages('6"-P-1001-A1A', files[1].text.pages, 1).bbox);
    const ys = t.segs.flatMap((s) => [s[1], s[3]]), xs = t.segs.flatMap((s) => [s[0], s[2]]);
    assert.ok(ys.some((y) => Math.abs(y - 0.644) < 0.002) && ys.some((y) => Math.abs(y - 0.762) < 0.002), `두 갈래 ${JSON.stringify(t.segs)}`);
    assert.ok(xs.every((x) => x < 0.245), '펌프를 넘어가지 않음');
    // 4"-P-1004: E-101 → V-101 계단 모양 경로만
    const t2 = traceLine(g, findTagOnPages('4"-P-1004', files[1].text.pages, 1).bbox);
    assert.ok(t2.segs.every((s) => s[0] >= 0.51 && s[2] <= 0.66 && s[0] <= 0.66), JSON.stringify(t2.segs));
  } finally {
    task.destroy();
  }
});

test('점선(짧은 대시 조각)도 끊긴 틈을 건너 모서리까지 따라가고, 선·화살촉 위 점은 거리 0에 가깝다', async () => {
  const { traceLine, traceDistance } = await import('../shared/pdfGeom.js');
  const segs = [];
  // y=0.4 에서 x 0.10→0.30 까지 대시(길이 0.004, 틈 0.002), 이어서 x=0.30 에서 아래로 0.40→0.50
  for (let x = 0.10; x < 0.30; x += 0.006) segs.push({ a: [x, 0.4], b: [Math.min(x + 0.004, 0.3), 0.4], dashed: false });
  for (let y = 0.40; y < 0.50; y += 0.006) segs.push({ a: [0.3, y], b: [0.3, Math.min(y + 0.004, 0.5)], dashed: false });
  segs.push({ a: [0.05, 0.6], b: [0.4, 0.6], dashed: false }); // 관계없는 선
  const arrow = [[0.296, 0.5], [0.304, 0.5], [0.3, 0.508]];
  const geom = { segs, fills: [arrow] };
  const t = traceLine(geom, [0.15, 0.394, 0.158, 0.4]); // 대시 위 라벨
  assert.ok(t.segs.length > 40, `대시 ${t.segs?.length}개`);
  assert.ok(t.segs.some((s) => s[1] > 0.45), '모서리를 돌아 아래로');
  assert.ok(!t.segs.some((s) => s[1] === 0.6), '다른 선은 포함하지 않음');
  assert.equal(t.arrows.length, 1);
  assert.ok(traceDistance(t, [0.2, 0.4]) < 0.002);
  assert.equal(traceDistance(t, [0.3, 0.503]), 0, '화살촉 안');
  assert.ok(traceDistance(t, [0.2, 0.6]) > 0.1);
});

test('NOTES 영역: 제목 아래 같은 열로 이어진 문단만 묶고 오른쪽 범례(SYMBOLS)는 넣지 않는다', async () => {
  const { notesRegions } = await import('../shared/pdfGeom.js');
  const t = (s, x, y, w = 0.01) => ({ s, x, y, w, h: 0.01 });
  const items = [
    t('NOTES:', 0.37, 0.667, 0.02),
    t('1.', 0.368, 0.685), t('THE MASS BALANCE RESULTS ...', 0.376, 0.685, 0.45),
    ...Array.from({ length: 11 }, (_, i) => t(`NOTE LINE ${i + 2}`, 0.376, 0.693 + i * 0.008, 0.3)),
    t('12.', 0.368, 0.783), t('TOTAL SALTS HARVESTED CAN BE SEEN IN STREAM 1315', 0.376, 0.783, 0.4),
    t('SYMBOLS:', 0.866, 0.674), t('MAIN FLOW', 0.906, 0.694),
    t('1315', 0.5, 0.3), // 도면 본문의 스트림 표식
    t('REV', 0.37, 0.95), // 표제란: 문단과 떨어져 있음
  ];
  const [r] = notesRegions(items);
  const inside = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  assert.equal(notesRegions(items).length, 1);
  assert.ok(inside(0.7, 0.78), '문단 안의 스트림 번호');
  assert.ok(!inside(0.906, 0.694), 'SYMBOLS 범례');
  assert.ok(!inside(0.5, 0.3), '도면 본문');
  assert.ok(!inside(0.37, 0.95), '표제란');
});
