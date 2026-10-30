// 분석 결과와 도면 PDF를 모두 넣은 단일 HTML(보기 전용)을 만든다. 서버·인터넷 없이 PC에서 열어 볼 수 있다.
// 사용법: node scripts/build-standalone.mjs <result.json> <pdf-dir> <out.html> [공정 단위-도면 종류, 예: BL2U-PFD]
//         node scripts/build-standalone.mjs --multi <out.html> <묶음 키> <result.json> <pdf-dir> [<묶음 키> <result.json> <pdf-dir> ...]
//   pdf-dir 안에서 result.files[i].name과 같은 이름의 PDF를 찾는다.
//   --multi: 여러 묶음(BL3U-PFD, BL2U-PID 등)을 한 파일에 넣고, 공정 단위·PFD / P&ID 선택으로 바꿔 본다. 처음엔 첫 묶음이 열린다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { pdfWasmModuleSource } from './pdf-wasm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let outPath, bundleArgs;
if (argv[0] === '--multi') {
  outPath = argv[1];
  bundleArgs = [];
  if ((argv.length - 2) % 3 === 0) {
    for (let i = 2; i < argv.length; i += 3) bundleArgs.push({ slot: argv[i], resultPath: argv[i + 1], pdfDir: argv[i + 2] });
  }
} else {
  const [resultPath, pdfDir, out, slot = ''] = argv;
  outPath = out;
  bundleArgs = resultPath && pdfDir ? [{ slot, resultPath, pdfDir }] : [];
}
if (!outPath || !bundleArgs.length) {
  console.error('usage: node scripts/build-standalone.mjs <result.json> <pdf-dir> <out.html> [BL2U-PFD]\n       node scripts/build-standalone.mjs --multi <out.html> <slot> <result.json> <pdf-dir> [...]');
  process.exit(1);
}

// 1) 프로그램 번들: pdf.js 작업 코드 → 앱 순서로 한 스크립트에
const resolvePaths = {
  name: 'pid-paths',
  setup(build) {
    build.onResolve({ filter: /^\.\/vendor\/pdf\.min\.mjs$/ }, () => ({ path: path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs') }));
    build.onResolve({ filter: /^\.\/shared\// }, (a) => ({ path: path.join(ROOT, a.path) }));
    build.onResolve({ filter: /^\.\/vendor\/pdf-wasm\.js$/ }, () => ({ path: 'pdf-wasm', namespace: 'pid-wasm' }));
    build.onLoad({ filter: /.*/, namespace: 'pid-wasm' }, async () => ({ contents: await pdfWasmModuleSource(), loader: 'js' }));
  },
};
const bundle = await esbuild.build({
  stdin: { contents: "import './set-pdf-worker.js';\nimport './app.js';\n", resolveDir: path.join(ROOT, 'public'), loader: 'js' },
  bundle: true, format: 'esm', minify: true, write: false, plugins: [resolvePaths], logLevel: 'warning',
  // 번들 안에는 별도 파일이 없으므로 문서 주소를 기준으로 삼는다 (pdf.js 워커는 set-pdf-worker.js가 대신한다)
  define: { 'import.meta.url': 'document.baseURI' },
});
const appJs = bundle.outputFiles[0].text;

// 2) 데이터: 묶음마다 결과(JSON) + 도면(base64). 도면은 PDF마다 따로 <script type="text/plain">에 넣는다.
//    큰 JSON 하나로 넣으면 여는 데 수십 초가 걸리고, 페이지는 보는 묶음의 도면만 풀어 쓴다.
const bundles = [];
const pdfTags = [];
for (const [bi, b] of bundleArgs.entries()) {
  const result = JSON.parse(await fs.readFile(b.resultPath, 'utf8'));
  const pdfIds = [];
  for (const [fi, f] of result.files.entries()) {
    const id = `pid-pdf-${bi}-${fi}`;
    pdfIds.push(id);
    pdfTags.push(`<script type="text/plain" id="${id}">${(await fs.readFile(path.join(b.pdfDir, f.name))).toString('base64')}</script>`);
  }
  bundles.push({ slot: b.slot.toUpperCase(), result, pdfIds });
}
const data = JSON.stringify({ bundles }).replace(/<\//g, '<\\/');
const fileCount = bundles.reduce((n, b) => n + b.pdfIds.length, 0);

// 3) 페이지: 스타일·스크립트를 모두 인라인
const noClose = (code) => code.replace(/<\/script/gi, '<\\/script');
const html = await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8');
const css = await fs.readFile(path.join(ROOT, 'public/styles.css'), 'utf8');
const cy = await fs.readFile(path.join(ROOT, 'node_modules/cytoscape/dist/cytoscape.min.js'), 'utf8');
const cyDagre = await fs.readFile(path.join(ROOT, 'node_modules/cytoscape-dagre/dist/cytoscape-dagre.js'), 'utf8');
// pdf.js 워커 코드: 페이지가 이 글을 Blob으로 만들어 별도 워커로 띄운다 (set-pdf-worker.js).
// 파일로 연 페이지에서는 모듈 워커를 띄울 수 없어(origin "null") 일반 스크립트(iife)로 바꿔 넣는다.
const pdfWorker = (await esbuild.build({
  entryPoints: [path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs')],
  bundle: true, format: 'iife', globalName: 'pdfjsWorkerModule', minify: true, write: false, logLevel: 'error',
  define: { 'import.meta.url': 'self.location.href' },
})).outputFiles[0].text;
const title = `P&amp;ID Review — ${fileCount}개 도면 분석 결과`;
let page = html
  .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}</style>`)
  .replace('<script src="vendor/cytoscape.min.js"></script>', () => `<script>${noClose(cy)}</script>`)
  .replace('<script src="vendor/cytoscape-dagre.js"></script>', () => `<script>${noClose(cyDagre)}</script>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script type="application/json" id="pid-static">${data}</script>\n  ${pdfTags.join('\n  ')}\n  <script type="text/plain" id="pid-pdf-worker">${noClose(pdfWorker)}</script>\n  <script type="module">${noClose(appJs)}</script>`);
for (const needle of ['href="styles.css"', 'src="vendor/', 'src="app.js"']) {
  if (page.includes(needle)) throw new Error(`인라인 처리되지 않은 참조: ${needle}`);
}
await fs.writeFile(outPath, page);
console.log(`${outPath} (${(page.length / 1048576).toFixed(1)} MB, ${bundles.map((b) => `${b.slot || '기본'} 도면 ${b.pdfIds.length}개`).join(', ')})`);
