// pdf.js 이미지 디코더(wasm)를 base64로 담은 ES 모듈 소스를 만든다.
// 도면 안의 표·스캔 그림이 JBIG2나 JPEG2000 이미지면 이것이 있어야 화면에 그려진다.
// 아티팩트·로컬 서버·단일 HTML이 같은 모듈(vendor/pdf-wasm.js)을 쓴다 (public/pdfopts.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['jbig2.wasm', 'openjpeg.wasm'];

export async function pdfWasmModuleSource() {
  const map = {};
  for (const f of FILES) map[f] = (await fs.readFile(path.join(ROOT, 'node_modules/pdfjs-dist/wasm', f))).toString('base64');
  return `// 자동 생성 (scripts/pdf-wasm.mjs): pdf.js 이미지 디코더 wasm, base64\nexport default ${JSON.stringify(map)};\n`;
}
