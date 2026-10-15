// 브라우저에서 Claude(claude.ai 아티팩트의 sample 기능, 사용자 계정 사용량)로 P&ID를 분석한다.
// 순서: 텍스트 레이어 추출 → 시트 분류 → 범례 판독 → P&ID 시트별 판독 → 병합 → 후처리(공용 검증 로직)
import { extractTextFromDocument, pageTextForPrompt, normalizeTag } from './shared/pidText.js';
import { classifyPrompt, legendPrompt, sheetPrompt } from './shared/prompts.js';
import { postprocess } from './shared/postprocess.js';

const PROMPT_TEXT_BUDGET = 150_000; // 한 번의 호출에 넣을 텍스트 레이어 최대 글자 수 (입력 한도 256KiB)
const TILE_LONG_SIDE = 1400; // 분할 이미지 한 장의 긴 변 (플랫폼이 약 1.2MP로 줄임)
const LEGEND_WORDS = /LEGEND|SYMBOL|ABBREVIATION|범례|기호|약어/i;

export class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {Array<{name:string, buffer:ArrayBuffer}>} opts.files
 * @param {Function} opts.sample  claude.use("sample") 결과
 * @param {object} opts.pdfjs      pdf.js 모듈 (getDocument, Util)
 * @param {(msg:string)=>void} opts.onProgress
 * @param {AbortSignal} opts.signal
 */
export async function analyzeInBrowser({ files, sample, pdfjs, onProgress, signal }) {
  const limits = await sample.limits().catch(() => null);
  const maxImages = limits?.images?.maxCount ?? 0;

  // 1) PDF 열기 + 텍스트 레이어
  onProgress('PDF 텍스트 레이어를 추출하는 중...');
  const docs = [];
  const tasks = [];
  const texts = [];
  for (const f of files) {
    let doc;
    try {
      const task = pdfjs.getDocument({ data: f.buffer.slice(0), isEvalSupported: false });
      tasks.push(task);
      doc = await task.promise;
    } catch {
      for (const t of tasks) t.destroy();
      throw new EngineError(`"${f.name}" 파일을 PDF로 읽을 수 없습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.`);
    }
    docs.push(doc);
    texts.push(await extractTextFromDocument(doc, pdfjs.Util));
  }
  const pages = [];
  texts.forEach((t, fi) => t.pages.forEach((pg) => pages.push({ file_index: fi, page: pg.page, pg })));
  const ask = (input, images, tier = 'complex') => callJson(sample, input, { images, modelTier: tier, signal });

  try {
    // 2) 시트 분류
    onProgress(`시트 ${pages.length}장의 종류(범례/P&ID)를 판별하는 중...`);
    const sheets = await classify(pages, files, docs, ask, maxImages);

    // 3) 범례
    const legendSheets = sheets.filter((s) => s.sheet_type === 'legend');
    const legend = emptyLegend();
    for (const [i, s] of legendSheets.entries()) {
      onProgress(`범례 시트 ${i + 1}/${legendSheets.length} (${s.drawing_no || `${files[s.file_index].name} p.${s.page}`})를 읽는 중...`);
      const { blobs, note } = await pageImages(docs[s.file_index], s.page, maxImages);
      const part = await ask(legendPrompt({
        sheetLabel: sheetLabel(s, files),
        textLayer: pageTextForPrompt(texts[s.file_index].pages[s.page - 1], PROMPT_TEXT_BUDGET),
        imageNote: note,
      }), blobs);
      mergeLegend(legend, part, s);
    }
    legend.found = legendSheets.length > 0;

    // 4) P&ID 시트별 판독
    const pidSheets = sheets.filter((s) => s.sheet_type === 'pid');
    if (!pidSheets.length) throw new EngineError('입력된 PDF에서 P&ID 시트를 찾지 못했습니다. 범례나 표지만 들어 있는지 확인하세요.');
    const drawingsList = sheets.map((s) => `- ${s.drawing_no || '(번호 미상)'}: ${s.title || ''} [${s.sheet_type}] (file ${s.file_index} "${files[s.file_index].name}", page ${s.page})`).join('\n');
    const legendJson = JSON.stringify(compactLegend(legend));
    const parts = [];
    for (const [i, s] of pidSheets.entries()) {
      onProgress(`P&ID 시트 ${i + 1}/${pidSheets.length} (${s.drawing_no || `${files[s.file_index].name} p.${s.page}`})를 분석하는 중... 시트당 1~3분 걸릴 수 있습니다.`);
      const { blobs, note } = await pageImages(docs[s.file_index], s.page, maxImages);
      const out = await ask(sheetPrompt({
        sheetLabel: sheetLabel(s, files),
        legendJson,
        drawingsList,
        textLayer: pageTextForPrompt(texts[s.file_index].pages[s.page - 1], PROMPT_TEXT_BUDGET - legendJson.length),
        imageNote: note,
      }), blobs);
      parts.push({ sheet: s, out });
    }

    // 5) 병합 + 후처리
    onProgress('연결성 검증 및 위치 보정 중...');
    const raw = mergeSheets(sheets, legend, parts);
    const result = postprocess(raw, files.map((f, i) => ({ name: f.name, text: texts[i] })));
    result.meta = { engine: 'claude.ai', sheets: sheets.length };
    return result;
  } finally {
    for (const t of tasks) t.destroy();
  }
}

