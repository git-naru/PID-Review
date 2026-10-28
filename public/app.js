import * as pdfjsLib from './vendor/pdf.min.mjs';
import { analyzeInBrowser } from './engine.js';
import { setupChatMode } from './chatmode.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

// 실행 환경: 로컬 서버(Node, API 키 사용) 또는 claude.ai 아티팩트(사용자 계정의 Claude 사용)
const IN_ARTIFACT = Boolean(window.claude);
// 아티팩트는 두 가지: 페이지에서 바로 분석(sample) / 도면만 올리고 Claude Code 채팅에서 분석(chat)
const MODE = !IN_ARTIFACT ? 'server' : document.querySelector('meta[name="pid-mode"]')?.content === 'chat' ? 'chat' : 'sample';
const runtime = { sample: null, downloads: null, abort: null, chat: null };
let runAction = () => analyzeWithAccount(true);

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORY_LABEL = {
  equipment: '설비', instrument: '계기', valve: '밸브', offpage: 'Off-page', battery_limit: 'Battery Limit', other: '기타', unknown: '연결처 없음',
};
const KIND_LABEL = { process: '공정', utility: '유틸리티', signal: '신호선' };
const SEV_LABEL = { high: '높음', medium: '중간', low: '낮음' };
const CONF_LABEL = { high: '높음', medium: '보통', low: '낮음' };

const state = {
  pending: [], // 분석 대기 중인 File 목록
  sources: [], // 분석에 사용된 PDF 원본 (ArrayBuffer) - file_index 순서
  result: null,
  tab: 'equipment',
  sev: 'all',
  selected: null, // {type:'node'|'line'|'issue', id}
  pdfDocs: new Map(),
};

// ------------------------------------------------------------------ 초기화
async function init() {
  bindUpload();
  bindLists();
  bindViewer();
  bindFlowToolbar();
  $('#btnStop').addEventListener('click', () => runtime.abort?.abort());
  $('#btnResume').addEventListener('click', () => runAction());
  $('#tierSelect').hidden = MODE !== 'sample';
  const n = $('#apiNotice');
  if (MODE === 'chat') {
    $('#btnPick').textContent = '도면 올리기';
    $('#btnAnalyze').textContent = '분석 요청';
    runtime.chat = await setupChatMode({
      $, esc, toast, applyResult, showRunBox,
      setRunAction: (fn) => { runAction = fn; },
      setDownloads: (d) => { runtime.downloads = d; },
    });
    return;
  }
  if (IN_ARTIFACT) {
    [runtime.sample, runtime.downloads] = await Promise.all([
      window.claude.use('sample').catch(() => null),
      window.claude.use('downloads').catch(() => null),
    ]);
    n.hidden = false;
    if (runtime.sample) {
      n.className = 'notice info';
      n.textContent = '분석은 지금 로그인한 claude.ai 계정의 Claude로 실행됩니다. API 키나 추가 결제가 필요 없고, 요금제 사용량에 포함됩니다. 처음 분석할 때 Claude 사용 허용을 묻습니다.';
    } else {
      n.textContent = '이 화면에서는 Claude 분석을 사용할 수 없습니다. claude.ai에 로그인한 상태에서 이 페이지를 열어 주세요. "샘플 데모"는 그대로 볼 수 있습니다.';
    }
    return;
  }
  try {
    const st = await (await fetch('api/status')).json();
    if (!st.apiConfigured) {
      n.hidden = false;
      n.textContent = '서버에 ANTHROPIC_API_KEY가 설정되지 않아 실제 도면 분석은 할 수 없습니다. "샘플 데모"로 기능을 먼저 확인하거나, 키를 설정한 뒤 서버를 다시 시작하세요.';
    }
  } catch { /* 서버 상태 확인 실패 시 무시 */ }
}

// ------------------------------------------------------------------ 업로드
function bindUpload() {
  const input = $('#fileInput');
  $('#btnPick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });
  $('#btnAnalyze').addEventListener('click', analyze);
  $('#btnDemo').addEventListener('click', loadDemo);

  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('#dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('#dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#dropOverlay').hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  $('#btnExport').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; });
  document.addEventListener('click', () => { $('#exportMenu').hidden = true; });
  $('#exportMenu').addEventListener('click', (e) => {
    const kind = e.target.closest('[data-export]')?.dataset.export;
    if (kind) exportData(kind);
  });
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function addFiles(files) {
  if (MODE === 'chat') {
    runtime.chat?.upload(files);
    return;
  }
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdfs.length < files.length) toast('PDF 파일만 입력할 수 있습니다.', true);
  for (const f of pdfs) {
    if (!state.pending.some((p) => p.name === f.name && p.size === f.size)) state.pending.push(f);
  }
  renderChips();
}

function renderChips() {
  const ul = $('#fileChips');
  ul.innerHTML = state.pending.map((f, i) => `<li title="${esc(f.name)}"><span>${esc(f.name)}</span><span class="size">${(f.size / 1048576).toFixed(1)}MB</span><button type="button" data-rm="${i}" aria-label="삭제">×</button></li>`).join('');
  ul.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    state.pending.splice(Number(b.dataset.rm), 1);
    renderChips();
  }));
  $('#fileHint').textContent = state.pending.length ? `분석 대기 ${state.pending.length}개 파일` : '입력된 파일 없음 — 한 장 또는 여러 장의 P&ID PDF를 선택하거나 이 화면에 끌어다 놓으세요.';
  $('#btnAnalyze').disabled = state.pending.length === 0;
}

