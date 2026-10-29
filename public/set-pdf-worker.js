// 단일 HTML(오프라인) 빌드 전용: pdf.js 작업 코드를 같은 스크립트 안에 넣어 별도 워커 파일 없이 동작하게 한다.
// (PC에서 파일로 연 페이지는 워커 파일을 불러올 수 없을 수 있다)
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

globalThis.pdfjsWorker = pdfjsWorker;
