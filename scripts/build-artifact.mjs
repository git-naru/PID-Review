// claude.ai 아티팩트로 올릴 정적 번들 두 가지를 만든다.
// - dist/artifact      : 페이지가 사용자 계정의 Claude(sample 기능)로 직접 분석
// - dist/artifact-chat : 페이지는 도면 업로드·결과 보기만, 분석은 Claude Code 채팅 세션 (assets + db 기능)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../server/pdfText.js';
import { postprocess } from '../shared/postprocess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'artifact');
const SAMPLE_FILES = ['PID-100-000.pdf', 'PID-100-001.pdf', 'PID-100-002.pdf'];

const copy = async (from, to) => {
  await fs.mkdir(path.dirname(path.join(OUT, to)), { recursive: true });
  await fs.copyFile(path.join(ROOT, from), path.join(OUT, to));
};

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

// 페이지: 아티팩트가 문서 골격(doctype/html/head/body)을 씌우므로 내용만 남긴다
const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/\s*<meta charset[^>]*>/, '')
  .replace(/\s*<meta name="viewport"[^>]*>/, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
// 스타일시트는 페이지에 인라인 (아티팩트 CSP는 외부 스타일시트를 Google Fonts만 허용)
const css = await fs.readFile(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const page = `${head.trim()}\n${body.trim()}\n`.replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}</style>`);
await fs.writeFile(path.join(OUT, 'index.html'), page);

for (const f of ['app.js', 'engine.js', 'chatmode.js', 'pidview.js']) await copy(`public/${f}`, f);
for (const f of await fs.readdir(path.join(ROOT, 'shared'))) await copy(`shared/${f}`, `shared/${f}`);
await copy('node_modules/cytoscape/dist/cytoscape.min.js', 'vendor/cytoscape.min.js');
await copy('node_modules/cytoscape-dagre/dist/cytoscape-dagre.js', 'vendor/cytoscape-dagre.js');
await copy('node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'vendor/pdf.min.mjs');
await copy('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'vendor/pdf.worker.min.mjs');

// 아티팩트는 제어 문자(ESC 등)가 들어간 텍스트 파일을 받지 않는다.
// 압축된 라이브러리 안의 제어 문자는 모두 문자열/정규식 리터럴 안에 있으므로 \xHH 이스케이프로 바꿔도 값이 같다.
for (const f of ['vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/cytoscape.min.js', 'vendor/cytoscape-dagre.js']) {
  const file = path.join(OUT, f);
  const src = await fs.readFile(file, 'utf8');
  // eslint-disable-next-line no-control-regex
  const out = src.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  if (out !== src) await fs.writeFile(file, out);
}

// 샘플 데모: 미리 만든 판독 결과를 서버와 같은 후처리로 검증해 정적 JSON으로 둔다
const files = [];
for (const name of SAMPLE_FILES) {
  await copy(`samples/${name}`, `samples/${name}`);
  files.push({ name, text: await extractPdfText(await fs.readFile(path.join(ROOT, 'samples', name))) });
}
await copy('samples/PID-100-MB.csv', 'samples/PID-100-MB.csv');
const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'samples', 'demo-analysis.json'), 'utf8'));
const demo = { ...postprocess(raw, files), sampleUrls: SAMPLE_FILES.map((n) => `samples/${n}`), meta: { demo: true } };
await fs.writeFile(path.join(OUT, 'demo-result.json'), JSON.stringify(demo));

// 채팅 분석용 변형: 같은 파일에 모드 표시만 다르다
const CHAT = path.join(ROOT, 'dist', 'artifact-chat');
await fs.rm(CHAT, { recursive: true, force: true });
await fs.cp(OUT, CHAT, { recursive: true });
const chatPage = page
  .replace('<title>P&amp;ID Review</title>', '<title>P&amp;ID 채팅 분석</title>\n  <meta name="pid-mode" content="chat" />');
if (chatPage === page) throw new Error('채팅 분석용 페이지를 만들지 못했습니다 (<title> 확인)');
await fs.writeFile(path.join(CHAT, 'index.html'), chatPage);

const list = [];
const walk = async (dir) => {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else list.push([path.relative(OUT, p), (await fs.stat(p)).size]);
  }
};
await walk(OUT);
for (const [p, size] of list.sort()) console.log(`${(size / 1024).toFixed(0).padStart(6)} KB  ${p}`);
