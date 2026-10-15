// 브라우저에서 Claude(claude.ai 아티팩트의 sample 기능, 사용자 계정 사용량)로 P&ID를 분석한다.
// 순서: 텍스트 레이어 추출 → 시트 분류 → 범례 판독 → P&ID 시트별 판독 → 병합 → 후처리(공용 검증 로직)
//
// 수십 장 규모의 도면 세트를 위해:
// - 시트 결과를 브라우저(IndexedDB)에 저장해, 멈추거나 실패해도 같은 파일로 다시 실행하면 이어서 분석한다.
// - 한 시트가 실패해도 전체를 멈추지 않는다. 결과가 길어 잘리면 시트를 둘로 나눠 다시 판독한다.
// - 사용 한도·권한 같은 계정 문제만 전체를 멈추고, 그때까지의 결과는 그대로 보여준다.
// - 두 시트씩 동시에 판독하고, 진행 중에도 완료된 시트까지의 결과를 화면에 반영한다.
import { extractTextFromDocument, pageTextForPrompt, normalizeTag } from './shared/pidText.js';
import { classifyPrompt, legendPrompt, sheetPrompt } from './shared/prompts.js';
import { postprocess } from './shared/postprocess.js';

const PROMPT_VERSION = 'v2'; // 프롬프트나 결과 형식이 바뀌면 올려서 이전 저장 결과를 쓰지 않게 한다
const PROMPT_TEXT_BUDGET = 150_000; // 한 번의 호출에 넣을 텍스트 레이어 최대 글자 수 (입력 한도 256KiB)
const TILE_LONG_SIDE = 1400; // 분할 이미지 한 장의 긴 변 (플랫폼이 약 1.2MP로 줄임)
const CONCURRENCY = 2; // 플랫폼은 열람자당 두어 건을 동시에 처리한다
const PARTIAL_EVERY_MS = 10_000;
const LEGEND_WORDS = /LEGEND|SYMBOL|ABBREVIATION|범례|기호|약어/i;

// 계정·권한 문제: 계속해도 모두 실패하므로 전체를 멈춘다
const FATAL = new Set(['cancelled', 'not_granted', 'sampling_disabled', 'session_expired', 'rate_limited',
  'not_declared', 'capability_disabled', 'capability_removed', 'images_unavailable', 'queue_overflow']);
// 결과가 길거나 입력이 커서 생기는 실패: 시트를 나누면 해결될 수 있다
const SPLITTABLE = new Set(['invalid_json', 'prompt_too_large', 'upstream_error', 'empty_completion', 'image_rejected']);

export class EngineError extends Error {
  constructor(message, code, partial = null) {
    super(message);
    this.code = code;
    this.partial = partial;
  }
}

/**
 * @param {object} opts
 * @param {Array<{name:string, buffer:ArrayBuffer}>} opts.files
 * @param {Function} opts.sample   claude.use("sample") 결과
 * @param {object} opts.pdfjs       pdf.js 모듈 (getDocument, Util)
 * @param {"complex"|"default"} [opts.tier]  정밀(complex) / 빠른(default) 판독
 * @param {(msg:string)=>void} opts.onProgress
 * @param {(result:object)=>void} [opts.onPartial]  진행 중 중간 결과
 * @param {AbortSignal} opts.signal
 */
