import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTemplate, prepareTarget, detectSymbols, clusterPrims } from '../shared/pidSymbols.js';

// 도형 만들기 (pt 좌표)
const prim = (pts, o = {}) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { pts, curves: 0, closed: false, fill: false, stroke: true, dash: false, w: 0.7, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], ...o };
};
const circle = (cx, cy, r) => {
  const pts = [];
  for (let k = 0; k <= 16; k++) pts.push([cx + r * Math.cos((k / 16) * 2 * Math.PI), cy + r * Math.sin((k / 16) * 2 * Math.PI)]);
  return prim(pts, { curves: 4, closed: true });
};
// 게이트 밸브: 나비넥타이 (가로 22 x 세로 11)
const bowtie = (x, y, vertical = false) => {
  const p = [[0, 0], [22, 11], [22, 0], [0, 11], [0, 0]].map(([a, b]) => (vertical ? [x + b, y + a] : [x + a, y + b]));
  return prim(p);
};
// 글로브 밸브: 나비넥타이 + 가운데 원
const globe = (x, y) => [bowtie(x, y), circle(x + 11, y + 5.5, 3)];
// 계기 버블
const bubble = (x, y) => circle(x, y, 16);

const library = [
  makeTemplate([bowtie(0, 0)], { id: 'gate', label: 'GATE VALVE', kind: 'valve' }),
  makeTemplate(globe(0, 0), { id: 'globe', label: 'GLOBE VALVE', kind: 'valve' }),
  makeTemplate([bubble(0, 0)], { id: 'inst', label: 'INSTRUMENT', kind: 'instrument', scale: [0.7, 1.5] }),
];

test('범례 템플릿으로 도면의 밸브·계기 기호를 찾고, 모양이 비슷한 기호를 구별한다', () => {
  const prims = [
    bowtie(100, 100), // 가로 게이트 밸브
    bowtie(300, 200, true), // 세로(90° 회전) 게이트 밸브
    ...globe(500, 100), // 글로브 밸브
    bubble(700, 300), // 계기 버블
    circle(900, 300, 21), // 조금 큰 계기 버블 (배율 1.3)
    prim([[0, 150], [100, 150]]), prim([[122, 150], [300, 150]]), // 배관 선
  ];
  const found = detectSymbols(prepareTarget(prims), library);
  const at = (x, y) => found.find((f) => f.bb[0] <= x && x <= f.bb[2] && f.bb[1] <= y && y <= f.bb[3]);
  assert.equal(at(111, 105)?.id, 'gate');
  assert.equal(at(305, 211)?.id, 'gate');
  assert.ok(['90', '270', 'm90', 'm270'].includes(at(305, 211).rot));
  assert.equal(at(511, 105)?.id, 'globe', '가운데 원이 있으면 글로브 밸브');
  assert.equal(at(700, 300)?.id, 'inst');
  assert.equal(at(900, 300)?.id, 'inst');
  assert.equal(found.length, 5, '배관 선은 기호가 아니다');
});

test('게이트 밸브 자리에는 글로브 밸브(더 복잡한 기호)를 잘못 고르지 않는다', () => {
  const found = detectSymbols(prepareTarget([bowtie(50, 50)]), library);
  assert.deepEqual(found.map((f) => f.id), ['gate']);
});

test('범례 도형을 기호 단위로 묶는다 (긴 표 테두리는 뺀다)', () => {
  const prims = [...globe(10, 10), bowtie(100, 10), prim([[0, 40], [400, 40]])];
  const groups = clusterPrims(prims, { gap: 2.5, maxLen: 80 });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.ids.length).sort(), [1, 2]);
});