// ---------------------------------------------------------------- Claude 호출

async function callJson(sample, input, { images, modelTier, signal }) {
  const opts = { modelTier, signal, cache: false };
  if (images?.length) opts.images = images;
  try {
    return await sample.json(input, opts);
  } catch (e) {
    throw new EngineError(sampleErrorMessage(e), e?.code);
  }
}

export function sampleErrorMessage(e) {
  switch (e?.code) {
    case 'cancelled': return '분석을 중지했습니다.';
    case 'not_granted': return 'Claude 사용이 허용되지 않았습니다. 페이지를 새로고침한 뒤 허용을 선택해 주세요.';
    case 'sampling_disabled': return '이 계정 또는 조직에서는 Claude 분석을 사용할 수 없습니다.';
    case 'rate_limited': return 'Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
    case 'session_expired': return 'claude.ai 로그인이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.';
    case 'prompt_too_large': return '도면 텍스트가 너무 많아 한 번에 보낼 수 없습니다. 시트를 나누어 분석해 주세요.';
    case 'image_rejected': return '도면 이미지를 보낼 수 없습니다. 페이지 크기가 지나치게 크지 않은지 확인하세요.';
    case 'images_unavailable': return '이 화면에서는 도면 이미지를 보낼 수 없습니다.';
    case 'refused': return 'Claude가 이 도면의 분석을 거절했습니다.';
    case 'invalid_json': return '분석 결과를 해석하지 못했습니다(도면 정보가 많아 결과가 잘렸을 수 있습니다). 다시 시도하거나 시트를 나누어 분석해 주세요.';
    case 'empty_completion': return 'Claude가 결과를 내지 않았습니다. 다시 시도해 주세요.';
    default: return `Claude 호출 중 오류가 발생했습니다${e?.code ? ` (${e.code})` : ''}. 다시 시도해 주세요.`;
  }
}

// ---------------------------------------------------------------- 시트 분류

