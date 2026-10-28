// 채팅 세션 분석 3단계: 시트별 판독 결과를 합치고 공용 후처리(위치 보정·연결성·범례 검증)를 거쳐 결과 JSON을 만든다.
// 사용법: node scripts/session/assemble.mjs <workdir>
//   입력: manifest.json, sheets.json, legend.json, out/f<fi>-p<p>.json (없거나 깨진 시트는 "판독 실패" 검토 항목으로)
//   출력: result.json — 채팅 분석 페이지가 그대로 불러 쓰는 형식 (files[i].assetId 포함)
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText } from '../../server/pdfText.js';
import { postprocess } from '../../shared/postprocess.js';
import { emptyLegend, mergeLegend, mergeSheets } from '../../shared/merge.js';

const [workdir] = process.argv.slice(2);
const read = async (f, fallback) => { try { return JSON.parse(await fs.readFile(path.join(workdir, f), 'utf8')); } catch { return fallback; } };
const manifest = await read('manifest.json');
const sheets = await read('sheets.json');
const legendPart = await read('legend.json', null);
const doc = await read('doc.json', {});

// 범례 내용(legend.json 하나)은 첫 범례 시트에 붙이고, 나머지 범례 시트는 위치만 등록한다
const legend = emptyLegend();
const legendSheets = sheets.filter((x) => x.sheet_type === 'legend');
legendSheets.forEach((s, i) => mergeLegend(legend, i === 0 ? legendPart : null, s));
legend.found = legendSheets.length > 0;

const parts = [], failures = [];
for (const s of sheets.filter((x) => x.sheet_type === 'pid')) {
  const out = await read(path.join('out', `f${s.file_index}-p${s.page}.json`), null);
  if (out && typeof out === 'object' && Array.isArray(out.nodes)) parts.push({ sheet: s, out });
  else failures.push({ sheet: s, message: out ? '판독 결과 형식이 맞지 않습니다.' : '판독 결과가 없습니다.' });
}
const texts = await Promise.all(manifest.files.map(async (f) => extractPdfText(await fs.readFile(f.path))));
const raw = { ...mergeSheets(sheets, legend, parts, failures), doc_type: doc.doc_type || 'pid' };
if (doc.summary) raw.summary = doc.summary;
const result = postprocess(raw, manifest.files.map((f, i) => ({ name: f.name, text: texts[i] })));
result.files.forEach((f, i) => { f.assetId = manifest.files[i].assetId; });
const pid = sheets.filter((x) => x.sheet_type === 'pid').length;
result.meta = { engine: 'claude-code-session', analyzedAt: new Date().toISOString(), progress: { total: pid, done: parts.length, failed: failures.length } };
await fs.writeFile(path.join(workdir, 'result.json'), JSON.stringify(result));
console.log(JSON.stringify({ sheets: sheets.length, pid, done: parts.length, failed: failures.map((f) => `${f.sheet.file_index}:${f.sheet.page}`), stats: result.stats }));
console.log(`→ ${path.join(workdir, 'result.json')}`);
