// 채팅 세션 분석 2단계: 시트 분류(sheets.json)와 범례(legend.json)가 정해진 뒤, P&ID 시트별 판독 지시문을 만든다.
// 사용법: node scripts/session/make-prompts.mjs <workdir>
//   입력: manifest.json, sheets.json ([{file_index, page, sheet_type, drawing_no, title, revision}]), legend.json (없으면 범례 미입력),
//         doc.json (선택: {"doc_type": "pid" | "pfd", "note": "도면 종류별 판독 지침"})
//   출력: prompts/f<fi>-p<p>.txt — 각 파일 끝에 결과 JSON을 저장할 경로가 적혀 있다 (out/f<fi>-p<p>.json)
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText } from '../../server/pdfText.js';
import { pageTextForPrompt } from '../../shared/pidText.js';
import { sheetPrompt } from '../../shared/prompts.js';
import { compactLegend, emptyLegend } from '../../shared/merge.js';

const [workdir] = process.argv.slice(2);
const read = async (f, fallback) => { try { return JSON.parse(await fs.readFile(path.join(workdir, f), 'utf8')); } catch { return fallback; } };
const manifest = await read('manifest.json');
const sheets = await read('sheets.json');
const legend = { ...emptyLegend(), ...(await read('legend.json', {})) };
const doc = await read('doc.json', {});
legend.found = sheets.some((s) => s.sheet_type === 'legend');
const legendJson = JSON.stringify(compactLegend(legend));
const drawingsList = sheets.map((s) => `- ${s.drawing_no || '(번호 미상)'}: ${s.title || ''} [${s.sheet_type}] (file ${s.file_index}, page ${s.page})`).join('\n');

await fs.mkdir(path.join(workdir, 'prompts'), { recursive: true });
await fs.mkdir(path.join(workdir, 'out'), { recursive: true });
const texts = await Promise.all(manifest.files.map(async (f) => extractPdfText(await fs.readFile(f.path))));
let n = 0;
for (const s of sheets.filter((x) => x.sheet_type === 'pid')) {
  const meta = manifest.pages.find((p) => p.file_index === s.file_index && p.page === s.page);
  const pg = texts[s.file_index].pages[s.page - 1];
  const imageNote = `\nImages to look at (open each file; normalized page ranges): ${meta.images.map((im, i) => `image ${i + 1} = ${im.path} (${im.kind}, x ${im.range[0]}-${im.range[2]}, y ${im.range[1]}-${im.range[3]})`).join('; ')}. Coordinates you return are always for the whole page.`;
  const label = `${s.drawing_no || '(drawing no. unknown)'}${s.title ? ` "${s.title}"` : ''} = file ${s.file_index} ("${manifest.files[s.file_index].name}") page ${s.page}`;
  const out = path.join(workdir, 'out', `f${s.file_index}-p${s.page}.json`);
  const prompt = sheetPrompt({ sheetLabel: label, legendJson, drawingsList, textLayer: pageTextForPrompt(pg, 150_000), hasTextLayer: pg.runs.length > 0 && doc.doc_type !== 'pfd', imageNote, docNote: doc.note || '' })
    + `\n\nSave ONLY that JSON object (UTF-8, no Markdown fences) to: ${out}`;
  await fs.writeFile(path.join(workdir, 'prompts', `f${s.file_index}-p${s.page}.txt`), prompt);
  n++;
}
console.log(`prompts ${n} → ${path.join(workdir, 'prompts')}`);
