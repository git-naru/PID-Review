// 서버용 PDF 텍스트 추출: pdfjs-dist(legacy, Node)로 문서를 열어 공용 추출 로직에 넘긴다.
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextFromDocument } from '../shared/pidText.js';

export { normalizeTag, textLayerForPrompt, findTagOnPages, findAllTagBoxes } from '../shared/pidText.js';

/** PDF 버퍼 하나의 텍스트 레이어를 추출한다. */
export async function extractPdfText(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    return await extractTextFromDocument(await loadingTask.promise, Util);
  } finally {
    await loadingTask.destroy();
  }
}
