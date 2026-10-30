import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../server/pdfText.js';
import { postprocess } from '../shared/postprocess.js';
import {
  readMassBalanceFile, parseMassBalance, applyMassBalance, stripMassBalance, splitLabel, streamKey,
  valueOptions, defaultValueKey, lineValue, lithiumGpl, MassBalanceError, drawingMassBalance,
} from '../shared/massbalance.js';

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const read = async (name) => { const b = await fs.readFile(path.join(SAMPLES, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

async function demoResult() {
  const files = [];
  for (const name of ['PID-100-000.pdf', 'PID-100-001.pdf', 'PID-100-002.pdf']) {
    files.push({ name, text: await extractPdfText(await fs.readFile(path.join(SAMPLES, name))) });
  }
  return postprocess(JSON.parse(await fs.readFile(path.join(SAMPLES, 'demo-analysis.json'), 'utf8')), files);
}
const grid = (rows) => rows.map((r) => r.map((v, c) => (v === '' ? null : { text: String(v), x0: c, x1: c + 1 })).filter(Boolean));

test('엑셀과 CSV 물질수지를 같은 내용으로 읽는다 (단위 열, 성분 묶음 행)', async () => {
  const xlsx = await readMassBalanceFile('PID-100-MB.xlsx', await read('PID-100-MB.xlsx'));
  const csv = await readMassBalanceFile('PID-100-MB.csv', await read('PID-100-MB.csv'));
  assert.equal(xlsx.sheet, 'H&MB');
  // 엑셀은 숫자를 값으로 저장하므로("25.0" → 25) 숫자로 비교
  const norm = (mb) => JSON.stringify(mb.streams, (k, v) => (k === 'sheet' ? undefined : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
  assert.equal(norm(xlsx), norm(csv));
  assert.equal(xlsx.streams.length, 8);
  const s3 = xlsx.streams.find((s) => s.id === '3');
  assert.deepEqual([s3.description, s3.from, s3.to, s3.line_no], ['Preheated feed', 'E-101', 'V-101', '']);
  const names = xlsx.properties.map((p) => `${p.name}|${p.unit}`);
  assert.ok(names.includes('PRESSURE|kPa(g)'));
  assert.ok(names.includes('WATER (Component Mass Flow)|kg/h'), '묶음 행의 단위를 성분 행이 물려받음');
  assert.equal(defaultValueKey(valueOptions({ lines: [], mass_balance: xlsx })), 'massflownormal|kg/h');
});

test('스트림이 행 방향인 표, 블록이 여러 개인 표도 읽는다', () => {
  const blocks = parseMassBalance(grid([
    ['Stream No.', '', '101', '102'],
    ['Mass flow', 'kg/h', '10', '20'],
    [],
    ['Stream No.', '', '103', '104'],
    ['Mass flow', 'kg/h', '30', '40'],
  ]));
  assert.deepEqual(blocks.streams.map((s) => s.values['massflow|kg/h']), ['10', '20', '30', '40']);
  assert.equal(parseMassBalance(grid([['Temperature', '25', '30', '35']])), null, '스트림 머리글 없는 숫자 행은 머리글이 아님');
});

test('구분 제목 행: NOMINAL/DESIGN은 이름 앞에, OTHER VALUES는 무시, 성분 묶음은 뒤에 붙인다', () => {
  const mb = parseMassBalance(grid([
    ['AREA TITLE', 'Stream', '1101', '1103'],
    ['AREA TITLE', 'Unit', 'Raw brine', 'PC brine'], // 병합 셀로 제목이 채워진 설명 행
    ['NOMINAL FLOW', '', '', ''],
    ['Mass Flow', 't/h', '1302.7', '538.2'],
    ['DESIGN FLOW', '', '', ''],
    ['Mass Flow', 't/h', '1693.5', '699.7'],
    ['OTHER VALUES', '', '', ''],
    ['Density', 't/m3', '1.208', '-'],
    ['Design Factor', '―', '1.3', '1.3'],
    ['LIQUID CHEMICAL COMPOSITION', '', '', ''],
    ['Li+', '% w/w', '0.064', '0.15'],
  ]));
  assert.deepEqual(mb.streams.map((s) => s.description), ['Raw brine', 'PC brine']);
  assert.deepEqual(mb.properties.map((p) => p.key), ['nominalmassflow|t/h', 'designmassflow|t/h', 'density|t/m3', 'designfactor|', 'li+|%w/w|liquidchemicalcomposition']);
  assert.equal(mb.streams[1].values['density|t/m3'], undefined, '"-"는 값 없음');
});

test('이름·단위 분리와 스트림 번호 정규화', () => {
  assert.deepEqual(splitLabel(['Mass Flow', 'kg/h']), { name: 'Mass Flow', unit: 'kg/h' });
  assert.deepEqual(splitLabel('Nominal mass flow (t/h)'), { name: 'Nominal mass flow', unit: 't/h' });
  assert.deepEqual(splitLabel('MASS FLOW (NORMAL)'), { name: 'MASS FLOW (NORMAL)', unit: '' });
  assert.deepEqual(splitLabel('Pressure, kPa(g)'), { name: 'Pressure', unit: 'kPa(g)' });
  assert.equal(streamKey('S-0101'), '101');
  assert.equal(streamKey('Stream 101'), '101');
});

test('P&ID: Line No.와 From/To 설비로 매칭하고 도면에 없는 스트림을 알린다', async () => {
  const r = await demoResult();
  const mb = await readMassBalanceFile('PID-100-MB.xlsx', await read('PID-100-MB.xlsx'));
  const out = applyMassBalance(r, mb);
  const by = (sid) => out.mass_balance.matches.filter((m) => m.stream_id === sid);
  assert.deepEqual(by('1').map((m) => [m.line_id, m.method]), [['6"-P-1001-A1A', 'line_no']]);
  assert.deepEqual(by('4').map((m) => m.line_id), ['4"-P-1005-A1A', '4"-P-1005-A1A#2'], 'Off-page로 나뉜 같은 라인 둘 다');
  assert.deepEqual(by('3').map((m) => [m.line_id, m.method]), [['4"-P-1004', 'from_to']]);
  assert.equal(by('8').length, 0);
  assert.equal(out.mass_balance.stats.matched_streams, 7);
  const iss = out.issues.filter((i) => i.source === 'massbalance');
  assert.equal(iss.length, 1);
  assert.match(iss[0].title, /찾지 못한 물질수지 스트림 1개/);
  assert.equal(out.stats.issues.low, r.stats.issues.low + 1);
  // 표시 값: 매칭된 라인은 물질수지 값
  const streamOf = (id) => out.mass_balance.streams.find((s) => s.id === out.mass_balance.matches.find((m) => m.line_id === id)?.stream_id);
  assert.equal(lineValue(out.lines.find((l) => l.id === '4"-P-1004'), 'massflownormal|kg/h', streamOf).value, '25000');
  // 다시 적용하거나 빼도 검토 항목이 쌓이지 않는다
  const again = applyMassBalance(out, mb);
  assert.equal(again.issues.length, out.issues.length);
  const back = stripMassBalance(again);
  assert.equal(back.issues.length, r.issues.length);
  assert.equal(back.mass_balance, undefined);
  assert.ok(back.lines.every((l) => l.issue_ids.every((id) => !id.startsWith('MB-'))));
});

test('PFD: 스트림 번호로 매칭하고 도면 표기값과 물질수지 값 차이를 검출한다', async () => {
  const { files } = { files: [{ name: 'pfd.pdf', text: { pageCount: 1, pages: [{ page: 1, runs: [] }] } }] };
  const r = postprocess({
    doc_type: 'pfd', summary: '', drawings: [], legend: { found: false },
    nodes: [{ id: 'A', name: 'TANK', category: 'equipment' }, { id: 'B', name: 'REACTOR', category: 'equipment' }],
    lines: [
      { id: 'S-1', line_no: '1101', kind: 'process', from_id: 'A', to_id: 'B', specs: [{ name: 'Nominal mass flow (t/h)', value: '36.1' }] },
      { id: 'S-2', line_no: '1102', kind: 'process', from_id: 'B', to_id: 'A', specs: [{ name: 'Nominal mass flow (t/h)', value: '12' }] },
      { id: 'S-3', line_no: '1103', kind: 'process', from_id: 'B', to_id: 'A', specs: [] },
    ],
    issues: [],
  }, files);
  const mb = parseMassBalance(grid([
    ['Stream No.', 'S-01101', 'S-01102', 'S-09999'],
    ['Nominal mass flow', '36.14', '14.5', '1'],
  ]));
  const out = applyMassBalance(r, { name: 'mb.csv', ...mb });
  assert.deepEqual(out.mass_balance.matches.map((m) => [m.line_id, m.stream_id]), [['S-1', 'S-01101'], ['S-2', 'S-01102']]);
  const titles = out.issues.filter((i) => i.source === 'massbalance').map((i) => i.title);
  assert.ok(!titles.some((t) => t.includes('스트림 1101')), '반올림 차이는 허용');
  assert.ok(titles.includes('도면과 물질수지 값 불일치 (스트림 1102)'));
  assert.ok(titles.includes('물질수지에 없는 도면 스트림 1개'));
  assert.ok(titles.includes('도면에서 찾지 못한 물질수지 스트림 1개'));
});

test('읽을 수 없는 파일은 이유를 알려 준다', async () => {
  await assert.rejects(readMassBalanceFile('old.xls', new ArrayBuffer(8)), MassBalanceError);
  await assert.rejects(readMassBalanceFile('drm.xlsx', new TextEncoder().encode('not a zip').buffer), /암호나 문서 보안/);
  await assert.rejects(readMassBalanceFile('x.csv', new TextEncoder().encode('a,b\n1,2\n').buffer), /스트림 번호 행/);
});

test('Li 농도(g/L): 액상은 Li+ × 밀도, 슬러리는 액상 분율 반영, 고상 Li2CO3는 총 Li에 포함', () => {
  const mb = parseMassBalance(grid([
    ['Stream', '', '1101', '1530', '1600'],
    ['Density', 't/m3', '1.208', '0.98', '1050'],
    ['% Solids', '%', '0', '63.2', '0'],
    ['LIQUID CHEMICAL COMPOSITION', '', '', '', ''],
    ['Li+', '% w/w', '0.0641', '0.162', '0.5'],
    ['SOLID CHEMICAL COMPOSITION', '', '', '', ''],
    ['Li2CO3', '% w/w', '0', '98.46', '0'],
  ]));
  const [brine, cake] = mb.streams.map((s) => lithiumGpl(s, mb.properties));
  assert.equal(brine.basis, 'liquid');
  assert.ok(Math.abs(brine.gpl - 0.0641 * 1.208 * 10) < 1e-9);
  assert.equal(cake.basis, 'stream');
  assert.ok(Math.abs(cake.gpl - 0.162 * 0.368 * 0.98 * 10) < 1e-9);
  assert.ok(Math.abs(cake.totalGpl - (0.162 * 0.368 + 98.46 * 0.18785 * 0.632) * 0.98 * 10) < 1e-6);
  // 밀도 단위가 kg/m3이면 1000으로 나눈다
  const kgm3 = parseMassBalance(grid([['Stream', '', '1', '2'], ['Density', 'kg/m3', '1050', '1000'], ['Li+', '% w/w', '0.5', '0']]));
  assert.ok(Math.abs(lithiumGpl(kgm3.streams[0], kgm3.properties).gpl - 5.25) < 1e-9);
});

test('도면 안 스트림 표: 라인 specs를 물질수지로 모아 Li 농도를 내고, 검토 항목은 만들지 않는다', () => {
  const line = (no, specs) => ({ id: `S-${no}`, line_no: no, kind: 'process', stream_no: '', specs, issue_ids: [], from_id: '', to_id: '' });
  const result = {
    doc_type: 'pfd', nodes: [], issues: [], stats: { issues: { high: 0, medium: 0, low: 0 } },
    lines: [
      line('1101', [{ name: 'Stream description', value: 'Raw brine' }, { name: 'Nominal mass flow (t/h)', value: '1,303' },
        { name: 'Density (t/m3)', value: '1.208' }, { name: 'Li+ (% w/w)', value: '0.06' }, { name: 'Design factor (-)', value: '-' }]),
      line('1095', []),
    ],
  };
  const mb = drawingMassBalance(result);
  assert.equal(mb.source, 'drawing');
  assert.deepEqual(mb.streams.map((s) => s.id), ['1101']);
  assert.equal(mb.streams[0].description, 'Raw brine');
  const li = lithiumGpl(mb.streams[0], mb.properties);
  assert.ok(Math.abs(li.gpl - 0.06 * 1.208 * 10) < 1e-9);
  const out = applyMassBalance(result, mb);
  assert.equal(out.mass_balance.source, 'drawing');
  assert.equal(out.mass_balance.stats.matched_streams, 1);
  assert.equal(out.issues.length, 0, '도면 자신과 비교하는 검토 항목은 없음');
  assert.equal(drawingMassBalance({ ...result, lines: [line('1095', [])] }), null);
});