async function classify(pages, files, docs, ask, maxImages) {
  // 텍스트가 있는 페이지는 표제란(우하단)과 제목성 단어로 판별, 없는 페이지는 축소 이미지로 판별
  const imagePages = pages.filter((p) => !p.pg.runs.length).slice(0, maxImages);
  const snippets = pages.map((p) => {
    const tb = p.pg.runs.filter((r) => r.bbox[0] > 0.55 && r.bbox[1] > 0.7).map((r) => r.text);
    const heads = p.pg.runs.filter((r) => LEGEND_WORDS.test(r.text)).map((r) => r.text);
    const words = [...new Set([...tb, ...heads])].slice(0, 40).join(' / ').slice(0, 1500);
    const imgNo = imagePages.indexOf(p);
    const body = p.pg.runs.length ? words || '(no title block text)' : imgNo >= 0 ? `(no text layer - see image ${imgNo + 1})` : '(no text layer)';
    return `- file_index ${p.file_index} ("${files[p.file_index].name}"), page ${p.page}: ${body}`;
  }).join('\n');
  const blobs = [];
  for (const p of imagePages) blobs.push(await renderBlob(docs[p.file_index], p.page, 1000));

  const answer = await ask(classifyPrompt(snippets, blobs.length > 0), blobs, 'default');
  const list = Array.isArray(answer) ? answer : [];
  return pages.map((p) => {
    const a = list.find((x) => Number(x?.file_index) === p.file_index && Number(x?.page) === p.page) || {};
    let type = ['legend', 'pid', 'other'].includes(a.sheet_type) ? a.sheet_type : null;
    if (!type) type = p.pg.runs.some((r) => LEGEND_WORDS.test(r.text) && r.bbox[0] > 0.55 && r.bbox[1] > 0.7) ? 'legend' : 'pid';
    return { file_index: p.file_index, page: p.page, sheet_type: type, drawing_no: str(a.drawing_no), title: str(a.title), revision: str(a.revision) };
  });
}

const sheetLabel = (s, files) => `${s.drawing_no || '(drawing no. unknown)'}${s.title ? ` "${s.title}"` : ''} = file ${s.file_index} ("${files[s.file_index].name}") page ${s.page}`;

// ---------------------------------------------------------------- 도면 이미지

/** 페이지 전체 1장 + (가능하면) 겹치게 자른 4분할 이미지 */
async function pageImages(doc, pageNo, maxImages) {
  if (maxImages < 1) return { blobs: [], note: '\nNo images are attached; rely on the text layer.' };
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const landscape = vp1.width >= vp1.height;
  const grid = maxImages >= 5 ? [2, 2] : maxImages >= 3 ? (landscape ? [2, 1] : [1, 2]) : [1, 1];
  const [cols, rows] = grid;
  // 분할 이미지 한 장이 TILE_LONG_SIDE가 되도록 전체를 렌더링
  const scale = (TILE_LONG_SIDE * Math.max(cols, rows)) / Math.max(vp1.width, vp1.height);
  const canvas = document.createElement('canvas');
  const vp = page.getViewport({ scale });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

  const blobs = [await toBlob(downscale(canvas, 1600))];
  const names = [];
  if (cols * rows > 1) {
    const ov = 0.06; // 경계의 글자가 잘리지 않도록 겹침
    const tw = canvas.width / cols, th = canvas.height / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, (c - ov) * tw), y0 = Math.max(0, (r - ov) * th);
        const x1 = Math.min(canvas.width, (c + 1 + ov) * tw), y1 = Math.min(canvas.height, (r + 1 + ov) * th);
        const tile = document.createElement('canvas');
        tile.width = Math.round(x1 - x0);
        tile.height = Math.round(y1 - y0);
        tile.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, tile.width, tile.height);
        blobs.push(await toBlob(tile));
        names.push(`image ${blobs.length}: x ${(x0 / canvas.width).toFixed(2)}-${(x1 / canvas.width).toFixed(2)}, y ${(y0 / canvas.height).toFixed(2)}-${(y1 / canvas.height).toFixed(2)}`);
      }
    }
  }
  page.cleanup();
  const note = names.length
    ? `\nImages: image 1 is the whole sheet; the others are enlarged parts of it (normalized page ranges): ${names.join('; ')}. Coordinates you return are always for the whole page.`
    : '\nImage 1 is the whole sheet.';
  return { blobs, note };
}

async function renderBlob(doc, pageNo, longSide) {
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: longSide / Math.max(vp1.width, vp1.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
  page.cleanup();
  return toBlob(canvas);
}

function downscale(canvas, longSide) {
  const k = longSide / Math.max(canvas.width, canvas.height);
  if (k >= 1) return canvas;
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new EngineError('도면 이미지를 만들지 못했습니다.'))), 'image/jpeg', 0.88));

