import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { extractPdfText } from './pdfText.js';
import { analyzeWithClaude, AnalysisError, isApiConfigured, MODEL } from './analyzer.js';
import { postprocess } from './postprocess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
// Claude API 요청 한도(32MB)를 고려한 원본 PDF 총 용량 제한 (base64 인코딩 시 약 4/3배)
const MAX_TOTAL_BYTES = 22 * 1024 * 1024;
const MAX_TOTAL_PAGES = 100;
const SAMPLE_FILES = ['PID-100-000.pdf', 'PID-100-001.pdf', 'PID-100-002.pdf'];

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TOTAL_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)),
});

app.use(express.static(path.join(ROOT, 'public')));
const vendor = (route, file) => app.get(route, (_req, res) => res.sendFile(path.join(ROOT, 'node_modules', file)));
vendor('/vendor/cytoscape.min.js', 'cytoscape/dist/cytoscape.min.js');
vendor('/vendor/cytoscape-dagre.js', 'cytoscape-dagre/dist/cytoscape-dagre.js');
vendor('/vendor/pdf.min.mjs', 'pdfjs-dist/legacy/build/pdf.min.mjs');
vendor('/vendor/pdf.worker.min.mjs', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs');
app.use('/samples', express.static(path.join(ROOT, 'samples'), { index: false }));

app.get('/api/status', (_req, res) => {
  res.json({ apiConfigured: isApiConfigured(), model: MODEL, limits: { maxTotalMB: MAX_TOTAL_BYTES / 1048576, maxPages: MAX_TOTAL_PAGES } });
});

/** API 키 없이 UI를 확인할 수 있도록 샘플 도면 + 미리 준비된 분석 결과를 후처리해 반환 */
app.get('/api/demo', async (_req, res, next) => {
  try {
    const files = [];
    for (const name of SAMPLE_FILES) {
      const buf = await fs.readFile(path.join(ROOT, 'samples', name));
      files.push({ name, text: await extractPdfText(buf) });
    }
    const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'samples', 'demo-analysis.json'), 'utf8'));
    res.json({ ...postprocess(raw, files), sampleUrls: SAMPLE_FILES.map((n) => `/samples/${n}`), meta: { demo: true } });
  } catch (err) {
    next(err);
  }
});

/**
 * PDF 분석. 응답은 NDJSON 스트림:
 *   {"type":"progress", ...}* → {"type":"result","data":{...}} | {"type":"error","message":"..."}
 */
app.post('/api/analyze', upload.array('files'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);

  try {
    const uploaded = req.files || [];
    if (uploaded.length === 0) throw new AnalysisError('PDF 파일을 1개 이상 선택해 주세요.');
    if (!isApiConfigured()) throw new AnalysisError('서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. 환경 변수를 설정한 뒤 서버를 다시 시작하세요. (샘플 데모는 키 없이 확인 가능)');
    const total = uploaded.reduce((a, f) => a + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      throw new AnalysisError(`PDF 총 용량이 ${(total / 1048576).toFixed(1)}MB로 한도(${MAX_TOTAL_BYTES / 1048576}MB)를 넘습니다. 도면을 나누어 분석해 주세요.`);
    }

    send({ type: 'progress', stage: 'extract', message: 'PDF 텍스트 레이어 추출 중...' });
    const files = [];
    for (const f of uploaded) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      let text;
      try {
        text = await extractPdfText(f.buffer);
      } catch {
        throw new AnalysisError(`"${name}" 파일을 PDF로 읽을 수 없습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.`);
      }
      files.push({ name, buffer: f.buffer, text });
    }
    const pages = files.reduce((a, f) => a + f.text.pageCount, 0);
    if (pages > MAX_TOTAL_PAGES) throw new AnalysisError(`총 ${pages}페이지로 한 번에 분석 가능한 ${MAX_TOTAL_PAGES}페이지를 초과합니다.`);

    send({ type: 'progress', stage: 'analyze', message: `Claude가 ${files.length}개 파일 / ${pages}페이지를 분석 중입니다...` });
    const { raw, meta } = await analyzeWithClaude(files, (p) => send({ type: 'progress', ...p }));

    send({ type: 'progress', stage: 'validate', message: '연결성 검증 및 위치 보정 중...' });
    const result = postprocess(raw, files);
    send({ type: 'result', data: { ...result, meta } });
  } catch (err) {
    let message;
    if (err instanceof AnalysisError) message = err.message;
    else if (err instanceof Anthropic.AuthenticationError) message = 'API 키가 유효하지 않습니다.';
    else if (err instanceof Anthropic.RateLimitError) message = 'API 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.';
    else if (err instanceof Anthropic.BadRequestError) message = `요청 오류: ${err.message}`;
    else if (err instanceof Anthropic.APIError) message = `Claude API 오류 (${err.status ?? 'network'}): ${err.message}`;
    else {
      console.error(err);
      message = `서버 오류: ${err.message}`;
    }
    send({ type: 'error', message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err instanceof multer.MulterError ? 400 : 500;
  const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
    ? `파일 하나의 크기가 ${MAX_TOTAL_BYTES / 1048576}MB를 넘습니다.`
    : err.message;
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`P&ID Review 서버: http://localhost:${PORT}`);
  if (!isApiConfigured()) console.log('※ ANTHROPIC_API_KEY 미설정 - 샘플 데모만 사용 가능합니다.');
});
