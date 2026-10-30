// 시트별 판독 결과 병합 (브라우저 분석 엔진과 채팅 세션 분석 스크립트 공용).
import { normalizeTag } from './pidText.js';

/** 나눠 판독한 결과 합치기: 겹친 구간에서 두 번 나온 항목은 하나로 */
export function combineOutputs(outs) {
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


export function emptyLegend() {
  return { found: false, pages: [], line_number_format: '', fluid_codes: [], piping_classes: [], equipment_codes: [], instrument_letters: [], symbols: [], notes: '' };
}

export function mergeLegend(legend, part, sheet) {
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

export const compactLegend = (lg) => (lg.found ? {
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
  // 시트마다 따로 판독하므로 id가 겹칠 수 있다(PUMP-1, OPC:...:1 등). 겹치면 도면 번호를 붙여 구분하고,
  // 그 시트의 라인·이슈가 가리키는 id도 같이 바꾼다. (안 그러면 다른 시트의 같은 id에 잘못 연결된다)
  const usedNodeIds = new Set(), usedLineIds = new Set();
  const shortDwg = (sh) => { const d = dwgOf(sh); return d.match(/[A-Z]+-\d+$/i)?.[0] || d; };
  const unique = (used, id, sh) => {
    if (!id) return id;
    let u = id;
    if (used.has(u)) {
      u = `${id}@${shortDwg(sh)}`;
      for (let k = 2; used.has(u); k++) u = `${id}@${shortDwg(sh)}#${k}`;
    }
    used.add(u);
    return u;
  };
  for (const { sheet, out } of parts) {
    if (!out || typeof out !== 'object') continue;
    const loc = (bbox) => ({ file_index: sheet.file_index, page: sheet.page, bbox: Array.isArray(bbox) ? bbox : null });
    const alias = new Map();
    const lineAlias = new Map();
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
      const node = { ...n, id: unique(usedNodeIds, str(n.id), sheet), specs: arr(n.specs), loc: loc(n.bbox) };
      if (node.id !== str(n.id)) alias.set(str(n.id), node.id);
      delete node.bbox;
      nodes.push(node);
      if (key) seenEquipment.set(key, { sheet, node });
    }
    const re = (id) => alias.get(str(id)) ?? str(id);
    for (const l of arr(out.lines)) {
      const id = unique(usedLineIds, str(l.id), sheet);
      if (id !== str(l.id)) lineAlias.set(str(l.id), id);
      const line = { ...l, id, from_id: re(l.from_id), to_id: re(l.to_id), inline_items: arr(l.inline_items).map(re), loc: loc(l.bbox) };
      delete line.bbox;
      lines.push(line);
    }
    for (const x of arr(out.issues)) {
      const iss = { ...x, related_ids: arr(x.related_ids).map((id) => lineAlias.get(str(id)) ?? re(id)), loc: loc(x.bbox) };
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
  const drawn = sheets.filter((s) => s.sheet_type === 'pid' || s.sheet_type === 'pfd');
  const kind = drawn.length && drawn.every((s) => s.sheet_type === 'pfd') ? 'PFD' : 'P&ID';
  const summary = summaries.length <= 4 ? summaries.join(' / ')
    : `${kind} ${drawn.length}장 중 ${parts.length}장 판독. ${summaries.slice(0, 3).join(' / ')} 외 ${summaries.length - 3}장`;
  return { summary, legend, drawings, nodes, lines, issues };
}

export const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
export const arr = (v) => (Array.isArray(v) ? v : []);