async function analyze() {
  if (MODE === 'chat') return runtime.chat?.request();
  if (IN_ARTIFACT) return analyzeWithAccount();
  const files = [...state.pending];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f, f.name));
  setBusy(true, '파일 업로드 중...');
  const started = Date.now();
  const timer = setInterval(() => { $('#progressTime').textContent = `${Math.round((Date.now() - started) / 1000)}초 경과`; }, 1000);
  try {
    const res = await fetch('api/analyze', { method: 'POST', body: fd });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `서버 오류 (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'progress') {
          $('#progressText').textContent = ev.message || (ev.stage === 'generating' ? `Claude가 분석 결과를 작성 중입니다... (${ev.chars.toLocaleString()}자)` : '분석 중...');
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        } else if (ev.type === 'result') {
          result = ev.data;
        }
      }
    }
    if (!result) throw new Error('분석 결과를 받지 못했습니다.');
    const sources = await Promise.all(files.map((f) => f.arrayBuffer()));
    state.pending = [];
    renderChips();
    applyResult(result, sources);
  } catch (err) {
    toast(err.message, true);
  } finally {
    clearInterval(timer);
    setBusy(false);
  }
}

/** claude.ai 아티팩트: 브라우저에서 사용자 계정의 Claude로 분석 */
async function analyzeWithAccount(resume = false) {
  const files = resume ? state.lastRun?.files || [] : [...state.pending];
  if (!files.length) return;
  if (!runtime.sample) {
    toast('이 화면에서는 Claude 분석을 사용할 수 없습니다. claude.ai에 로그인한 상태에서 열어 주세요.', true);
    return;
  }
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > 60 * 1048576) {
    toast(`PDF 총 용량이 ${(total / 1048576).toFixed(1)}MB입니다. 60MB 이하로 나누어 분석해 주세요.`, true);
    return;
  }
  state.lastRun = { files };
  runAction = () => analyzeWithAccount(true);
  showRunBox(null);
  runtime.abort = new AbortController();
  setBusy(true, 'PDF를 여는 중...', true);
  const started = Date.now();
  const timer = setInterval(() => { $('#progressTime').textContent = `${Math.round((Date.now() - started) / 1000)}초 경과`; }, 1000);
  let sources = null;
  try {
    sources = await Promise.all(files.map((f) => f.arrayBuffer()));
    const result = await analyzeInBrowser({
      files: files.map((f, i) => ({ name: f.name, buffer: sources[i] })),
      sample: runtime.sample,
      pdfjs: pdfjsLib,
      tier: $('#tierSelect').value,
      signal: runtime.abort.signal,
      onProgress: (msg) => { $('#progressText').textContent = msg; },
      onPartial: (partial) => applyResult(partial, sources),
    });
    if (!resume) {
      state.pending = [];
      renderChips();
    }
    applyResult(result, sources);
    const p = result.meta.progress;
    if (p.failed) showRunBox(`P&ID ${p.total}장 중 ${p.done}장을 판독했고 ${p.failed}장은 실패했습니다. 실패한 시트는 검토 항목에 표시되어 있습니다.`, '실패한 시트 다시 분석');
    else toast(`P&ID ${p.total}장 판독을 마쳤습니다.`);
  } catch (err) {
    if (err.partial) applyResult(err.partial, sources);
    const canResume = err.code !== 'not_granted' && err.code !== 'sampling_disabled';
    showRunBox(err.message, canResume && sources ? '이어서 분석' : null, err.code !== 'cancelled');
  } finally {
    clearInterval(timer);
    runtime.abort = null;
    setBusy(false);
  }
}

/** 분석이 멈추거나 일부 실패했을 때 남는 안내 (토스트와 달리 사라지지 않는다) */
function showRunBox(message, actionLabel = null, isError = false) {
  const box = $('#runBox');
  box.hidden = !message;
  if (!message) return;
  box.classList.toggle('error', isError);
  $('#runText').textContent = message;
  $('#btnResume').hidden = !actionLabel;
  $('#btnResume').textContent = actionLabel || '';
  $('#statusBar').hidden = false;
}

async function loadDemo() {
  setBusy(true, '샘플 도면과 분석 결과를 불러오는 중...');
  try {
    const res = await fetch(IN_ARTIFACT ? 'demo-result.json' : 'api/demo');
    if (!res.ok) throw new Error(`샘플 로드 실패 (${res.status})`);
    const result = await res.json();
    const sources = await Promise.all(result.sampleUrls.map(async (u) => (await fetch(u)).arrayBuffer()));
    applyResult(result, sources);
    toast('샘플 범례(PID-100-000) + P&ID 2장(PID-100-001, 002)에 대한 데모 결과입니다.\n검토 필요 항목을 더블클릭해 도면 위치를 확인해 보세요.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, msg, stoppable = false) {
  ['#btnPick', '#btnDemo', '#tierSelect', '#btnResume'].forEach((s) => { $(s).disabled = busy; });
  $('#btnStop').hidden = !(busy && stoppable);
  $('#btnAnalyze').disabled = busy || state.pending.length === 0;
  $('#statusBar').hidden = !busy && !state.result && $('#runBox').hidden;
  if (!busy) runtime.chat?.refresh();
  $('#progress').hidden = !busy;
  if (busy) {
    $('#progressText').textContent = msg;
    $('#progressTime').textContent = '';
  }
}

// ------------------------------------------------------------------ 결과 반영
function applyResult(result, sources) {
  // 같은 파일의 중간 결과 갱신이면 열린 PDF와 선택 항목을 유지
  const sameSources = sources === state.sources;
  if (!sameSources) {
    for (const task of state.pdfDocs.values()) task.destroy();
    state.pdfDocs.clear();
  }
  const prevSel = state.selected;
  const prevFilter = $('#drawingFilter').value;
  state.result = result;
  state.sources = sources;
  state.selected = null;
  if (sameSources && prevSel) {
    const exists = prevSel.type === 'node' ? result.nodes.some((n) => n.id === prevSel.id)
      : prevSel.type === 'line' ? result.lines.some((l) => l.id === prevSel.id)
        : prevSel.type === 'issue' ? result.issues.some((i) => i.id === prevSel.id) : true;
    if (exists) state.selected = prevSel;
  }

  $('#statusBar').hidden = false;
  $('#summary').hidden = false;
  $('#summaryText').textContent = result.summary || '';
  const s = result.stats;
  $('#stats').innerHTML = [
    ['도면', result.drawings.length || result.files.length],
    ['설비', s.equipment], ['배관', s.lines], ['계기', s.instruments], ['밸브', s.valves],
  ].map(([k, v]) => `<span class="stat">${k}<b>${v}</b></span>`).join('')
    + `<span class="stat high">검토 높음<b>${s.issues.high}</b></span><span class="stat medium">중간<b>${s.issues.medium}</b></span><span class="stat">낮음<b>${s.issues.low}</b></span>`
    + (result.legend?.found ? `<span class="stat">범례 적용<b>✓</b></span>` : '<span class="stat medium">범례 미입력</span>')
    + (result.meta?.demo ? '<span class="stat">데모 결과</span>' : '')
    + (result.meta?.progress && result.meta.progress.done < result.meta.progress.total
      ? `<span class="stat medium">판독<b>${result.meta.progress.done}/${result.meta.progress.total}</b></span>` : '');
  $('#btnExport').disabled = false;

  const sel = $('#drawingFilter');
  sel.innerHTML = '<option value="all">전체 도면</option>' + pagesOf(result).map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join('');
  if (sameSources && [...sel.options].some((o) => o.value === prevFilter)) sel.value = prevFilter;

  $('#cntEquipment').textContent = equipmentRows().length;
  $('#cntLines').textContent = lineRows().length;
  $('#cntInstruments').textContent = instrumentRows().length;
  $('#cntLegend').textContent = legendRows().length;

  renderFlow();
  renderList();
  renderIssues();
  renderDetail();
}

function pagesOf(result) {
  const out = [];
  result.files.forEach((f) => {
    for (let p = 1; p <= f.pageCount; p++) {
      const d = result.drawings.find((x) => x.file_index === f.index && x.page === p);
      const legendTag = d?.sheet_type === 'legend' ? ' (범례)' : '';
      out.push({ key: `${f.index}:${p}`, label: (d?.drawing_no ? `${d.drawing_no}${d.title ? ` - ${d.title}` : ''}` : `${f.name} p.${p}`) + legendTag });
    }
  });
  return out;
}

function drawingLabel(loc) {
  if (!loc || !state.result) return '-';
  const d = state.result.drawings.find((x) => x.file_index === loc.file_index && x.page === loc.page);
  if (d?.drawing_no) return d.drawing_no;
  const f = state.result.files[loc.file_index];
  return f ? `${f.name} p.${loc.page}` : '-';
}

const nodeById = (id) => state.result?.nodes.find((n) => n.id === id);
const lineById = (id) => state.result?.lines.find((l) => l.id === id);
const issueById = (id) => state.result?.issues.find((i) => i.id === id);
const nodeName = (id) => { const n = nodeById(id); return n ? (n.tag || n.name || n.id) : ''; };

// ------------------------------------------------------------------ Flow (Cytoscape)
let cy = null;

function bindFlowToolbar() {
  ['#optInstruments', '#optUtility', '#drawingFilter'].forEach((s) => $(s).addEventListener('change', applyFlowFilter));
  $('#btnFit').addEventListener('click', () => cy?.fit(cy.elements(':visible'), 30));
}

function renderFlow() {
  const r = state.result;
  $('#flowEmpty').hidden = true;
  const els = [];
  for (const n of r.nodes) {
    els.push({
      group: 'nodes',
      data: { id: `n:${n.id}`, ref: n.id, type: 'node', category: n.category, label: nodeLabel(n), page: `${n.loc.file_index}:${n.loc.page}` },
      classes: [n.category, n.issue_ids.length ? 'flag' : ''].join(' '),
    });
  }
  for (const l of r.lines) {
    let src = l.from_id ? `n:${l.from_id}` : null;
    let tgt = l.to_id ? `n:${l.to_id}` : null;
    const page = `${l.loc.file_index}:${l.loc.page}`;
    // 연결처가 없는 끝단은 "?" 노드로 표시
    if (!src) { src = `u:${l.id}:from`; els.push({ group: 'nodes', data: { id: src, ref: l.id, type: 'dangling', category: 'unknown', label: '?', page }, classes: 'unknown' }); }
    if (!tgt) { tgt = `u:${l.id}:to`; els.push({ group: 'nodes', data: { id: tgt, ref: l.id, type: 'dangling', category: 'unknown', label: '?', page }, classes: 'unknown' }); }
    els.push({
      group: 'edges',
      data: { id: `l:${l.id}`, ref: l.id, type: 'line', source: src, target: tgt, kind: l.kind, label: l.kind === 'signal' ? '' : (l.line_no || '(번호 없음)') },
      classes: [l.kind, l.issue_ids.length ? 'flag' : ''].join(' '),
    });
  }
  // 라인에 설치된 계기·밸브는 해당 라인의 상류 설비 옆에 점선으로 연결 (배치용)
  for (const l of r.lines) {
    for (const t of l.inline_items) {
      const n = r.nodes.find((x) => x.tag && x.tag.toUpperCase() === t.toUpperCase());
      const anchor = l.from_id || l.to_id;
      if (!n || !anchor || anchor === n.id) continue;
      els.push({ group: 'edges', data: { id: `a:${l.id}:${n.id}`, ref: n.id, type: 'assoc', source: `n:${anchor}`, target: `n:${n.id}`, kind: 'assoc', label: '' }, classes: 'assoc' });
    }
  }
  for (const k of r.links) {
    els.push({ group: 'edges', data: { id: `k:${k.id}`, ref: k.id, type: 'link', source: `n:${k.from_id}`, target: `n:${k.to_id}`, label: '도면 연결' }, classes: 'link' });
  }

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $('#cy'),
    elements: els,
    minZoom: 0.15,
    maxZoom: 3,
    style: flowStyle(),
  });
  cy.on('tap', 'node, edge', (e) => {
    const d = e.target.data();
    if (d.type === 'node' || d.type === 'assoc') select({ type: 'node', id: d.ref }, 'flow');
    else if (d.type === 'line' || d.type === 'dangling') select({ type: 'line', id: d.ref }, 'flow');
  });
  cy.on('tap', (e) => { if (e.target === cy) { cy.elements().unselect(); } });
  cy.on('dbltap', 'node, edge', (e) => {
    const d = e.target.data();
    const item = d.type === 'node' ? nodeById(d.ref) : lineById(d.ref);
    if (item) openViewer(viewTarget(item, d.type === 'node' ? 'node' : 'line'));
  });
  applyFlowFilter();
}

function nodeLabel(n) {
  if (n.category === 'equipment') return `${n.tag || n.id}\n${n.name}`;
  if (n.category === 'offpage') return n.name || n.tag || n.offpage_ref;
  if (n.category === 'battery_limit') return n.tag || n.name || n.offpage_ref;
  return n.tag || n.name || n.id;
}

function applyFlowFilter() {
  if (!cy) return;
  const showIns = $('#optInstruments').checked;
  const showUt = $('#optUtility').checked;
  const page = $('#drawingFilter').value;
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const c = n.data('category');
      let vis = showIns || !(c === 'instrument' || c === 'valve');
      if (page !== 'all' && n.data('page') !== page) vis = false;
      n.style('display', vis ? 'element' : 'none');
    });
    cy.edges().forEach((e) => {
      const k = e.data('kind');
      let vis = ((k !== 'signal' && k !== 'assoc') || showIns) && (k !== 'utility' || showUt);
      if (e.data('type') === 'link' && page !== 'all') vis = false;
      e.style('display', vis ? 'element' : 'none');
    });
    // 보이는 간선이 없는 유틸리티 B.L./미연결 끝단 노드는 숨김
    cy.nodes().forEach((n) => {
      if (n.style('display') === 'none') return;
      const c = n.data('category');
      if ((c === 'unknown' || c === 'battery_limit') && n.connectedEdges().filter((e) => e.style('display') !== 'none').length === 0) n.style('display', 'none');
    });
  });
  const visible = cy.elements().filter((e) => e.style('display') !== 'none');
  visible.layout({
    name: 'dagre', rankDir: 'LR', nodeSep: 28, rankSep: 70, edgeSep: 12, animate: false,
    fit: true, padding: 30,
  }).run();
}

// 라벨 길이에 맞춘 노드 크기 (cytoscape의 width:'label'은 deprecated)
const labelLines = (ele) => String(ele.data('label') || '').split('\n');
const labelWidth = (charW, pad) => (ele) => Math.max(40, Math.min(170, Math.max(...labelLines(ele).map((l) => l.length)) * charW) + pad);
const labelHeight = (lineH, pad) => (ele) => labelLines(ele).length * lineH + pad;

/** 테마 토큰(CSS 변수)에서 Flow 색을 읽어 라이트/다크 모두 맞춘다 */
function flowStyle() {
  const cs = getComputedStyle(document.documentElement);
  const t = (name) => cs.getPropertyValue(name).trim();
  const [text, surface, muted, primary, primaryWeak, accent, medium, mediumWeak, high, highWeak, opc, opcWeak, line, utility, signal, border, surface2] =
    ['--text', '--surface', '--muted', '--primary', '--primary-weak', '--accent', '--medium', '--medium-weak', '--high', '--high-weak',
      '--opc', '--opc-weak', '--line', '--utility', '--signal', '--border', '--surface-2'].map(t);
  const font = t('--font-body');
  return [
    { selector: 'node', style: {
      label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center',
      'font-size': 10, 'font-family': font, color: text,
      'background-color': surface, 'border-width': 2, 'border-color': muted, width: 34, height: 34,
    } },
    { selector: 'node.equipment', style: {
      shape: 'round-rectangle', 'background-color': primaryWeak, 'border-color': primary, width: labelWidth(7, 24), height: labelHeight(13, 18),
      padding: 0, 'font-size': 11, 'font-weight': 700, 'text-max-width': 140,
    } },
    { selector: 'node.instrument', style: { shape: 'ellipse', 'border-color': accent, width: 46, height: 46, 'font-size': 9, 'text-max-width': 42 } },
    { selector: 'node.valve', style: { shape: 'diamond', 'background-color': mediumWeak, 'border-color': medium, width: 54, height: 40, 'font-size': 9 } },
    { selector: 'node.offpage', style: { shape: 'tag', 'background-color': opcWeak, 'border-color': opc, width: labelWidth(6.2, 26), height: 26, 'font-size': 9.5, 'font-weight': 700 } },
    { selector: 'node.battery_limit', style: { shape: 'hexagon', 'background-color': surface2, 'border-color': opc, width: labelWidth(6.2, 26), height: 26, 'font-size': 9.5 } },
    { selector: 'node.other', style: { shape: 'round-rectangle', width: labelWidth(6, 16), height: 26 } },
    { selector: 'node.unknown', style: { shape: 'ellipse', width: 22, height: 22, 'border-color': high, 'border-style': 'dashed', color: high, 'font-weight': 700, 'background-color': highWeak } },
    { selector: 'node.flag', style: { 'border-color': high, 'border-width': 3, 'underlay-color': high, 'underlay-opacity': 0.14, 'underlay-padding': 6 } },
    { selector: 'edge', style: {
      width: 2, 'line-color': line, 'target-arrow-color': line, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
      'curve-style': 'taxi', 'taxi-direction': 'rightward', 'taxi-turn': '50%',
      label: 'data(label)', 'font-size': 9, 'font-family': font, 'text-background-color': surface, 'text-background-opacity': 0.9, 'text-background-padding': 2,
      'text-rotation': 'none', color: text,
    } },
    { selector: 'edge.utility', style: { 'line-color': utility, 'target-arrow-color': utility, 'line-style': 'dashed', width: 1.6, color: utility } },
    { selector: 'edge.signal', style: { 'line-color': signal, 'target-arrow-shape': 'none', 'line-style': 'dotted', width: 1.2, 'curve-style': 'bezier' } },
    { selector: 'edge.assoc', style: { 'line-color': border, 'target-arrow-shape': 'none', 'line-style': 'dotted', width: 1.2, 'curve-style': 'bezier' } },
    { selector: 'edge.link', style: { 'line-color': opc, 'target-arrow-color': opc, 'line-style': 'dashed', width: 2, color: opc, 'curve-style': 'bezier' } },
    { selector: 'edge.flag', style: { 'line-color': high, 'target-arrow-color': high, color: high } },
    { selector: ':selected', style: { 'overlay-color': primary, 'overlay-opacity': 0.2, 'overlay-padding': 6 } },
    { selector: 'edge:selected', style: { width: 4 } },
  ];
}

// 테마가 바뀌면 Flow 색도 다시 적용
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => cy?.style(flowStyle()));
new MutationObserver(() => cy?.style(flowStyle())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function highlightInFlow(ids, focus) {
  if (!cy) return;
  cy.elements().unselect();
  const eles = cy.collection();
  for (const id of ids) eles.merge(cy.getElementById(`n:${id}`)).merge(cy.getElementById(`l:${id}`));
  const visible = eles.filter((e) => e.style('display') !== 'none');
  visible.select();
  if (focus && visible.length) cy.animate({ center: { eles: visible }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 250 });
}

// ------------------------------------------------------------------ 선택 / 상세
function select(sel, from) {
  state.selected = sel;
  let ids = [sel.id];
  if (sel.type === 'issue') ids = issueById(sel.id)?.related_ids || [];
  if (from !== 'flow') highlightInFlow(ids, true);
  else highlightInFlow(ids, false);
  renderDetail();
  markSelectedRows();
}

function renderDetail() {
  const box = $('#detail');
  const sel = state.selected;
  if (!state.result || !sel) {
    box.innerHTML = '<p class="muted">Flow 또는 리스트에서 항목을 선택하세요.</p>';
    return;
  }
  if (sel.type === 'node') box.innerHTML = nodeDetail(nodeById(sel.id));
  else if (sel.type === 'line') box.innerHTML = lineDetail(lineById(sel.id));
  else if (sel.type === 'legend') box.innerHTML = legendDetail(legendById(sel.id));
  else box.innerHTML = issueDetail(issueById(sel.id));

  box.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => {
    const [type, ...rest] = el.dataset.go.split(':');
    select({ type, id: rest.join(':') });
  }));
  box.querySelector('[data-view]')?.addEventListener('click', () => {
    const item = sel.type === 'node' ? nodeById(sel.id) : sel.type === 'line' ? lineById(sel.id) : sel.type === 'legend' ? legendById(sel.id) : issueById(sel.id);
    openViewer(viewTarget(item, sel.type));
  });
}

const goNode = (id) => (id ? `<button class="link" data-go="node:${esc(id)}">${esc(nodeName(id))}</button>` : '<span class="warn" style="color:var(--high)">연결처 없음</span>');
const goLine = (l) => `<button class="link" data-go="line:${esc(l.id)}">${esc(l.line_no || l.id)}</button>`;
const locText = (loc) => (loc ? `${esc(drawingLabel(loc))} (${loc.source === 'text' ? '텍스트 위치 확인' : loc.source === 'model' ? 'AI 추정 위치' : '위치 정보 없음'})` : '-');

function issuesBlock(ids) {
  if (!ids?.length) return '';
  return '<h4>검토 필요 사항</h4>' + ids.map(issueById).filter(Boolean).map((i) => `<div class="issue-mini ${i.severity}" data-go="issue:${esc(i.id)}"><b>[${SEV_LABEL[i.severity]}] ${esc(i.title)}</b><br>${esc(i.description)}</div>`).join('');
}

function nodeDetail(n) {
  if (!n) return '<p class="muted">항목을 찾을 수 없습니다.</p>';
  const lines = state.result.lines.filter((l) => l.from_id === n.id || l.to_id === n.id);
  const onLines = state.result.lines.filter((l) => l.inline_items.some((t) => t.toUpperCase() === (n.tag || '').toUpperCase()));
  return `
    <span class="badge ${n.category}">${CATEGORY_LABEL[n.category] || n.category}</span>
    <h3>${esc(n.tag || n.name || n.id)}</h3>
    <p class="sub">${esc(n.name)}</p>
    <table class="kv">
      <tr><th>형식</th><td>${esc(n.equipment_type) || '-'}</td></tr>
      <tr><th>Service</th><td>${esc(n.service) || '-'}</td></tr>
      ${n.offpage_ref ? `<tr><th>참조</th><td>${esc(n.offpage_ref)}</td></tr>` : ''}
      <tr><th>도면</th><td>${locText(n.loc)}</td></tr>
      <tr><th>판독 신뢰도</th><td>${CONF_LABEL[n.confidence] || n.confidence}</td></tr>
      ${n.note ? `<tr><th>비고</th><td>${esc(n.note)}</td></tr>` : ''}
    </table>
    ${n.specs.length ? `<h4>사양</h4><table class="kv">${n.specs.map((s) => `<tr><th>${esc(s.name)}</th><td>${esc(s.value)}</td></tr>`).join('')}</table>` : ''}
    <h4>연결 배관 (${lines.length})</h4>
    ${lines.length ? `<ul>${lines.map((l) => `<li>${goLine(l)} <span class="muted">${KIND_LABEL[l.kind]} · ${l.from_id === n.id ? `→ ${esc(nodeName(l.to_id) || '?')}` : `← ${esc(nodeName(l.from_id) || '?')}`}</span></li>`).join('')}</ul>` : '<p class="muted">연결된 배관 없음</p>'}
    ${onLines.length ? `<h4>설치 라인</h4><ul>${onLines.map((l) => `<li>${goLine(l)}</li>`).join('')}</ul>` : ''}
    ${issuesBlock(n.issue_ids)}
    <div class="actions-row"><button class="btn small primary" data-view>도면에서 위치 보기</button></div>`;
}

function lineDetail(l) {
  if (!l) return '<p class="muted">항목을 찾을 수 없습니다.</p>';
  const missing = (v) => (v ? esc(v) : '<span style="color:var(--high)">미표기</span>');
  return `
    <span class="badge line">${KIND_LABEL[l.kind]} 배관</span>
    <h3>${esc(l.line_no || '(라인 번호 없음)')}</h3>
    <p class="sub">${esc(l.service)}</p>
    <table class="kv">
      <tr><th>From</th><td>${goNode(l.from_id)}</td></tr>
      <tr><th>To</th><td>${goNode(l.to_id)}</td></tr>
      ${l.kind === 'signal' ? '' : `
      <tr><th>관경</th><td>${missing(l.size)}</td></tr>
      <tr><th>유체 코드</th><td>${esc(l.fluid_code) || '-'}${l.fluid_desc ? ` <span class="muted">${esc(l.fluid_desc)}</span>` : ''}</td></tr>
      <tr><th>Spec/Class</th><td>${missing(l.spec_class)}${l.class_desc ? `<br><span class="muted">${esc(l.class_desc)}</span>` : ''}</td></tr>
      <tr><th>보온/보냉</th><td>${esc(l.insulation) || '-'}</td></tr>`}
      <tr><th>도면</th><td>${locText(l.loc)}</td></tr>
      <tr><th>판독 신뢰도</th><td>${CONF_LABEL[l.confidence] || l.confidence}</td></tr>
      ${l.note ? `<tr><th>비고</th><td>${esc(l.note)}</td></tr>` : ''}
    </table>
    ${l.inline_items.length ? `<h4>설치 계기·밸브</h4><ul>${l.inline_items.map((t) => { const n = state.result.nodes.find((x) => x.tag.toUpperCase() === t.toUpperCase()); return `<li>${n ? goNode(n.id) : esc(t)}</li>`; }).join('')}</ul>` : ''}
    ${issuesBlock(l.issue_ids)}
    <div class="actions-row"><button class="btn small primary" data-view>도면에서 위치 보기</button></div>`;
}

function legendDetail(e) {
  if (!e) return '<p class="muted">항목을 찾을 수 없습니다.</p>';
  const up = (v) => String(v || '').toUpperCase();
  const users = e.section === '배관 Class' ? lineRows().filter((l) => up(l.spec_class) === up(e.code))
    : e.section === '유체 코드' ? lineRows().filter((l) => up(l.fluid_code) === up(e.code)) : [];
  return `
    <span class="badge">범례 · ${esc(e.section)}</span>
    <h3 style="margin-top:6px">${esc(e.code)}</h3>
    <p>${esc(e.description)}</p>
    ${users.length ? `<h4>적용 라인 (${users.length})</h4><ul>${users.map((l) => `<li>${goLine(l)} <span class="muted">${esc(l.size)}</span></li>`).join('')}</ul>` : ''}
    <div class="actions-row"><button class="btn small primary" data-view>범례 시트에서 보기</button></div>`;
}

function issueDetail(i) {
  if (!i) return '<p class="muted">항목을 찾을 수 없습니다.</p>';
  const rel = i.related_ids.map((id) => (nodeById(id) ? goNode(id) : lineById(id) ? goLine(lineById(id)) : esc(id)));
  return `
    <span class="badge ${i.severity}">심각도 ${SEV_LABEL[i.severity]}</span> <span class="badge">${esc(i.category_label)}</span>
    <h3 style="margin-top:6px">${esc(i.title)}</h3>
    <p>${esc(i.description)}</p>
    <table class="kv">
      <tr><th>관련 항목</th><td>${rel.join(', ') || '-'}</td></tr>
      <tr><th>도면</th><td>${locText(i.loc)}</td></tr>
      <tr><th>검출</th><td>${i.source === 'model' ? 'AI 도면 판독' : '연결성 규칙 검증'}</td></tr>
    </table>
    <div class="actions-row"><button class="btn small primary" data-view>도면에서 위치 보기</button></div>`;
}

// ------------------------------------------------------------------ 리스트
function bindLists() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    state.tab = t.dataset.tab;
    renderList();
  }));
  $('#listSearch').addEventListener('input', renderList);
  $('#sevFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sev]');
    if (!b) return;
    state.sev = b.dataset.sev;
    document.querySelectorAll('.sev-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderIssues();
  });
}

const specSummary = (n) => n.specs.map((s) => `${s.name}: ${s.value}`).join(' · ');
const equipmentRows = () => (state.result?.nodes || []).filter((n) => n.category === 'equipment');
const lineRows = () => (state.result?.lines || []).filter((l) => l.kind !== 'signal');
const instrumentRows = () => (state.result?.nodes || []).filter((n) => n.category === 'instrument' || n.category === 'valve');
const installedOn = (n) => {
  const l = state.result.lines.find((x) => x.inline_items.some((t) => t.toUpperCase() === (n.tag || '').toUpperCase()));
  if (l) return l.line_no || l.id;
  const s = state.result.lines.find((x) => x.kind === 'signal' && (x.from_id === n.id || x.to_id === n.id));
  return s ? nodeName(s.from_id === n.id ? s.to_id : s.from_id) : '';
};

const LIST_DEFS = {
  equipment: {
    rows: equipmentRows,
    cols: [['No', 44], ['Tag', 96], ['명칭', 170], ['형식', 120], ['주요 사양', null], ['도면', 110], ['검토', 52]],
    cells: (n, i) => [i + 1, `<span class="tag">${esc(n.tag || n.id)}</span>`, esc(n.name), esc(n.equipment_type), esc(specSummary(n)) || '<span class="muted">-</span>', esc(drawingLabel(n.loc)), n.issue_ids.length ? `<span class="warn">⚠ ${n.issue_ids.length}</span>` : ''],
    title: (n) => specSummary(n),
    type: 'node',
    search: (n) => `${n.tag} ${n.name} ${n.equipment_type} ${n.service}`,
  },
  lines: {
    rows: lineRows,
    cols: [['No', 44], ['Line No.', 150], ['관경', 64], ['유체', 64], ['Spec', 70], ['From', 110], ['To', 110], ['구분', 70], ['도면', 110], ['검토', 52]],
    cells: (l, i) => [i + 1, `<span class="tag">${esc(l.line_no) || '<span class="warn">번호 없음</span>'}</span>`, esc(l.size) || '<span class="warn">-</span>', esc(l.fluid_code), esc(l.spec_class) || '<span class="warn">-</span>', esc(nodeName(l.from_id)) || '<span class="warn">미연결</span>', esc(nodeName(l.to_id)) || '<span class="warn">미연결</span>', KIND_LABEL[l.kind], esc(drawingLabel(l.loc)), l.issue_ids.length ? `<span class="warn">⚠ ${l.issue_ids.length}</span>` : ''],
    title: (l) => [l.service, l.class_desc && `Class ${l.spec_class}: ${l.class_desc}`].filter(Boolean).join('\n'),
    type: 'line',
    search: (l) => `${l.line_no} ${l.service} ${nodeName(l.from_id)} ${nodeName(l.to_id)} ${l.spec_class}`,
  },
  instruments: {
    rows: instrumentRows,
    cols: [['No', 44], ['Tag', 96], ['명칭', 190], ['구분', 64], ['형식', 120], ['설치 위치', 150], ['도면', 110], ['검토', 52]],
    cells: (n, i) => [i + 1, `<span class="tag">${esc(n.tag || n.id)}</span>`, esc(n.name), CATEGORY_LABEL[n.category], esc(n.equipment_type), esc(installedOn(n)) || '<span class="muted">-</span>', esc(drawingLabel(n.loc)), n.issue_ids.length ? `<span class="warn">⚠ ${n.issue_ids.length}</span>` : ''],
    title: (n) => n.note,
    type: 'node',
    search: (n) => `${n.tag} ${n.name} ${n.equipment_type}`,
  },
  legend: {
    rows: legendRows,
    cols: [['No', 44], ['구분', 120], ['코드', 130], ['설명', null], ['적용', 64]],
    cells: (e, i) => [i + 1, esc(e.section), `<span class="tag">${esc(e.code)}</span>`, esc(e.description), e.used === null ? '' : e.used ? `${e.used}건` : '<span class="muted">0</span>'],
    title: (e) => e.description,
    type: 'legend',
    search: (e) => `${e.section} ${e.code} ${e.description}`,
  },
};

const LEGEND_SECTIONS = [
  ['fluid_codes', '유체 코드'], ['piping_classes', '배관 Class'], ['equipment_codes', '설비 구분'],
  ['instrument_letters', '계기 식별 문자'], ['symbols', '기호'],
];

/** 범례 탭 행: 범례 항목 + 실제 도면에서 사용된 건수 */
function legendRows() {
  const lg = state.result?.legend;
  if (!lg?.found) return [];
  const up = (v) => String(v || '').toUpperCase();
  const lines = lineRows();
  const usedCount = (key, code) => {
    if (key === 'fluid_codes') return lines.filter((l) => up(l.fluid_code) === up(code)).length;
    if (key === 'piping_classes') return lines.filter((l) => up(l.spec_class) === up(code)).length;
    if (key === 'equipment_codes') return equipmentRows().filter((n) => (up(n.tag).match(/^[A-Z]+/) || [''])[0] === up(code)).length;
    return null;
  };
  const rows = [];
  if (lg.line_number_format) rows.push({ id: 'lg:format', section: '라인 번호 체계', code: '-', description: lg.line_number_format, used: null, loc: lg.pages[0] ? { ...lg.pages[0], bbox: null, source: 'none' } : null });
  for (const [key, section] of LEGEND_SECTIONS) {
    lg[key].forEach((e, i) => rows.push({
      id: `lg:${key}:${i}`, section, used: usedCount(key, e.code), loc: e.loc, description: e.description,
      code: key === 'instrument_letters' && e.code.startsWith('+') ? `${e.code.slice(1)} (후속 문자)` : e.code,
    }));
  }
  if (lg.notes) rows.push({ id: 'lg:notes', section: '일반 노트', code: '-', description: lg.notes, used: null, loc: lg.pages[0] ? { ...lg.pages[0], bbox: null, source: 'none' } : null });
  return rows.map((r) => ({ ...r, issue_ids: [] }));
}
const legendById = (id) => legendRows().find((r) => r.id === id);

function renderList() {
  const def = LIST_DEFS[state.tab];
  const q = $('#listSearch').value.trim().toUpperCase();
  const all = def.rows();
  const rows = q ? all.filter((r) => def.search(r).toUpperCase().includes(q)) : all;
  const table = $('#listTable');
  table.querySelector('thead').innerHTML = `<tr>${def.cols.map(([h, w]) => `<th${w ? ` style="width:${w}px"` : ''}>${h}</th>`).join('')}</tr>`;
  const tbody = table.querySelector('tbody');
  if (!state.result) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${def.cols.length}">분석 결과가 없습니다.</td></tr>`;
  } else if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${def.cols.length}">${q ? '검색 결과가 없습니다.' : '항목이 없습니다.'}</td></tr>`;
  } else {
    tbody.innerHTML = rows.map((r, i) => `<tr data-type="${def.type}" data-id="${esc(r.id)}" class="${r.issue_ids.length ? 'flag' : ''}" title="${esc(def.title(r) || '')}">${def.cells(r, i).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  }
  $('#listHint').textContent = `총 ${rows.length}건${rows.length > 10 ? ' — 10건씩 표시되며, 나머지는 스크롤하여 확인하세요.' : ''} 클릭: 상세 정보 / 더블클릭: 도면 위치 보기`;
  bindRows(tbody);
  markSelectedRows();
}

function renderIssues() {
  const tbody = $('#issueTable tbody');
  const all = state.result?.issues || [];
  const s = state.result?.stats.issues || { high: 0, medium: 0, low: 0 };
  $('#cntIssues').textContent = all.length;
  $('#cntHigh').textContent = s.high;
  $('#cntMedium').textContent = s.medium;
  $('#cntLow').textContent = s.low;
  const rows = state.sev === 'all' ? all : all.filter((i) => i.severity === state.sev);
  if (!state.result) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">분석 결과가 없습니다.</td></tr>';
  } else if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">검토 필요 항목이 없습니다.</td></tr>';
  } else {
    tbody.innerHTML = rows.map((i) => {
      const rel = i.related_ids.map((id) => nodeName(id) || lineById(id)?.line_no || id).join(', ');
      return `<tr data-type="issue" data-id="${esc(i.id)}" title="${esc(i.description)}">
        <td><span class="badge ${i.severity}">${SEV_LABEL[i.severity]}</span></td>
        <td>${esc(i.category_label)}</td>
        <td><b>${esc(i.title)}</b><span class="desc">${esc(i.description)}</span></td>
        <td class="tag">${esc(rel) || '-'}</td>
        <td>${esc(drawingLabel(i.loc))}</td></tr>`;
    }).join('');
  }
  bindRows(tbody);
  markSelectedRows();
}

function bindRows(tbody) {
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const { type, id } = tr.dataset;
    tr.addEventListener('click', () => select({ type, id }));
    tr.addEventListener('dblclick', () => {
      const item = type === 'node' ? nodeById(id) : type === 'line' ? lineById(id) : type === 'legend' ? legendById(id) : issueById(id);
      if (item) openViewer(viewTarget(item, type));
    });
  });
}

function markSelectedRows() {
  document.querySelectorAll('.grid tbody tr[data-id]').forEach((tr) => {
    tr.classList.toggle('selected', !!state.selected && tr.dataset.type === state.selected.type && tr.dataset.id === state.selected.id);
  });
}

// ------------------------------------------------------------------ 도면 뷰어
const viewer = { target: null, page: null, pageW: 0, pageH: 0, cx: 0.5, cy: 0.5, span: 1, renderTask: null, renderSeq: 0 };

function viewTarget(item, type) {
  let loc = item.loc;
  if (type === 'line' && (!loc || !loc.bbox)) {
    // 신호선 등 라벨이 없는 라인은 연결된 노드 위치 사용
    const n = nodeById(item.from_id) || nodeById(item.to_id);
    if (n?.loc?.bbox) loc = n.loc;
  }
  if (type === 'legend') return { loc, title: `범례 · ${item.section} ${item.code}`, sub: item.description, wholeMsg: '범례 시트 전체를 표시합니다.' };
  const title = type === 'issue' ? item.title : type === 'line' ? (item.line_no || '(라인 번호 없음)') : `${item.tag || ''} ${item.name || ''}`.trim();
  const sub = type === 'issue' ? item.description : type === 'line' ? `${nodeName(item.from_id) || '?'} → ${nodeName(item.to_id) || '?'}` : CATEGORY_LABEL[item.category];
  return { loc, title, sub };
}

function bindViewer() {
  $('#vClose').addEventListener('click', closeViewer);
  $('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer(); });
  $('#vZoomIn').addEventListener('click', () => zoomViewer(0.7));
  $('#vZoomOut').addEventListener('click', () => zoomViewer(1 / 0.7));
  $('#vFull').addEventListener('click', () => { viewer.cx = 0.5; viewer.cy = 0.5; viewer.span = 1; renderViewer(); });
  $('#vFocus').addEventListener('click', () => { focusViewer(); renderViewer(); });

  const vp = $('#vViewport');
  let drag = null;
  vp.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: viewer.cx, cy: viewer.cy };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('dragging');
  });
  vp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    $('#vCanvas').style.transform = `translate(${dx}px, ${dy}px)`;
    $('#vMarks').style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const end = (e) => {
    if (!drag) return;
    const { cropW, cropH } = cropGeometry();
    const rect = vp.getBoundingClientRect();
    viewer.cx = drag.cx - ((e.clientX - drag.x) / rect.width) * cropW / viewer.pageW;
    viewer.cy = drag.cy - ((e.clientY - drag.y) / rect.height) * cropH / viewer.pageH;
    drag = null;
    vp.classList.remove('dragging');
    renderViewer();
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  let wheelT = null;
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    clearTimeout(wheelT);
    viewer.span = clampSpan(viewer.span * (e.deltaY > 0 ? 1.15 : 1 / 1.15));
    wheelT = setTimeout(renderViewer, 60);
  }, { passive: false });

  $('#vMinimap').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    viewer.cx = (e.clientX - r.left) / r.width;
    viewer.cy = (e.clientY - r.top) / r.height;
    renderViewer();
  });
  window.addEventListener('resize', () => { if (!$('#viewer').hidden) renderViewer(); });
}

const clampSpan = (s) => Math.min(1, Math.max(0.04, s));

function getPdf(fileIndex) {
  if (!state.pdfDocs.has(fileIndex)) {
    const src = state.sources[fileIndex];
    if (!src) return Promise.reject(new Error('원본 PDF를 찾을 수 없습니다.'));
    // pdf.js가 버퍼를 워커로 넘기므로 사본 전달
    state.pdfDocs.set(fileIndex, pdfjsLib.getDocument({ data: src.slice(0) }));
  }
  return state.pdfDocs.get(fileIndex).promise;
}

async function openViewer(target) {
  if (!target?.loc) {
    toast('이 항목은 도면 위치 정보가 없습니다.', true);
    return;
  }
  viewer.target = target;
  $('#viewerTitle').textContent = target.title || '도면 보기';
  $('#viewerSub').textContent = `${drawingLabel(target.loc)} · ${state.result.files[target.loc.file_index]?.name || ''} p.${target.loc.page}${target.sub ? ` — ${target.sub}` : ''}`;
  $('#viewer').hidden = false;
  try {
    const doc = await getPdf(target.loc.file_index);
    viewer.page = await doc.getPage(target.loc.page);
    const vp1 = viewer.page.getViewport({ scale: 1 });
    viewer.pageW = vp1.width;
    viewer.pageH = vp1.height;
    focusViewer();
    await renderThumb();
    renderViewer();
  } catch (err) {
    toast(`도면을 표시할 수 없습니다: ${err.message}`, true);
  }
}

function focusViewer() {
  const boxes = targetBoxes();
  const b = boxes.length
    ? [Math.min(...boxes.map((x) => x[0])), Math.min(...boxes.map((x) => x[1])), Math.max(...boxes.map((x) => x[2])), Math.max(...boxes.map((x) => x[3]))]
    : null;
  const msg = $('#vMsg');
  if (b) {
    viewer.cx = (b[0] + b[2]) / 2;
    viewer.cy = (b[1] + b[3]) / 2;
    viewer.span = clampSpan(Math.max(0.22, (b[2] - b[0]) * 5, (b[3] - b[1]) * 5 * (viewer.pageH / viewer.pageW)));
    msg.hidden = viewer.target.loc.source !== 'model';
    msg.textContent = 'AI가 추정한 위치입니다. 주변을 함께 확인하세요.';
  } else {
    viewer.cx = 0.5; viewer.cy = 0.5; viewer.span = 1;
    msg.hidden = false;
    msg.textContent = viewer.target?.wholeMsg || '정확한 위치 정보가 없어 페이지 전체를 표시합니다.';
  }
}

function zoomViewer(f) {
  viewer.span = clampSpan(viewer.span * f);
  renderViewer();
}

function closeViewer() {
  $('#viewer').hidden = true;
  viewer.renderTask?.cancel();
}

/** 현재 표시 영역 (PDF 포인트 단위) */
function cropGeometry() {
  const vp = $('#vViewport');
  const aspect = vp.clientHeight / vp.clientWidth;
  let cropW = viewer.pageW * viewer.span;
  let cropH = cropW * aspect;
  if (cropH > viewer.pageH && viewer.span >= 1) { cropH = viewer.pageH; cropW = cropH / aspect; }
  let x = viewer.cx * viewer.pageW - cropW / 2;
  let y = viewer.cy * viewer.pageH - cropH / 2;
  // 페이지 밖으로 과도하게 나가지 않도록 보정
  x = cropW >= viewer.pageW ? (viewer.pageW - cropW) / 2 : Math.min(Math.max(x, 0), viewer.pageW - cropW);
  y = cropH >= viewer.pageH ? (viewer.pageH - cropH) / 2 : Math.min(Math.max(y, 0), viewer.pageH - cropH);
  viewer.cx = (x + cropW / 2) / viewer.pageW;
  viewer.cy = (y + cropH / 2) / viewer.pageH;
  return { x, y, cropW, cropH };
}

async function renderViewer() {
  if (!viewer.page) return;
  const seq = ++viewer.renderSeq;
  const vpEl = $('#vViewport');
  const cssW = vpEl.clientWidth, cssH = vpEl.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { x, y, cropW } = cropGeometry();
  const scale = (cssW / cropW) * dpr;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9edf2';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  viewer.renderTask?.cancel();
  const task = viewer.page.render({
    canvasContext: ctx,
    viewport: viewer.page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -x * scale, -y * scale],
    background: '#ffffff',
  });
  viewer.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  }
  if (seq !== viewer.renderSeq) return;

  const old = $('#vCanvas');
  canvas.id = 'vCanvas';
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  old.replaceWith(canvas);

  const marks = $('#vMarks');
  marks.style.transform = '';
  const k = cssW / cropW;
  const pad = 6;
  marks.innerHTML = targetBoxes().map((b) => `<div class="hl" style="left:${(b[0] * viewer.pageW - x) * k - pad}px;top:${(b[1] * viewer.pageH - y) * k - pad}px;width:${(b[2] - b[0]) * viewer.pageW * k + pad * 2}px;height:${(b[3] - b[1]) * viewer.pageH * k + pad * 2}px"></div>`).join('');
  updateMinimap();
}

async function renderThumb() {
  const mm = $('#vMinimap');
  const w = mm.clientWidth || 240;
  const scale = (w / viewer.pageW) * Math.min(window.devicePixelRatio || 1, 2);
  const c = $('#vThumb');
  const vp = viewer.page.getViewport({ scale });
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await viewer.page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
}

function updateMinimap() {
  const { x, y, cropW, cropH } = cropGeometry();
  const v = $('#vMmView');
  const pct = (val, total) => `${(val / total) * 100}%`;
  v.style.left = pct(Math.max(0, x), viewer.pageW);
  v.style.top = pct(Math.max(0, y), viewer.pageH);
  v.style.width = pct(Math.min(cropW, viewer.pageW), viewer.pageW);
  v.style.height = pct(Math.min(cropH, viewer.pageH), viewer.pageH);
  $('#vMmMarks').innerHTML = targetBoxes().map((b) => `<div class="mm-hl" style="left:${b[0] * 100}%;top:${b[1] * 100}%;width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%"></div>`).join('');
}

/** 강조 표시할 영역 목록 (중복 태그처럼 여러 곳일 수 있음) */
function targetBoxes() {
  const loc = viewer.target?.loc;
  if (!loc?.bbox) return [];
  return loc.marks?.length ? loc.marks : [loc.bbox];
}

// ------------------------------------------------------------------ 내보내기
function exportData(kind) {
  const r = state.result;
  if (!r) return;
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'json') {
    download(`pid-analysis-${stamp}.json`, JSON.stringify(r, null, 2), 'application/json');
    return;
  }
  let rows;
  if (kind === 'equipment') {
    rows = [['Tag', '명칭', '형식', 'Service', '사양', '도면', '페이지', '검토 항목']]
      .concat(equipmentRows().map((n) => [n.tag, n.name, n.equipment_type, n.service, specSummary(n), drawingLabel(n.loc), n.loc.page, n.issue_ids.map((id) => issueById(id)?.title).join(' / ')]));
  } else if (kind === 'lines') {
    rows = [['Line No.', '관경', '유체', '유체 설명', 'Spec/Class', 'Class 설명(범례)', '보온', 'Service', 'From', 'To', '구분', '설치 계기·밸브', '도면', '검토 항목']]
      .concat(lineRows().map((l) => [l.line_no, l.size, l.fluid_code, l.fluid_desc, l.spec_class, l.class_desc, l.insulation, l.service, nodeName(l.from_id), nodeName(l.to_id), KIND_LABEL[l.kind], l.inline_items.join(' '), drawingLabel(l.loc), l.issue_ids.map((id) => issueById(id)?.title).join(' / ')]));
  } else if (kind === 'instruments') {
    rows = [['Tag', '명칭', '구분', '형식', '설치 위치', '도면', '검토 항목']]
      .concat(instrumentRows().map((n) => [n.tag, n.name, CATEGORY_LABEL[n.category], n.equipment_type, installedOn(n), drawingLabel(n.loc), n.issue_ids.map((id) => issueById(id)?.title).join(' / ')]));
  } else if (kind === 'legend') {
    rows = [['구분', '코드', '설명', '적용 건수']].concat(legendRows().map((e) => [e.section, e.code, e.description, e.used ?? '']));
  } else {
    rows = [['ID', '심각도', '구분', '제목', '내용', '관련 항목', '도면', '검출']]
      .concat(r.issues.map((i) => [i.id, SEV_LABEL[i.severity], i.category_label, i.title, i.description, i.related_ids.map((id) => nodeName(id) || lineById(id)?.line_no || id).join(' '), drawingLabel(i.loc), i.source === 'model' ? 'AI 판독' : '규칙 검증']));
  }
  const csv = rows.map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`pid-${kind}-${stamp}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

async function download(name, content, type) {
  if (IN_ARTIFACT) {
    // 아티팩트 화면에서는 <a download>가 동작하지 않으므로 저장 기능을 사용
    if (!runtime.downloads) {
      toast('이 화면에서는 파일을 저장할 수 없습니다.', true);
      return;
    }
    try {
      await runtime.downloads.save({ filename: name, data: content });
    } catch (e) {
      if (e?.code !== 'declined' && e?.code !== 'cancelled') toast('파일을 저장하지 못했습니다.', true);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ 기타
let toastT = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 4500);
}

renderList();
renderIssues();
init();
