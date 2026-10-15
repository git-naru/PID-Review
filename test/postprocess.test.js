import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, findTagOnPages } from '../server/pdfText.js';
import { postprocess } from '../server/postprocess.js';

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

async function loadSamples() {
  const files = [];
  for (const name of ['PID-100-001.pdf', 'PID-100-002.pdf']) {
    files.push({ name, text: await extractPdfText(await fs.readFile(path.join(SAMPLES, name))) });
  }
  const raw = JSON.parse(await fs.readFile(path.join(SAMPLES, 'demo-analysis.json'), 'utf8'));
  return { files, raw };
}

test('텍스트 레이어에서 태그 위치를 찾는다 (일반/세로/계기 버블 분리형)', async () => {
  const { files } = await loadSamples();
  const pages = files[0].text.pages;
  const pump = findTagOnPages('P-101A', pages, 1);
  assert.ok(pump, 'P-101A');
  const [x0, y0, x1, y1] = pump.bbox;
  // 샘플 도면에서 P-101A 라벨은 페이지 좌측 하단부 (x≈0.25, y≈0.69)
  assert.ok(x0 > 0.2 && x1 < 0.3 && y0 > 0.65 && y1 < 0.72, `bbox ${pump.bbox}`);
  assert.ok(findTagOnPages('3"-CW-1101-B1A', pages, 1), '세로 라인 번호');
  assert.ok(findTagOnPages('FIC-101', pages, 1), '분리 표기된 계기 태그');
  assert.equal(findTagOnPages('X-999', pages, 1), null);
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
