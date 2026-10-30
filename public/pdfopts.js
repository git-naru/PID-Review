// pdf.js 문서 열기 옵션: 이미지 디코더(JBIG2·JPEG2000 wasm)를 페이지 안 모듈에서 꺼내 준다.
// 도면 안 스트림 표가 JBIG2 그림으로 들어 있는 PDF(예: POSCO CP3 PFD)는 이것이 없으면 표가 그려지지 않는다.
// wasm은 vendor/pdf-wasm.js(base64)로 두어 아티팩트·로컬 서버·단일 HTML에서 같은 방법으로 읽는다.
let wasm = null;

class WasmData {
  async fetch({ kind, filename }) {
    if (kind !== 'wasmUrl') throw new Error(`${kind} 데이터는 제공하지 않습니다.`);
    wasm ||= import('./vendor/pdf-wasm.js').then((m) => m.default);
    const b64 = (await wasm)[filename];
    if (!b64) throw new Error(`${filename} 없음`);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

export const PDF_OPTIONS = { BinaryDataFactory: WasmData, useWorkerFetch: false };
