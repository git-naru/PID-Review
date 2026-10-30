// 단일 HTML(오프라인) 빌드 전용: 별도 워커 파일 없이 pdf.js를 동작하게 한다.
// (PC에서 파일로 연 페이지는 워커 파일을 불러올 수 없다)
// 파일 안에 넣어 둔 워커 코드(#pid-pdf-worker)로 별도 워커를 띄워, 도면을 읽고 해석하는 동안 화면이 멈추지 않게 한다.
// 워커가 "ready"를 보내면 그 워커를 쓰고(app.js가 workerPort로 지정), 못 띄우면 같은 스레드에서 처리한다.
// pdf.js에 워커 주소만 주면 파일로 연 페이지(origin "null")에서는 모듈 워커를 띄우지 못해 같은 스레드로 돌아간다.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

const code = document.getElementById('pid-pdf-worker')?.textContent;
if (code) {
  globalThis.pidPdfWorker = new Promise((resolve) => {
    let worker = null;
    const fail = () => {
      worker?.terminate();
      globalThis.pdfjsWorker = pdfjsWorker;
      resolve(null);
    };
    try {
      worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))); // 일반 워커 (빌드 때 iife로 바꿈)
    } catch {
      fail();
      return;
    }
    const timer = setTimeout(fail, 8000);
    worker.addEventListener('message', () => { clearTimeout(timer); resolve(worker); }, { once: true });
    worker.addEventListener('error', () => { clearTimeout(timer); fail(); }, { once: true });
  });
} else {
  globalThis.pdfjsWorker = pdfjsWorker;
}
