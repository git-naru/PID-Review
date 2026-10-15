// PDF 텍스트 레이어 추출 및 태그 위치 검색.
// 좌표는 모두 페이지 기준 정규화 값(0~1, 좌상단 원점)이다.
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_RUNS_PER_PAGE = 4000;

/** 비교용 정규화: 대문자, 공백 제거, 각종 대시/따옴표 통일 */
export function normalizeTag(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’“”″]/g, '"')
    .replace(/''/g, '"')
    .replace(/\s+/g, '');
}

/**
 * PDF 한 개의 페이지별 텍스트 run 목록을 추출한다.
 * @returns {Promise<{pageCount:number, pages:Array<{page:number,width:number,height:number,runs:Array}>}>}
 */
export async function extractPdfText(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const tx = Util.transform(viewport.transform, it.transform);
        const fontH = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 1;
        const dirLen = Math.hypot(tx[0], tx[1]) || 1;
        const ax = tx[0] / dirLen, ay = tx[1] / dirLen; // 문자 진행 방향
        // (tx[2], tx[3]) = 글자 기준선에서 글자 윗변까지의 화면상 벡터 (길이 = 글자 높이)
        const ux = tx[2], uy = tx[3];
        const w = it.width; // scale 1 viewport이므로 사용자 공간 단위 그대로 사용
        const ox = tx[4], oy = tx[5];
        const corners = [
          [ox, oy],
          [ox + ax * w, oy + ay * w],
          [ox + ux, oy + uy],
          [ox + ax * w + ux, oy + ay * w + uy],
        ];
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        items.push({
          str: it.str,
          x0: Math.min(...xs), x1: Math.max(...xs),
          y0: Math.min(...ys), y1: Math.max(...ys),
          ox, oy, ax, ay, w, h: fontH,
          vertical: Math.abs(ay) > Math.abs(ax),
        });
      }
      const runs = mergeRuns(items).map((r) => ({
        text: r.str,
        bbox: [
          clamp01(r.x0 / viewport.width), clamp01(r.y0 / viewport.height),
          clamp01(r.x1 / viewport.width), clamp01(r.y1 / viewport.height),
        ],
        vertical: r.vertical,
      }));
      pages.push({ page: p, width: viewport.width, height: viewport.height, runs });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { pageCount: pages.length, pages };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** 같은 기준선 위에서 인접한 텍스트 조각을 하나의 run으로 병합 */
function mergeRuns(items) {
  const out = [];
  // base: 기준선 좌표, pos/end: 진행 방향 시작·끝 좌표 (세로 글자는 아래→위로 진행)
  const merge = (list, base, pos, end) => {
    // 1) 기준선이 거의 같은 조각끼리 묶고 2) 각 묶음을 진행 방향 순으로 정렬
    const groups = [];
    for (const it of [...list].sort((a, b) => base(a) - base(b))) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(base(it) - g.base) < Math.max(g.h, it.h) * 0.3) g.items.push(it);
      else groups.push({ base: base(it), h: it.h, items: [it] });
    }
    for (const g of groups) {
      let cur = null;
      for (const it of g.items.sort((a, b) => pos(a) - pos(b))) {
        const h = cur ? Math.max(cur.h, it.h) : it.h;
        const gap = cur ? pos(it) - end(cur.last) : Infinity;
        // 앞 조각 바로 뒤에 이어지는 경우만 병합 (겹침은 약간만 허용)
        if (cur && gap > -h * 0.3 && gap < h * 0.6) {
          cur.str += (gap > h * 0.15 ? ' ' : '') + it.str;
          cur.x0 = Math.min(cur.x0, it.x0); cur.x1 = Math.max(cur.x1, it.x1);
          cur.y0 = Math.min(cur.y0, it.y0); cur.y1 = Math.max(cur.y1, it.y1);
          cur.last = it;
        } else {
          if (cur) out.push(cur);
          cur = { ...it, last: it };
        }
      }
      if (cur) out.push(cur);
    }
  };
  merge(items.filter((i) => !i.vertical), (i) => i.oy, (i) => i.x0, (i) => i.x1);
  merge(items.filter((i) => i.vertical), (i) => i.ox, (i) => -i.y1, (i) => -i.y0);
  return out;
}

