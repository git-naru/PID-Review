// 채팅 세션 분석 1단계: 업로드된 PDF의 텍스트 레이어 추출 + 판독용 이미지 렌더링 + 시트 분류용 요약.
// 사용법: node scripts/session/prepare.mjs <workdir> <files.json>
//   files.json: [{"name": "...", "path": "/abs/path.pdf", "assetId": "..."}]  (분석 요청 순서 = file_index)
// 출력: <workdir>/manifest.json, <workdir>/classify.txt, <workdir>/img/*.jpg
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../../server/pdfText.js';
import { classifyPrompt } from '../../shared/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGEND_WORDS = /LEGEND|SYMBOL|ABBREVIATION|범례|기호|약어/i;
const [workdir, filesJson] = process.argv.slice(2);
if (!workdir || !filesJson) {
  console.error('usage: node scripts/session/prepare.mjs <workdir> <files.json>');
  process.exit(1);
}

const files = JSON.parse(await fs.readFile(filesJson, 'utf8'));
await fs.mkdir(path.join(workdir, 'img'), { recursive: true });
const manifest = { files: [], pages: [] };
for (const [fi, f] of files.entries()) {
  const text = await extractPdfText(await fs.readFile(f.path));
  const rendered = JSON.parse(execFileSync('python3', [path.join(HERE, 'render_pages.py'), f.path, String(fi), path.join(workdir, 'img')], { maxBuffer: 64 << 20 }).toString());
  manifest.files.push({ index: fi, name: f.name, path: f.path, assetId: f.assetId, pageCount: text.pageCount });
  for (const pg of text.pages) {
    const tb = pg.runs.filter((r) => r.bbox[0] > 0.55 && r.bbox[1] > 0.7).map((r) => r.text);
    const heads = pg.runs.filter((r) => LEGEND_WORDS.test(r.text)).map((r) => r.text);
    manifest.pages.push({
      file_index: fi, page: pg.page, width: pg.width, height: pg.height,
      text_runs: pg.runs.length,
      title_block: [...new Set([...tb, ...heads])].slice(0, 40).join(' / ').slice(0, 1500),
      images: rendered.find((r) => r.page === pg.page)?.images || [],
    });
  }
}
await fs.writeFile(path.join(workdir, 'manifest.json'), JSON.stringify(manifest, null, 1));
const snippets = manifest.pages.map((p) => `- file_index ${p.file_index} ("${manifest.files[p.file_index].name}"), page ${p.page}: ${p.text_runs ? p.title_block || '(no title block text)' : `(no text layer - see ${p.images[0]?.path})`}`).join('\n');
await fs.writeFile(path.join(workdir, 'classify.txt'), classifyPrompt(snippets, false));
console.log(`files ${manifest.files.length}, pages ${manifest.pages.length}, scanned pages ${manifest.pages.filter((p) => !p.text_runs).length}`);
console.log(`→ ${path.join(workdir, 'manifest.json')}\n→ ${path.join(workdir, 'classify.txt')}`);
