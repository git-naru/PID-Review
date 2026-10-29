// 분석 결과와 도면 PDF를 모두 넣은 단일 HTML(보기 전용)을 만든다. 서버·인터넷 없이 PC에서 열어 볼 수 있다.
// 사용법: node scripts/build-standalone.mjs <result.json> <pdf-dir> <out.html>
//   pdf-dir 안에서 result.files[i].name과 같은 이름의 PDF를 찾는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [resultPath, pdfDir, outPath] = process.argv.slice(2);
if (!resultPath || !pdfDir || !outPath) {
  console.error('usage: node scripts/build-standalone.mjs <result.json> <pdf-dir> <out.html>');
  process.exit(1);
}

// 1) 프로그램 번들: pdf.js 작업 코드 → 앱 순서로 한 스크립트에
const resolvePaths = {
  name: 'pid-paths',
  setup(build) {
    build.onResolve({ filter: /^\.\/vendor\/pdf\.min\.mjs$/ }, () => ({ path: path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs') }));
    build.onResolve({ filter: /^\.\/shared\// }, (a) => ({ path: path.join(ROOT, a.path) }));
  },
};
const bundle = await esbuild.build({
  stdin: { contents: "import './set-pdf-worker.js';\nimport './app.js';\n", resolveDir: path.join(ROOT, 'public'), loader: 'js' },
  bundle: true, format: 'esm', minify: true, write: false, plugins: [resolvePaths], logLevel: 'warning',
  // 번들 안에는 별도 파일이 없으므로 문서 주소를 기준으로 삼는다 (pdf.js 워커는 set-pdf-worker.js가 대신한다)
  define: { 'import.meta.url': 'document.baseURI' },
});
const appJs = bundle.outputFiles[0].text;

// 2) 데이터: 결과 + 도면(base64)
const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const pdfs = [];
for (const f of result.files) {
  pdfs.push((await fs.readFile(path.join(pdfDir, f.name))).toString('base64'));
}
const data = JSON.stringify({ result, pdfs }).replace(/<\//g, '<\\/');

// 3) 페이지: 스타일·스크립트를 모두 인라인
const noClose = (code) => code.replace(/<\/script/gi, '<\\/script');
const html = await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8');
const css = await fs.readFile(path.join(ROOT, 'public/styles.css'), 'utf8');
const cy = await fs.readFile(path.join(ROOT, 'node_modules/cytoscape/dist/cytoscape.min.js'), 'utf8');
const cyDagre = await fs.readFile(path.join(ROOT, 'node_modules/cytoscape-dagre/dist/cytoscape-dagre.js'), 'utf8');
const title = `P&amp;ID Review — ${result.files.length}개 도면 분석 결과`;
let page = html
  .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}</style>`)
  .replace('<script src="vendor/cytoscape.min.js"></script>', () => `<script>${noClose(cy)}</script>`)
  .replace('<script src="vendor/cytoscape-dagre.js"></script>', () => `<script>${noClose(cyDagre)}</script>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script type="application/json" id="pid-static">${data}</script>\n  <script type="module">${noClose(appJs)}</script>`);
for (const needle of ['href="styles.css"', 'src="vendor/', 'src="app.js"']) {
  if (page.includes(needle)) throw new Error(`인라인 처리되지 않은 참조: ${needle}`);
}
await fs.writeFile(outPath, page);
console.log(`${outPath} (${(page.length / 1048576).toFixed(1)} MB, 도면 ${pdfs.length}개)`);