/** Claude에 전달할 압축된 텍스트 레이어 설명 */
export function textLayerForPrompt(fileIndex, fileName, extracted) {
  const lines = [`### FILE ${fileIndex} (${fileName}) - ${extracted.pageCount} page(s)`];
  for (const pg of extracted.pages) {
    if (pg.runs.length === 0) {
      lines.push(`[file ${fileIndex} / page ${pg.page}] (no text layer - likely scanned image; read visually)`);
      continue;
    }
    lines.push(`[file ${fileIndex} / page ${pg.page}] ${pg.runs.length} text runs. format: cx,cy | text  (normalized 0-1, origin top-left)`);
    const runs = pg.runs.slice(0, MAX_RUNS_PER_PAGE);
    for (const r of runs) {
      const cx = ((r.bbox[0] + r.bbox[2]) / 2).toFixed(3);
      const cy = ((r.bbox[1] + r.bbox[3]) / 2).toFixed(3);
      lines.push(`${cx},${cy} | ${r.text}${r.vertical ? '  (vertical)' : ''}`);
    }
    if (pg.runs.length > MAX_RUNS_PER_PAGE) {
      lines.push(`... ${pg.runs.length - MAX_RUNS_PER_PAGE} more runs omitted`);
    }
  }
  return lines.join('\n');
}

/**
 * 텍스트 레이어에서 태그 위치를 찾는다.
 * 1) run 안에 태그 문자열이 그대로 포함된 경우 (문자 비율로 부분 bbox 계산)
 * 2) 계기 버블처럼 "FIC" / "101"이 위아래로 분리된 경우
 * @returns {{bbox:number[], page:number}|null}
 */
export function findTagOnPages(tag, pages, preferPage) {
  const key = normalizeTag(tag);
  if (key.length < 2) return null;
  const ordered = [...pages].sort((a, b) => (a.page === preferPage ? -1 : 0) - (b.page === preferPage ? -1 : 0));
  for (const pg of ordered) {
    let best = null;
    for (const r of pg.runs) {
      const norm = normalizeTag(r.text);
      const idx = norm.indexOf(key);
      if (idx < 0) continue;
      // 정확 일치 우선, 그다음 짧은 run 우선
      const score = (norm.length === key.length ? 0 : 1) * 1000 + norm.length;
      if (best && best.score <= score) continue;
      const frac0 = idx / norm.length, frac1 = (idx + key.length) / norm.length;
      const [x0, y0, x1, y1] = r.bbox;
      const bbox = r.vertical
        ? [x0, y1 - (y1 - y0) * frac1, x1, y1 - (y1 - y0) * frac0]
        : [x0 + (x1 - x0) * frac0, y0, x0 + (x1 - x0) * frac1, y1];
      best = { score, bbox };
    }
    if (best) return { page: pg.page, bbox: best.bbox };
    const split = findSplitInstrumentTag(key, pg);
    if (split) return { page: pg.page, bbox: split };
  }
  return null;
}

function findSplitInstrumentTag(key, pg) {
  return splitInstrumentBoxes(key, pg)[0] || null;
}

/** 계기 버블처럼 기능문자("FIC")와 번호("101")가 위아래로 나뉘어 표기된 태그의 bbox 목록 */
function splitInstrumentBoxes(key, pg) {
  const m = key.match(/^([A-Z]{1,5})-?(\d{2,6}[A-Z]?)$/);
  if (!m) return [];
  const [, letters, num] = m;
  const tops = pg.runs.filter((r) => normalizeTag(r.text) === letters);
  const bottoms = pg.runs.filter((r) => normalizeTag(r.text) === num);
  const out = [];
  for (const t of tops) {
    const tcx = (t.bbox[0] + t.bbox[2]) / 2, th = t.bbox[3] - t.bbox[1];
    const b = bottoms.find((b) => {
      const dy = b.bbox[1] - t.bbox[3];
      return Math.abs((b.bbox[0] + b.bbox[2]) / 2 - tcx) < th * 1.5 && dy > -th * 0.5 && dy < th * 2.5;
    });
    if (b) out.push([Math.min(t.bbox[0], b.bbox[0]), t.bbox[1], Math.max(t.bbox[2], b.bbox[2]), b.bbox[3]]);
  }
  return out;
}

/** 페이지에서 태그가 단독으로 표기된 모든 위치 (중복 표기 검출용) */
export function findAllTagBoxes(tag, pg) {
  const key = normalizeTag(tag);
  if (!key) return [];
  const exact = pg.runs.filter((r) => normalizeTag(r.text) === key).map((r) => r.bbox);
  return [...exact, ...splitInstrumentBoxes(key, pg)];
}