export async function analyzeInBrowser({ files, sample, pdfjs, tier = 'complex', onProgress, onPartial = () => {}, signal }) {
  const limits = await sample.limits().catch(() => null);
  const maxImages = limits?.images?.maxCount ?? 0;
  const store = getStore();

  // 1) PDF 열기 + 텍스트 레이어
  onProgress('PDF 텍스트 레이어를 추출하는 중...');
  const docs = [];
  const tasks = [];
  const texts = [];
  try {
    for (const f of files) {
      const task = pdfjs.getDocument({ data: f.buffer.slice(0), isEvalSupported: false });
      tasks.push(task);
      let doc;
      try {
        doc = await task.promise;
      } catch {
        throw new EngineError(`"${f.name}" 파일을 PDF로 읽을 수 없습니다. 손상되었거나 암호가 걸린 파일인지 확인하세요.`);
      }
      docs.push(doc);
      texts.push(await extractTextFromDocument(doc, pdfjs.Util));
    }
    const fps = await Promise.all(files.map((f) => fingerprint(f)));
    const key = (kind, s = null, extra = '') => [PROMPT_VERSION, kind, tier, s ? `${fps[s.file_index]}:${s.page}` : fps.join(','), extra].join('|');
    const ask = (input, images, modelTier = tier) => callJson(sample, input, { images, modelTier, signal });
    const pageText = (s) => texts[s.file_index].pages[s.page - 1];

    // 2) 시트 분류 (저장된 결과가 있으면 재사용)
    const pages = [];
    texts.forEach((t, fi) => t.pages.forEach((pg) => pages.push({ file_index: fi, page: pg.page, pg })));
    let sheets = await store.get(key('classify'));
    if (!sheets) {
      onProgress(`시트 ${pages.length}장의 종류(범례/P&ID)를 판별하는 중...`);
      sheets = await classify(pages, files, docs, ask, maxImages);
      await store.set(key('classify'), sheets);
    }

    // 3) 범례
    const legendSheets = sheets.filter((s) => s.sheet_type === 'legend');
    const legend = emptyLegend();
    const failures = [];
    for (const [i, s] of legendSheets.entries()) {
      let part = await store.get(key('legend', s));
      if (!part) {
        onProgress(`범례 시트 ${i + 1}/${legendSheets.length} (${sheetName(s, files)})를 읽는 중...`);
        try {
          const { blobs, note } = await pageImages(docs[s.file_index], s.page, maxImages);
          part = await ask(legendPrompt({ sheetLabel: sheetLabel(s, files), textLayer: pageTextForPrompt(pageText(s), PROMPT_TEXT_BUDGET), imageNote: note }), blobs);
          await store.set(key('legend', s), part);
        } catch (e) {
          if (FATAL.has(e.code)) throw e;
          failures.push({ sheet: s, message: e.message, code: e.code });
          continue;
        }
      }
      mergeLegend(legend, part, s);
    }
    legend.found = legendSheets.length > 0;

    // 4) P&ID 시트별 판독
    const pidSheets = sheets.filter((s) => s.sheet_type === 'pid');
    if (!pidSheets.length) throw new EngineError('입력된 PDF에서 P&ID 시트를 찾지 못했습니다. 범례나 표지만 들어 있는지 확인하세요.');
    const drawingsList = sheets.map((s) => `- ${s.drawing_no || '(번호 미상)'}: ${s.title || ''} [${s.sheet_type}] (file ${s.file_index}, page ${s.page})`).join('\n');
    const legendJson = JSON.stringify(compactLegend(legend));
    const done = new Map(); // sheet → 판독 결과
    for (const s of pidSheets) {
      const cached = await store.get(key('sheet', s, legendJson.length));
      if (cached) done.set(s, cached);
    }

    const build = () => {
      const parts = pidSheets.filter((s) => done.has(s)).map((s) => ({ sheet: s, out: done.get(s) }));
      const raw = mergeSheets(sheets, legend, parts, failures);
      const result = postprocess(raw, files.map((f, i) => ({ name: f.name, text: texts[i] })));
      result.meta = {
        engine: 'claude.ai', tier, sheets: sheets.length,
        progress: { total: pidSheets.length, done: done.size, failed: failures.filter((f) => f.sheet.sheet_type === 'pid').length },
      };
      return result;
    };
    let lastPartial = 0;
    const partial = (force = false) => {
      if (!force && Date.now() - lastPartial < PARTIAL_EVERY_MS) return;
      lastPartial = Date.now();
      if (done.size) onPartial(build());
    };
    partial(true);

    const queue = pidSheets.filter((s) => !done.has(s));
    const running = new Set();
    let fatal = null;
    const report = () => {
      const now = [...running].map((s) => sheetName(s, files)).join(', ');
      onProgress(`P&ID 시트 판독 중: 완료 ${done.size}/${pidSheets.length}${failures.length ? `, 실패 ${failures.length}` : ''}${now ? ` · 진행 중 ${now}` : ''} — 시트당 1~3분, 두 장씩 동시에 진행합니다.`);
    };
    const worker = async () => {
      while (queue.length && !fatal) {
        const s = queue.shift();
        running.add(s);
        report();
        try {
          const ctx = { s, files, docs, maxImages, legendJson, drawingsList, page: pageText(s), ask, onSplit: () => report() };
          const out = await analyzeSheet(ctx);
          done.set(s, out);
          await store.set(key('sheet', s, legendJson.length), out);
          partial();
        } catch (e) {
          if (FATAL.has(e.code)) fatal = fatal || e;
          else failures.push({ sheet: s, message: e.message, code: e.code });
        } finally {
          running.delete(s);
          report();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    // 5) 병합 + 후처리
    onProgress('연결성 검증 및 위치 보정 중...');
    const result = build();
    result.meta.progress.pending = pidSheets.length - done.size - result.meta.progress.failed;
    if (fatal) {
      const left = pidSheets.length - done.size;
      throw new EngineError(`${fatal.message} 완료한 ${done.size}장의 결과는 저장되어 있습니다. 같은 파일로 "이어서 분석"하면 남은 ${left}장만 분석합니다.`, fatal.code, done.size ? result : null);
    }
    return result;
  } finally {
    for (const t of tasks) t.destroy();
  }
}

// ---------------------------------------------------------------- 시트 판독 (필요하면 나눠서)

async function analyzeSheet(ctx) {
  try {
    return await askSheet(ctx, null);
  } catch (e) {
    if (!SPLITTABLE.has(e.code)) throw e;
  }
  // 결과가 너무 길거나 입력이 큰 시트: 겹치게 둘로 나눠 판독 후 합친다
  ctx.onSplit();
  const landscape = (ctx.page.width || 1) >= (ctx.page.height || 1);
  const regions = landscape ? [[0, 0, 0.55, 1], [0.45, 0, 1, 1]] : [[0, 0, 1, 0.55], [0, 0.45, 1, 1]];
  const outs = [];
  for (const [i, r] of regions.entries()) {
    try {
      outs.push(await askSheet(ctx, { box: r, index: i + 1, count: regions.length }));
    } catch (e) {
      if (FATAL.has(e.code)) throw e;
      throw new EngineError(`시트를 나누어도 판독하지 못했습니다. (${e.message})`, e.code);
    }
  }
  return combineOutputs(outs);
}

async function askSheet({ s, files, docs, maxImages, legendJson, drawingsList, page, ask }, region) {
  const { blobs, note } = await pageImages(docs[s.file_index], s.page, maxImages, region?.box);
  const textPage = region ? { ...page, runs: page.runs.filter((r) => inBox(r.bbox, region.box, 0.03)) } : page;
  return ask(sheetPrompt({
    sheetLabel: sheetLabel(s, files),
    legendJson,
    drawingsList,
    textLayer: pageTextForPrompt(textPage, PROMPT_TEXT_BUDGET - legendJson.length - drawingsList.length),
    hasTextLayer: page.runs.length > 0,
    region,
    imageNote: note,
  }), blobs);
}

const inBox = (b, box, m) => {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return cx >= box[0] - m && cx <= box[2] + m && cy >= box[1] - m && cy <= box[3] + m;
};

/** 나눠 판독한 결과 합치기: 겹친 구간에서 두 번 나온 항목은 하나로 */
function combineOutputs(outs) {
  const res = { drawing: {}, sheet_summary: '', nodes: [], lines: [], issues: [] };
  const nodeKey = (n) => normalizeTag(n?.tag) || str(n?.id);
  const lineKey = (l) => normalizeTag(l?.line_no) ? `${normalizeTag(l.line_no)}|${str(l.from_id)}|${str(l.to_id)}` : str(l?.id);
  for (const o of outs) {
    if (!o || typeof o !== 'object') continue;
    if (!res.drawing.drawing_no && o.drawing) res.drawing = o.drawing;
    if (o.sheet_summary) res.sheet_summary = [res.sheet_summary, str(o.sheet_summary)].filter(Boolean).join(' ');
    for (const n of arr(o.nodes)) {
      const prev = res.nodes.find((x) => nodeKey(x) === nodeKey(n));
      if (!prev) res.nodes.push({ ...n, specs: arr(n.specs) });
      else for (const sp of arr(n.specs)) if (!prev.specs.some((x) => x.name === sp?.name)) prev.specs.push(sp);
    }
    for (const l of arr(o.lines)) {
      const prev = res.lines.find((x) => lineKey(x) === lineKey(l));
      if (!prev) res.lines.push(l);
      else {
        // 한쪽에서만 읽힌 연결처를 보완
        if (!str(prev.from_id) && str(l.from_id)) prev.from_id = l.from_id;
        if (!str(prev.to_id) && str(l.to_id)) prev.to_id = l.to_id;
      }
    }
    for (const x of arr(o.issues)) if (!res.issues.some((y) => y.title === x?.title)) res.issues.push(x);
  }
  return res;
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
    case 'rate_limited': return 'Claude 사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시도해 주세요.';
    case 'session_expired': return 'claude.ai 로그인이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.';
    case 'prompt_too_large': return '도면 텍스트가 너무 많아 한 번에 보낼 수 없습니다.';
    case 'image_rejected': return '도면 이미지를 보낼 수 없습니다.';
    case 'images_unavailable': return '이 화면에서는 도면 이미지를 보낼 수 없습니다.';
    case 'refused': return 'Claude가 이 도면의 분석을 거절했습니다.';
    case 'invalid_json': return '판독 결과가 너무 길어 잘렸거나 형식이 맞지 않습니다.';
    case 'empty_completion': return 'Claude가 결과를 내지 않았습니다.';
    case 'upstream_error': return 'Claude 응답이 중간에 끊겼습니다(시간 초과 또는 일시적 오류).';
    default: return `Claude 호출 중 오류가 발생했습니다${e?.code ? ` (${e.code})` : ''}.`;
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

const sheetName = (s, files) => s.drawing_no || `${files[s.file_index].name} p.${s.page}`;
const sheetLabel = (s, files) => `${s.drawing_no || '(drawing no. unknown)'}${s.title ? ` "${s.title}"` : ''} = file ${s.file_index} ("${files[s.file_index].name}") page ${s.page}`;

// ---------------------------------------------------------------- 도면 이미지

/**
 * 영역(기본: 페이지 전체)의 전체 이미지 1장 + (가능하면) 겹치게 자른 분할 이미지.
 * box = [x0, y0, x1, y1] 페이지 정규화 좌표
 */
async function pageImages(doc, pageNo, maxImages, box = [0, 0, 1, 1]) {
  if (maxImages < 1) return { blobs: [], note: '\nNo images are attached; rely on the text layer.' };
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const rw = vp1.width * (box[2] - box[0]), rh = vp1.height * (box[3] - box[1]);
  const landscape = rw >= rh;
  const [cols, rows] = maxImages >= 5 ? [2, 2] : maxImages >= 3 ? (landscape ? [2, 1] : [1, 2]) : [1, 1];
  // 분할 이미지 한 장이 TILE_LONG_SIDE가 되도록 영역을 렌더링
  const scale = (TILE_LONG_SIDE * Math.max(cols, rows)) / Math.max(rw, rh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(rw * scale);
  canvas.height = Math.round(rh * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -box[0] * vp1.width * scale, -box[1] * vp1.height * scale],
    background: '#ffffff',
  }).promise;
  page.cleanup();

  const toPage = (fx, fy) => [box[0] + fx * (box[2] - box[0]), box[1] + fy * (box[3] - box[1])];
  const range = (x0, y0, x1, y1) => {
    const [a, b] = toPage(x0 / canvas.width, y0 / canvas.height), [c, d] = toPage(x1 / canvas.width, y1 / canvas.height);
    return `x ${a.toFixed(2)}-${c.toFixed(2)}, y ${b.toFixed(2)}-${d.toFixed(2)}`;
  };
  const blobs = [await toBlob(downscale(canvas, 1600))];
  const names = [`image 1: ${range(0, 0, canvas.width, canvas.height)}${box[2] - box[0] < 1 || box[3] - box[1] < 1 ? ' (the part of the sheet analyzed now)' : ' (whole sheet)'}`];
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
        names.push(`image ${blobs.length}: ${range(x0, y0, x1, y1)} (enlarged)`);
      }
    }
  }
  return { blobs, note: `\nImages (normalized page ranges): ${names.join('; ')}. Coordinates you return are always for the whole page.` };
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

// ---------------------------------------------------------------- 저장 (이어서 분석용)

async function fingerprint(f) {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', f.buffer));
    return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${f.name}:${f.buffer.byteLength}`;
  }
}

let storeInstance = null;
/** IndexedDB 저장소. 쓸 수 없는 환경(비공개 창 등)에서는 이 화면을 연 동안만 메모리에 둔다 */
function getStore() {
  if (storeInstance) return storeInstance;
  const mem = new Map();
  const dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open('pid-review', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('results');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const run = async (mode, fn) => {
    const db = await dbp;
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const r = fn(db.transaction('results', mode).objectStore('results'));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  storeInstance = {
    async get(k) {
      if (mem.has(k)) return mem.get(k);
      const v = await run('readonly', (s) => s.get(k));
      if (v !== undefined) mem.set(k, v);
      return v;
    },
    async set(k, v) {
      mem.set(k, v);
      await run('readwrite', (s) => s.put(v, k));
    },
  };
  return storeInstance;
}

// ---------------------------------------------------------------- 병합

function emptyLegend() {
  return { found: false, pages: [], line_number_format: '', fluid_codes: [], piping_classes: [], equipment_codes: [], instrument_letters: [], symbols: [], notes: '' };
}

function mergeLegend(legend, part, sheet) {
  legend.pages.push({ file_index: sheet.file_index, page: sheet.page });
  if (!part || typeof part !== 'object') return;
  if (!legend.line_number_format && part.line_number_format) legend.line_number_format = str(part.line_number_format);
  for (const key of ['fluid_codes', 'piping_classes', 'equipment_codes', 'instrument_letters', 'symbols']) {
    for (const e of arr(part[key])) {
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

/**
 * 시트별 결과를 한 세트로 합친다 (postprocess가 받는 형식).
 * failures: 판독에 실패한 시트 → 검토 항목으로 남긴다
 */
export function mergeSheets(sheets, legend, parts, failures = []) {
  const drawings = sheets.map((s) => {
    const d = parts.find((p) => p.sheet === s)?.out?.drawing || {};
    return {
      file_index: s.file_index, page: s.page, sheet_type: s.sheet_type,
      drawing_no: s.drawing_no || str(d.drawing_no), title: s.title || str(d.title), revision: s.revision || str(d.revision),
    };
  });
  const dwgOf = (s) => drawings.find((d) => d.file_index === s.file_index && d.page === s.page)?.drawing_no || `파일 ${s.file_index + 1} p.${s.page}`;
  const nodes = [], lines = [], issues = [], summaries = [];
  const seenEquipment = new Map(); // 여러 시트에 걸쳐 그려진 같은 설비는 하나로
  for (const { sheet, out } of parts) {
    if (!out || typeof out !== 'object') continue;
    const loc = (bbox) => ({ file_index: sheet.file_index, page: sheet.page, bbox: Array.isArray(bbox) ? bbox : null });
    const alias = new Map();
    for (const n of arr(out.nodes)) {
      const key = n?.category === 'equipment' ? normalizeTag(n.tag) : '';
      const prev = key && seenEquipment.get(key);
      if (prev && prev.sheet !== sheet) {
        alias.set(str(n.id), prev.node.id);
        for (const sp of arr(n.specs)) {
          if (!prev.node.specs.some((x) => x.name === sp?.name)) prev.node.specs.push(sp);
        }
        continue;
      }
      const node = { ...n, specs: arr(n.specs), loc: loc(n.bbox) };
      delete node.bbox;
      nodes.push(node);
      if (key) seenEquipment.set(key, { sheet, node });
    }
    const re = (id) => alias.get(str(id)) ?? str(id);
    for (const l of arr(out.lines)) {
      const line = { ...l, from_id: re(l.from_id), to_id: re(l.to_id), loc: loc(l.bbox) };
      delete line.bbox;
      lines.push(line);
    }
    for (const x of arr(out.issues)) {
      const iss = { ...x, related_ids: arr(x.related_ids).map(re), loc: loc(x.bbox) };
      delete iss.bbox;
      issues.push(iss);
    }
    if (out.sheet_summary) summaries.push(`${dwgOf(sheet)}: ${str(out.sheet_summary)}`);
  }
  for (const f of failures) {
    issues.push({
      severity: 'high', category: 'other',
      title: `시트 판독 실패 (${dwgOf(f.sheet)})`,
      description: `${f.message} 이 시트의 설비·배관은 결과에 들어 있지 않습니다. "이어서 분석"을 누르면 이 시트만 다시 시도합니다.`,
      related_ids: [],
      loc: { file_index: f.sheet.file_index, page: f.sheet.page, bbox: null },
    });
  }
  const pidCount = sheets.filter((s) => s.sheet_type === 'pid').length;
  const summary = summaries.length <= 4 ? summaries.join(' / ')
    : `P&ID ${pidCount}장 중 ${parts.length}장 판독. ${summaries.slice(0, 3).join(' / ')} 외 ${summaries.length - 3}장`;
  return { summary, legend, drawings, nodes, lines, issues };
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