// ---------------------------------------------------------------- 병합

function emptyLegend() {
  return { found: false, pages: [], line_number_format: '', fluid_codes: [], piping_classes: [], equipment_codes: [], instrument_letters: [], symbols: [], notes: '' };
}

function mergeLegend(legend, part, sheet) {
  legend.pages.push({ file_index: sheet.file_index, page: sheet.page });
  if (!part || typeof part !== 'object') return;
  if (!legend.line_number_format && part.line_number_format) legend.line_number_format = str(part.line_number_format);
  for (const key of ['fluid_codes', 'piping_classes', 'equipment_codes', 'instrument_letters', 'symbols']) {
    for (const e of Array.isArray(part[key]) ? part[key] : []) {
      const code = str(e?.code), description = str(e?.description);
      if (!code && !description) continue;
      if (!legend[key].some((x) => normalizeTag(x.code) === normalizeTag(code) && x.description === description)) legend[key].push({ code, description });
    }
  }
  if (part.notes) legend.notes = [legend.notes, str(part.notes)].filter(Boolean).join('\n');
}

const compactLegend = (lg) => (lg.found ? {
  line_number_format: lg.line_number_format, fluid_codes: lg.fluid_codes, piping_classes: lg.piping_classes,
  equipment_codes: lg.equipment_codes, instrument_letters: lg.instrument_letters, symbols: lg.symbols,
} : {});

/** 시트별 결과를 한 세트로 합친다 (postprocess가 받는 형식) */
export function mergeSheets(sheets, legend, parts) {
  const drawings = sheets.map((s) => {
    const d = parts.find((p) => p.sheet === s)?.out?.drawing || {};
    return {
      file_index: s.file_index, page: s.page, sheet_type: s.sheet_type,
      drawing_no: s.drawing_no || str(d.drawing_no), title: s.title || str(d.title), revision: s.revision || str(d.revision),
    };
  });
  const nodes = [], lines = [], issues = [], summaries = [];
  const seenEquipment = new Map(); // 여러 시트에 걸쳐 그려진 같은 설비는 하나로
  for (const { sheet, out } of parts) {
    if (!out || typeof out !== 'object') continue;
    const loc = (bbox) => ({ file_index: sheet.file_index, page: sheet.page, bbox: Array.isArray(bbox) ? bbox : null });
    const alias = new Map();
    for (const n of Array.isArray(out.nodes) ? out.nodes : []) {
      const key = n?.category === 'equipment' ? normalizeTag(n.tag) : '';
      const prev = key && seenEquipment.get(key);
      if (prev && prev.sheet !== sheet) {
        alias.set(str(n.id), prev.node.id);
        for (const sp of Array.isArray(n.specs) ? n.specs : []) {
          if (!prev.node.specs.some((x) => x.name === sp?.name)) prev.node.specs.push(sp);
        }
        continue;
      }
      const node = { ...n, specs: Array.isArray(n.specs) ? n.specs : [], loc: loc(n.bbox) };
      delete node.bbox;
      nodes.push(node);
      if (key) seenEquipment.set(key, { sheet, node });
    }
    const re = (id) => alias.get(str(id)) ?? str(id);
    for (const l of Array.isArray(out.lines) ? out.lines : []) {
      const line = { ...l, from_id: re(l.from_id), to_id: re(l.to_id), loc: loc(l.bbox) };
      delete line.bbox;
      lines.push(line);
    }
    for (const x of Array.isArray(out.issues) ? out.issues : []) {
      const iss = { ...x, related_ids: (Array.isArray(x.related_ids) ? x.related_ids : []).map(re), loc: loc(x.bbox) };
      delete iss.bbox;
      issues.push(iss);
    }
    if (out.sheet_summary) summaries.push(`${drawings.find((d) => d.file_index === sheet.file_index && d.page === sheet.page)?.drawing_no || ''} ${str(out.sheet_summary)}`.trim());
  }
  return { summary: summaries.join(' '), legend, drawings, nodes, lines, issues };
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
