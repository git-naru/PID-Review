// 물질수지(Mass Balance / Heat & Material Balance) 표를 읽어 도면의 스트림·라인과 매칭한다 (브라우저·Node 공용).
//
// 읽을 수 있는 형식: 엑셀(.xlsx/.xlsm), CSV/TSV(.csv/.tsv/.txt), 글자 정보가 있는 PDF 표
// 표 모양: 스트림 번호가 한 행(또는 한 열)에 나란히 있고, 나머지 행이 속성(유량, 온도, 압력 ...)인 일반적인 H&MB 양식.
//          같은 시트에 스트림 블록이 여러 개 이어져 있어도 된다.
// 매칭 순서: ① 스트림 번호 (PFD 스트림 번호, P&ID 라인의 스트림 표식) ② 물질수지의 Line No. 행
//          ③ 물질수지의 From/To 설비 태그와 라인 양 끝 설비
import { normalizeTag, extractTextFromDocument } from './pidText.js';

export class MassBalanceError extends Error {}

const STREAM_LABEL = /stream|스트림|^str\b|^no\.?$|^번호$/i;
const ID_RE = /^(?:(?:stream|str|s)[\s.#-]*)?[A-Z]{0,3}-?\d{1,5}[A-Z]{0,2}$/i;
const SPECIAL = [
  // "Unit" 열 머리글 행에 스트림 설명을 적는 양식도 있다
  ['description', /^(stream\s*)?(desc|description|service|name)\b|명칭|설명|서비스|^units?$|^단위$/i],
  ['from', /^(from|source)\b|출발/i],
  ['to', /^(to|dest(ination)?)\b|도착/i],
  ['line_no', /^line\s*(no|number)\b|배관\s*번호|라인\s*번호/i],
];
const FLOW_RE = /mass\s*flow|flow\s*rate|total\s*flow|질량\s*유량|유량/i;
// 값 없는 제목 행: "NOMINAL FLOW"처럼 아래 항목 이름 앞에 붙는 구분, "OTHER VALUES"처럼 의미 없는 묶음, 그 밖에는 성분 묶음
const QUALIFIER_SECTION = /^(nominal|normal|design|rated|operating|max(imum)?|min(imum)?|정상|설계)\b/i;
const NEUTRAL_SECTION = /\b(other|values|properties|conditions|general|data)\b/i;
const DASH = /^[-‐-―−]+$/;

// ------------------------------------------------------------------ 파일 읽기
/**
 * @param {string} name 파일 이름 (확장자로 형식 판단)
 * @param {ArrayBuffer} buffer
 * @param {{pdfjs?: object}} opts PDF를 읽을 때 pdf.js (getDocument, Util)
 * @returns {Promise<{name, sheet, properties, streams}>}
 */
export async function readMassBalanceFile(name, buffer, { pdfjs } = {}) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let tables;
  if (ext === 'xlsx' || ext === 'xlsm') tables = await readXlsx(buffer);
  else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') tables = [{ name: '', cells: gridToCells(readDelimited(decodeText(buffer))), grid: true }];
  else if (ext === 'pdf') {
    if (!pdfjs) throw new MassBalanceError('이 화면에서는 PDF 물질수지를 읽을 수 없습니다. 엑셀(.xlsx)이나 CSV로 입력해 주세요.');
    tables = await readPdfTables(buffer, pdfjs);
  } else if (ext === 'xls') {
    throw new MassBalanceError('예전 엑셀 형식(.xls)은 읽을 수 없습니다. 엑셀에서 .xlsx 또는 .csv로 다시 저장해 주세요.');
  } else {
    throw new MassBalanceError('물질수지는 엑셀(.xlsx), CSV, PDF 파일로 입력해 주세요.');
  }
  // 시트(PDF는 페이지)마다 표를 읽고, 도면별로 시트가 나뉜 물질수지는 하나로 합친다
  const parts = [];
  for (const t of tables) {
    let best = null;
    const variants = t.grid ? [t.cells, transposeCells(t.cells)] : [t.cells];
    for (const cells of variants) {
      const parsed = parseMassBalance(cells);
      if (!parsed) continue;
      const score = parsed.streams.length * (1 + parsed.properties.length);
      if (!best || score > best.score) best = { score, parsed };
    }
    if (best) parts.push({ sheet: t.name, ...best.parsed });
  }
  if (!parts.length) {
    throw new MassBalanceError(ext === 'pdf'
      ? 'PDF에서 스트림 번호 행을 찾지 못했습니다. 스캔한 PDF이거나 표 모양이 달라 읽을 수 없습니다. 엑셀(.xlsx)이나 CSV로 입력해 주세요.'
      : '스트림 번호 행을 찾지 못했습니다. 표 첫 열에 "Stream No." 같은 머리글이 있고, 그 행에 스트림 번호가 나란히 있는지 확인해 주세요.');
  }
  const properties = new Map(), streams = new Map();
  for (const part of parts) {
    for (const p of part.properties) if (!properties.has(p.key)) properties.set(p.key, p);
    for (const st of part.streams) {
      const prev = streams.get(st.key);
      if (!prev) { streams.set(st.key, { ...st, sheet: part.sheet }); continue; }
      for (const f of ['description', 'from', 'to', 'line_no']) prev[f] ||= st[f];
      for (const [k, v] of Object.entries(st.values)) prev.values[k] ??= v;
    }
  }
  const sheet = parts.length === 1 ? parts[0].sheet : `시트 ${parts.length}개`;
  return { name: String(name), sheet, properties: [...properties.values()], streams: [...streams.values()] };
}

// ---- xlsx: zip(deflate) + XML. 별도 라이브러리 없이 필요한 부분만 읽는다
async function readXlsx(buffer) {
  const zip = openZip(buffer);
  const wb = await zip.text('xl/workbook.xml');
  if (!wb) throw new MassBalanceError('엑셀 파일 구조를 읽지 못했습니다.');
  const rels = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const shared = [...((await zip.text('xl/sharedStrings.xml')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => xmlText(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const t = target.get(attr(m[0], 'r:id'));
    if (!t) continue;
    const xml = await zip.text(t.startsWith('/') ? t.slice(1) : `xl/${t}`);
    if (xml) out.push({ name: xmlDecode(attr(m[0], 'name')), cells: gridToCells(sheetGrid(xml, shared)), grid: true });
  }
  return out;
}

function sheetGrid(xml, shared) {
  const grid = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const pos = cellPos(attr(m[1], 'r'));
    if (!pos || !m[2]) continue;
    const t = attr(m[1], 't');
    const v = m[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let text = '';
    if (t === 's') text = shared[Number(v)] ?? '';
    else if (t === 'inlineStr') text = xmlText(m[2]);
    else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
    else if (t !== 'e' && v !== undefined) text = xmlDecode(v);
    text = text.trim();
    if (text) (grid[pos.r] ||= [])[pos.c] = text;
  }
  // 병합 셀은 왼쪽 위 값을 범위 전체에 채운다 (여러 칸에 걸친 머리글·설명)
  for (const m of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g)) {
    const a = cellPos(m[1]), b = cellPos(m[2]);
    const v = grid[a.r]?.[a.c];
    if (!v || (b.r - a.r + 1) * (b.c - a.c + 1) > 400) continue;
    for (let r = a.r; r <= b.r; r++) for (let c = a.c; c <= b.c; c++) (grid[r] ||= [])[c] ??= v;
  }
  return grid;
}

function openZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  // 암호·보안(DRM)이 걸린 엑셀은 zip이 아니라 다른 컨테이너로 저장된다
  if (eocd < 0) throw new MassBalanceError('엑셀 파일을 열 수 없습니다. 암호나 문서 보안(DRM)이 걸린 파일은 해제한 뒤 .xlsx 또는 .csv로 저장해 주세요.');
  const entries = new Map();
  let p = dv.getUint32(eocd + 16, true);
  for (let k = dv.getUint16(eocd + 10, true); k > 0 && dv.getUint32(p, true) === 0x02014b50; k--) {
    const nameLen = dv.getUint16(p + 28, true);
    entries.set(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)), {
      method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return {
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = u8.subarray(start, start + e.size);
      if (e.method === 0) return new TextDecoder().decode(data);
      if (e.method !== 8) throw new MassBalanceError('지원하지 않는 엑셀 압축 방식입니다. .csv로 저장해 입력해 주세요.');
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    },
  };
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`))?.[1] ?? '';
const xmlText = (xml) => xmlDecode([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const xmlDecode = (s) => String(s)
  .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]
    ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))))
  .replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
function cellPos(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return { r: Number(m[2]) - 1, c: c - 1 };
}

// ---- CSV/TSV (엑셀이 저장한 CP949·UTF-16 파일 포함)
function decodeText(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(u8);
  }
}

function readDelimited(text) {
  const head = text.split(/\r?\n/).slice(0, 20).join('\n');
  const delim = ['\t', ';', ','].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

// ---- PDF: 텍스트 조각을 같은 높이끼리 행으로 묶는다 (열은 스트림 번호 위치에 맞춰 나중에 배정)
async function readPdfTables(buffer, pdfjs) {
  const task = pdfjs.getDocument({ data: buffer.slice(0) });
  try {
    const text = await extractTextFromDocument(await task.promise, pdfjs.Util);
    return text.pages.map((pg) => ({ name: `p.${pg.page}`, cells: pdfRows(pg.runs.filter((r) => !r.vertical)) }));
  } finally {
    task.destroy();
  }
}

function pdfRows(runs) {
  const items = runs.map((r) => ({ text: r.text.trim(), x0: r.bbox[0], x1: r.bbox[2], cy: (r.bbox[1] + r.bbox[3]) / 2, h: r.bbox[3] - r.bbox[1] }))
    .filter((r) => r.text).sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.cy - last.cy) < 0.5 * Math.min(it.h, last.h)) last.cells.push(it);
    else rows.push({ cy: it.cy, h: it.h, cells: [it] });
  }
  return rows.map((r) => r.cells.sort((a, b) => a.x0 - b.x0).map(({ text, x0, x1 }) => ({ text, x0, x1 })));
}

// ---- 공통 표 표현: 행마다 [{text, x0, x1}] (엑셀·CSV는 열 번호가 좌표)
function gridToCells(grid) {
  return Array.from(grid, (row) => Array.from(row || [], (v, c) => (v ? { text: String(v).trim(), x0: c, x1: c + 1 } : null)).filter((c) => c?.text));
}

function transposeCells(rows) {
  const out = [];
  rows.forEach((row, r) => row.forEach((cell) => { (out[cell.x0] ||= []).push({ text: cell.text, x0: r, x1: r + 1 }); }));
  return Array.from(out, (row) => row || []);
}

// ------------------------------------------------------------------ 표 해석
/** 스트림 번호 머리글 행 → 그 아래 행들을 속성으로 읽는다. 스트림 블록이 여러 개면 이어 붙인다 */
export function parseMassBalance(rows) {
  const streams = new Map();
  const properties = new Map();
  let block = null, group = null;
  for (const row of rows) {
    const head = headerOf(row);
    if (head) {
      block = head;
      group = null;
      for (const c of head.cols) if (!streams.has(c.key)) streams.set(c.key, { id: c.id, key: c.key, description: '', from: '', to: '', line_no: '', values: {} });
      continue;
    }
    if (!block || !row.length) continue;
    const labels = [], values = new Map();
    for (const cell of row) {
      const cx = (cell.x0 + cell.x1) / 2;
      if (cx < block.left || cell.x1 <= block.firstX0) { labels.push(cell.text); continue; }
      const col = block.cols.find((c) => cx >= c.lo && cx < c.hi);
      if (col && !DASH.test(cell.text)) values.set(col.key, values.has(col.key) ? `${values.get(col.key)} ${cell.text}` : cell.text);
    }
    if (!labels.length) continue;
    let { name, unit } = splitLabel(labels);
    if (!values.size) {
      if (row.some((c) => (c.x0 + c.x1) / 2 >= block.left)) continue; // 값이 모두 "-"인 행
      group = QUALIFIER_SECTION.test(name) ? { prefix: titleCase(name.replace(/\s*flows?\s*$/i, '')), name: '', unit }
        : NEUTRAL_SECTION.test(name) ? { name: '', unit } : { name, unit };
      continue;
    }
    // 병합 셀로 표 제목이 같은 행에 채워질 수 있어 칸별로도 확인한다
    const special = SPECIAL.find(([, re]) => re.test(name) || labels.some((l) => re.test(l)))?.[0];
    if (special) {
      for (const [k, v] of values) streams.get(k)[special] ||= v;
      continue;
    }
    let groupName = '';
    if (group) {
      unit ||= group.unit;
      if (group.prefix) name = `${group.prefix} ${name}`;
      groupName = group.name;
    }
    const key = propertyKey(name, unit, groupName);
    const groupLabel = /[a-z]/.test(groupName) ? groupName : titleCase(groupName);
    if (!properties.has(key)) properties.set(key, { key, name: groupName ? `${name} (${groupLabel})` : name, unit, group: groupName });
    for (const [k, v] of values) streams.get(k).values[key] ??= v;
  }
  const used = [...properties.values()].filter((p) => [...streams.values()].some((s) => s.values[p.key] !== undefined));
  if (!streams.size || (!used.length && ![...streams.values()].some((s) => s.description))) return null;
  return { properties: used, streams: [...streams.values()] };
}

function headerOf(row) {
  const i0 = row.findIndex((c, i) => ID_RE.test(c.text) && i > 0);
  if (i0 < 1) return null;
  const label = row.slice(0, i0).map((c) => c.text).join(' ');
  if (!STREAM_LABEL.test(label)) return null;
  const rest = row.slice(i0);
  const ids = rest.filter((c) => ID_RE.test(c.text));
  const keys = new Set(ids.map((c) => streamKey(c.text)));
  if (ids.length < 2 || ids.length < rest.length * 0.8 || keys.size < ids.length) return null;
  const centers = ids.map((c) => (c.x0 + c.x1) / 2);
  const gaps = centers.slice(1).map((x, i) => x - centers[i]);
  const half = Math.min(...gaps) / 2;
  const cols = ids.map((c, i) => ({
    id: c.text, key: streamKey(c.text),
    lo: i ? (centers[i - 1] + centers[i]) / 2 : centers[i] - half,
    hi: i < ids.length - 1 ? (centers[i] + centers[i + 1]) / 2 : centers[i] + half,
  }));
  return { cols, left: cols[0].lo, firstX0: ids[0].x0 };
}

const titleCase = (t) => t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const isUnit = (t) => t.length <= 16 && (DASH.test(t) || /^[[(].*[\])]$/.test(t) || /[/%°℃³]/.test(t)
  || /^(kPa|MPa|Pa|bar|barg|bara|psi|psig|psia|cP|K|pH|kW|MW|mm|ppm\w*|-)(\s*\(?[ag]\)?)?$/i.test(t));

/** 머리글 칸들 → 속성 이름과 단위 ("Mass flow | kg/h", "Mass flow (kg/h)", "Mass flow, kg/h") */
export function splitLabel(labels) {
  const parts = Array.isArray(labels) ? labels.map((x) => String(x).trim()).filter(Boolean) : [String(labels).trim()];
  let unit = '';
  const nameParts = [];
  parts.forEach((p, i) => { if (i > 0 && !unit && isUnit(p)) unit = p; else if (!nameParts.includes(p)) nameParts.push(p); });
  let name = nameParts.join(' ');
  const m = [name.match(/^(.*?)\s*[[(]([^[\]()]{1,16})[\])]\s*$/), name.match(/^(.*?),\s*([^,]{1,16})$/)]
    .find((x) => x && x[1] && isUnit(x[2].trim()));
  if (!unit && m) { name = m[1]; unit = m[2].trim(); }
  unit = unit.replace(/^[[(]\s*(.*?)\s*[\])]$/, '$1');
  return { name: name.trim(), unit: DASH.test(unit) ? '' : unit }; // "-", "―": 무차원
}

// ------------------------------------------------------------------ 비교용 정규화
/** 스트림 번호 비교: "S-0101", "Stream 101", "101" → "101" */
export const streamKey = (v) => String(v ?? '').toUpperCase().replace(/\s+/g, '')
  .replace(/^(STREAM|STR|S)[-.#]?(?=\d)/, '').replace(/^0+(?=\d)/, '');

const canonUnit = (u) => String(u || '').toLowerCase().replace(/\s+/g, '').replace(/³/g, '3').replace(/℃|degc|deg\.c/g, '°c')
  .replace(/\/hr\b/g, '/h').replace(/^tph$/, 't/h').replace(/[[\]()]/g, '');
const canonName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%가-힣+]/g, '');
const propertyKey = (name, unit, group = '') => `${canonName(name)}|${canonUnit(unit)}${group ? `|${canonName(group)}` : ''}`;

/** 도면 스트림 표의 항목 이름 ("Nominal mass flow (t/h)")도 같은 키로 맞춘다 */
export function specKey(specName) {
  const { name, unit } = splitLabel(specName);
  return propertyKey(name, unit);
}

/** "1,234.5 t/h" → 1234.5 */
export function toNumber(v) {
  const m = String(v ?? '').replace(/,(?=\d{3}\b)/g, '').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
  return m ? Number(m[0]) : NaN;
}

/** Li 농도 표시: 10 이상 소수 1자리, 1 이상 2자리, 그 밖에는 3자리 */
export const formatGpl = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 10 ? 1 : v >= 1 ? 2 : 3 });

/** 표시용 숫자 정리 (엑셀의 36.123456789 → 36.12) */
export function formatValue(v) {
  const s = String(v ?? '').trim();
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return s;
  const n = Number(s), a = Math.abs(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 1 : a >= 1 ? 2 : 4 });
}

// ------------------------------------------------------------------ 도면과 매칭
const METHOD_LABEL = { stream_no: '스트림 번호', line_no: 'Line No.', from_to: 'From/To 설비' };
export const matchMethodLabel = (m) => METHOD_LABEL[m] || m;

/**
 * 도면 안의 스트림 표(Heat & Material Balance)를 물질수지로 쓴다.
 * 판독 결과의 라인별 specs(스트림 표에서 옮긴 값)를 스트림 × 항목 표로 모은다. 따로 넣은 물질수지가 없을 때
 * 이것으로 Li 농도, 물질수지 탭, Line No. 조회를 쓸 수 있다. 표 값이 없으면 null.
 */
export function drawingMassBalance(result) {
  const pfd = result.doc_type === 'pfd';
  const streams = new Map();
  const properties = new Map();
  for (const l of result.lines) {
    if (l.kind === 'signal') continue;
    const id = l.stream_no || (pfd ? l.line_no : '');
    const key = streamKey(id);
    const specs = (l.specs || []).filter((sp) => String(sp.value ?? '').trim() && !DASH.test(String(sp.value).trim()));
    if (!key || !specs.length) continue;
    const s = streams.get(key) || { id, key, description: '', from: '', to: '', line_no: pfd ? '' : l.line_no || '', values: {} };
    for (const sp of specs) {
      if (/^stream\s+description/i.test(sp.name)) { s.description ||= sp.value; continue; }
      const k = specKey(sp.name);
      if (!properties.has(k)) properties.set(k, { key: k, ...splitLabel(sp.name), group: '' });
      s.values[k] ??= sp.value;
    }
    streams.set(key, s);
  }
  const list = [...streams.values()].filter((s) => Object.keys(s.values).length);
  if (!list.length) return null;
  return { name: '도면 스트림 표', source: 'drawing', properties: [...properties.values()], streams: list };
}

/** 물질수지를 반영한 결과 사본: mass_balance(매칭 정보)와 물질수지 검토 항목이 추가된다 */
export function applyMassBalance(result, mb) {
  const base = stripMassBalance(result);
  if (!mb?.streams?.length) return base;
  const pfd = base.doc_type === 'pfd';
  const byKey = new Map(mb.streams.map((s) => [s.key, s]));
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  const flowLines = base.lines.filter((l) => l.kind !== 'signal');
  const matches = [];
  const matched = new Map();
  const add = (l, s, method) => { matched.set(l.id, s); matches.push({ line_id: l.id, stream_id: s.id, method }); };

  for (const l of flowLines) {
    const s = [l.stream_no, pfd ? l.line_no : ''].map(streamKey).filter(Boolean).map((k) => byKey.get(k)).find(Boolean);
    if (s) add(l, s, 'stream_no');
  }
  for (const s of mb.streams) {
    const want = normalizeTag(s.line_no);
    if (want.length < 3) continue;
    const re = new RegExp(`(^|[^A-Z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9])`);
    for (const l of flowLines) if (!matched.has(l.id) && re.test(normalizeTag(l.line_no))) add(l, s, 'line_no');
  }
  const endKeys = (id) => { const n = nodes.get(id); return n ? [n.tag, n.name, n.id].map(normalizeTag).filter((k) => k.length >= 2) : []; };
  const endIs = (text, id) => { const t = normalizeTag(text); return !!t && endKeys(id).some((k) => t === k || (k.length >= 4 && t.includes(k))); };
  for (const s of mb.streams) {
    if (!s.from || !s.to) continue;
    for (const l of flowLines) if (!matched.has(l.id) && endIs(s.from, l.from_id) && endIs(s.to, l.to_id)) add(l, s, 'from_to');
  }

  // ---- 검토 항목 (도면 스트림 표에서 만든 물질수지는 도면 자신과 비교할 것이 없으므로 만들지 않는다)
  const found = [];
  const fromDrawing = mb.source === 'drawing';
  const lineName = (l) => (pfd ? `스트림 ${l.line_no || l.id}` : l.line_no || l.id);
  // 같은 이름이면 한쪽에 단위가 없어도 같은 항목으로 본다
  const propFor = (specName) => {
    const k = specKey(specName);
    const [n, u] = k.split('|');
    const exact = mb.properties.find((p) => p.key === k);
    if (exact) return exact;
    const same = mb.properties.filter((p) => { const [pn, pu] = p.key.split('|'); return pn === n && (!u || !pu || pu === u); });
    return same.length === 1 ? same[0] : null;
  };
  for (const l of fromDrawing ? [] : flowLines) {
    const s = matched.get(l.id);
    if (!s || !l.specs?.length) continue;
    const diffs = [];
    for (const sp of l.specs) {
      const p = propFor(sp.name);
      if (!p || s.values[p.key] === undefined) continue;
      const a = toNumber(sp.value), b = toNumber(s.values[p.key]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      // 도면 표기 자릿수만큼의 반올림 차이는 허용
      const dec = (String(sp.value).match(/\.(\d+)/)?.[1].length) ?? 0;
      const tol = Math.max(Math.abs(b) * 0.01, 0.5 * 10 ** -dec * 1.001);
      if (Math.abs(a - b) > tol) diffs.push(`${p.name}: 도면 ${sp.value}, 물질수지 ${formatValue(s.values[p.key])}${p.unit ? ` ${p.unit}` : ''}`);
    }
    if (diffs.length) {
      found.push({
        severity: 'medium', category: 'inconsistent',
        title: `도면과 물질수지 값 불일치 (${lineName(l)})`,
        description: `${lineName(l)}의 도면 표기값이 물질수지 스트림 ${s.id}와 다릅니다. ${diffs.join(' / ')}. 어느 쪽이 최신인지 확인하세요.`,
        related_ids: [l.id],
      });
    }
  }
  const usedStreams = new Set(matches.map((m) => m.stream_id));
  const left = mb.streams.filter((s) => !usedStreams.has(s.id));
  const list = (xs) => xs.slice(0, 30).join(', ') + (xs.length > 30 ? ` 외 ${xs.length - 30}개` : '');
  if (fromDrawing) {
    // 검토 항목 없음
  } else if (!matches.length) {
    found.push({
      severity: 'medium', category: 'missing_info',
      title: '물질수지와 매칭된 라인 없음',
      description: pfd
        ? `물질수지 스트림 번호(${list(mb.streams.map((s) => s.id))})가 도면의 스트림 번호와 하나도 맞지 않습니다. 같은 공정의 물질수지인지 확인하세요.`
        : 'P&ID에는 보통 스트림 번호가 없어 물질수지의 스트림 번호, Line No., From/To 설비 태그로 매칭합니다. 물질수지에 Line No. 행이나 From/To 행(설비 태그)을 넣으면 매칭할 수 있습니다.',
      related_ids: [],
    });
  } else if (left.length) {
    found.push({
      severity: 'low', category: 'missing_info',
      title: `도면에서 찾지 못한 물질수지 스트림 ${left.length}개`,
      description: `물질수지 스트림 ${list(left.map((s) => s.id))}은(는) 입력한 도면에서 찾지 못했습니다. 입력하지 않은 도면 범위인지, 번호 표기가 다른지 확인하세요.`,
      related_ids: [],
    });
  }
  if (pfd && matches.length && !fromDrawing) {
    const noData = flowLines.filter((l) => l.line_no && !matched.has(l.id));
    if (noData.length) {
      found.push({
        severity: 'medium', category: 'missing_info',
        title: `물질수지에 없는 도면 스트림 ${noData.length}개`,
        description: `도면의 스트림 ${list(noData.map((l) => l.line_no))}은(는) 물질수지 표에 없습니다. 유량 등 설계 조건을 확인할 수 없어 설비·배관 용량 산정에 빠질 수 있습니다.`,
        related_ids: noData.map((l) => l.id),
      });
    }
  }

  const byId = new Map(base.lines.map((l) => [l.id, l]));
  const mbIssues = found.map((iss, i) => ({
    id: `MB-${String(i + 1).padStart(3, '0')}`, ...iss,
    loc: iss.related_ids.map((id) => byId.get(id)?.loc).find((loc) => loc?.bbox) || null,
    category_label: '물질수지', source: 'massbalance',
  }));
  const rank = { high: 0, medium: 1, low: 2 };
  const issues = [...base.issues, ...mbIssues].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const withIds = (x) => {
    const add = mbIssues.filter((i) => i.related_ids.includes(x.id)).map((i) => i.id);
    return add.length ? { ...x, issue_ids: [...x.issue_ids, ...add] } : x;
  };
  return {
    ...base,
    lines: base.lines.map(withIds),
    issues,
    stats: { ...base.stats, issues: countSeverity(issues) },
    mass_balance: {
      name: mb.name, sheet: mb.sheet, source: mb.source || 'file', properties: mb.properties, streams: mb.streams, matches,
      stats: { streams: mb.streams.length, matched_streams: usedStreams.size, lines: flowLines.length, matched_lines: matched.size },
    },
  };
}

/** 물질수지 반영 전 상태로 되돌린 사본 */
export function stripMassBalance(result) {
  if (!result.mass_balance && !result.issues.some((i) => i.source === 'massbalance')) return result;
  const issues = result.issues.filter((i) => i.source !== 'massbalance');
  const keep = new Set(issues.map((i) => i.id));
  const clean = (x) => (x.issue_ids.every((id) => keep.has(id)) ? x : { ...x, issue_ids: x.issue_ids.filter((id) => keep.has(id)) });
  const { mass_balance, ...rest } = result;
  return { ...rest, nodes: result.nodes.map(clean), lines: result.lines.map(clean), issues, stats: { ...result.stats, issues: countSeverity(issues) } };
}

/** 결과에 들어 있는 물질수지에서 다시 적용할 원본 표만 꺼낸다 */
export const massBalanceSource = (mbInResult) => (mbInResult
  ? { name: mbInResult.name, sheet: mbInResult.sheet, source: mbInResult.source, properties: mbInResult.properties, streams: mbInResult.streams } : null);

const countSeverity = (issues) => issues.reduce((a, i) => { a[i.severity] = (a[i.severity] || 0) + 1; return a; }, { high: 0, medium: 0, low: 0 });

// ------------------------------------------------------------------ Flow 표시 값
/**
 * Flow에 표시할 수 있는 값 목록: 물질수지 속성 + 도면 스트림 표 항목 (같은 이름·단위는 하나로)
 * @returns {Array<{key, name, unit, flow:boolean}>}
 */
export const LI_KEY = 'li:gpl';

export function valueOptions(result) {
  const out = new Map();
  // 물질수지에서 계산한 Li 농도(g/L)도 표시 항목으로 고를 수 있다
  const mbx = result.mass_balance;
  if (mbx?.streams.some((st) => lithiumGpl(st, mbx.properties))) out.set(LI_KEY, { key: LI_KEY, name: 'Li 농도', unit: 'g/L', flow: false });
  for (const p of result.mass_balance?.properties || []) out.set(p.key, { key: p.key, name: p.name, unit: p.unit, flow: !p.group && FLOW_RE.test(p.name) });
  for (const l of result.lines) {
    for (const sp of l.specs || []) {
      const k = specKey(sp.name);
      if (out.has(k) || !Number.isFinite(toNumber(sp.value))) continue;
      const { name, unit } = splitLabel(sp.name);
      out.set(k, { key: k, name, unit, flow: FLOW_RE.test(name) });
    }
  }
  return [...out.values()];
}

/** 기본 표시 값: 정상(Normal/Nominal) 질량 유량 > 다른 유량 */
export function defaultValueKey(options) {
  const score = (o) => (!o.flow ? -1 : (/mass|질량/i.test(o.name) ? 4 : 0) + (/normal|nominal|total|정상/i.test(o.name) ? 2 : 0)
    - (/design|max|min|설계/i.test(o.name) ? 1 : 0) + (/kg\/h|t\/h/i.test(o.unit) ? 1 : 0));
  const best = [...options].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) >= 0 ? best.key : '';
}

/** 라인 하나의 표시 값: 매칭된 물질수지 값 우선, 없으면 도면 스트림 표 값 */
export function lineValue(line, key, streamOf, properties = []) {
  const s = streamOf(line.id);
  if (key === LI_KEY) {
    const li = s ? lithiumGpl(s, properties) : null;
    return li ? { value: `${formatGpl(li.gpl)}${li.basis === 'stream' ? '*' : ''}`, source: 'mb', stream: s, li } : null;
  }
  if (s && s.values[key] !== undefined) return { value: s.values[key], source: 'mb', stream: s };
  const sp = (line.specs || []).find((x) => specKey(x.name) === key);
  return sp ? { value: sp.value, source: 'drawing' } : null;
}

// ------------------------------------------------------------------ Li 농도 (g/L)
// 고상 리튬 화합물의 Li 질량 분율 (Li 6.941)
const LI_SOLIDS = { li2co3: 0.18785, licl: 0.16373, li2so4: 0.12626, lioh: 0.28982, liohh2o: 0.16541 };

/**
 * 물질수지 스트림의 Li 농도를 g/L로 환산한다.
 * - 액상 Li+ (% w/w) × 밀도(t/m3 = kg/L) × 10. 고형분이 없으면 밀도가 곧 액상 밀도이므로 액상 기준 농도다.
 * - 고형분이 있으면 액상 밀도를 알 수 없어 스트림(슬러리) 1 L당 용존 Li로 계산한다 (Li+ × 액상 분율 × 밀도).
 * - 고상에 Li2CO3 등 리튬 화합물이 있으면 고상 포함 총 Li도 함께 낸다.
 * @returns {null | {gpl, basis: 'liquid'|'stream'|'given', liPct, liUnit, density, densityUnit, solidsPct, totalGpl}}
 */
export function lithiumGpl(stream, properties) {
  const num = (p) => (p ? toNumber(stream.values[p.key]) : NaN);
  const nameOf = (p) => p.key.split('|')[0];
  const unitOf = (p) => p.key.split('|')[1];
  const has = (p) => stream.values[p.key] !== undefined && Number.isFinite(num(p));
  const li = properties.find((p) => /^(li\+?1?|lithium|li\(aq\))$/.test(nameOf(p)) && !/solid/i.test(p.group) && has(p));
  if (!li) return null;
  const liUnit = unitOf(li);
  const liVal = num(li);
  if (/^(g\/l|kg\/m3)$/.test(liUnit)) return { gpl: liVal, basis: 'given', liPct: null, liUnit: li.unit };
  if (/^mg\/l$/.test(liUnit)) return { gpl: liVal / 1000, basis: 'given', liPct: null, liUnit: li.unit };
  const liPct = /^(ppm\w*|mg\/kg)$/.test(liUnit) ? liVal / 1e4 : /%|wt/.test(liUnit) || !liUnit ? liVal : NaN;
  const dens = properties.find((p) => nameOf(p) === 'density' && has(p));
  if (!Number.isFinite(liPct) || !dens) return null;
  const du = unitOf(dens);
  const kgPerL = /^kg\/m3$/.test(du) ? num(dens) / 1000 : /^(t\/m3|g\/cm3|kg\/l|g\/ml|sg|)$/.test(du) ? num(dens) : NaN;
  if (!Number.isFinite(kgPerL) || kgPerL <= 0) return null;
  const solidsP = properties.find((p) => nameOf(p) === '%solids' && has(p));
  const solidsPct = solidsP ? num(solidsP) : 0;
  const liquidFrac = Math.max(0, 1 - solidsPct / 100);
  const gpl = liPct * (solidsPct > 0 ? liquidFrac : 1) * kgPerL * 10;
  // 고상 리튬 화합물 (% w/w of solids)
  let solidLiPct = 0;
  for (const p of properties) {
    const f = LI_SOLIDS[nameOf(p).replace(/\(s\)$|s$/, '')] ?? LI_SOLIDS[nameOf(p)];
    if (f && /solid/i.test(p.group) && has(p)) solidLiPct += num(p) * f;
  }
  const totalGpl = solidsPct > 0 && solidLiPct > 0 ? (liPct * liquidFrac + solidLiPct * (solidsPct / 100)) * kgPerL * 10 : null;
  return {
    gpl, basis: solidsPct > 0 ? 'stream' : 'liquid', liPct, liUnit: li.unit,
    density: num(dens), densityUnit: dens.unit, solidsPct, totalGpl,
  };
}
