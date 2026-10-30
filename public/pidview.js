// Flow "기본" 보기: 원본 PDF 도면을 그대로 그리고, 그 위에 설비·Line No. 위치를 클릭할 수 있게 얹는다.
// 위치는 분석 결과의 bbox(텍스트 레이어에서 찾은 위치, 없으면 AI 추정 위치)를 쓴다. 도면은 한 번에 한 장.
//
// ui: {getPdf(fileIndex) → Promise<PDFDocumentProxy>, select(sel, from), open(type, id), valueText(line) → string,
//      linkTarget(nodeId) → node | null, goPage(key), nav() → {anchor, prev: [{label, sel}], next: [...]} | null,
//      pdfjs: {OPS, Util}, selectFree({trace, ends, key})}
// 선택한 라인(설비면 연결된 라인들)은 도면의 실제 선과 화살촉을 따라가 붉게 칠한다 (shared/pdfGeom.js)

import { extractGeometry, traceLine, traceDistance, nearestSegment, traceFromSegment, mainFlowSegments, notesRegions } from './shared/pdfGeom.js';

export const FREE_ID = '__free__'; // Stream 번호 없이 도면에서 직접 고른 선

const MIN_Z = 0.5, MAX_Z = 16;
const MAX_CANVAS_PX = 8192;

export function createPidView(container, ui) {
  container.innerHTML = '<div class="pv-stage"><canvas class="pv-canvas"></canvas><svg class="pv-main" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><svg class="pv-flow" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><div class="pv-marks"></div></div><div class="pv-msg" hidden></div>';
  const flowSvg = container.querySelector('.pv-flow');
  const mainSvg = container.querySelector('.pv-main');
  const geoms = new Map(); // 도면별 선 데이터 (Promise)
  const texts = new Map(); // 도면별 글자 [{s, x, y, w, h}] (Promise)
  const notes = new Map(); // 도면별 NOTES 영역 (값 표시 안 함)
  const traces = new Map(); // 라인 id → 추적한 경로
  const stage = container.querySelector('.pv-stage');
  const canvas = container.querySelector('.pv-canvas');
  const marks = container.querySelector('.pv-marks');
  const msg = container.querySelector('.pv-msg');

  const v = { result: null, key: null, page: null, pw: 0, ph: 0, W: 0, H: 0, z: 1, tx: 0, ty: 0, task: null, seq: 0, rendered: '' };
  // 도면별로 마지막 확대·이동 상태를 기억 (보기 방식을 바꿨다 돌아와도 그대로)
  const views = new Map();
  const remember = () => { if (v.key && v.page) views.set(v.key, { z: v.z, tx: v.tx, ty: v.ty, cw: container.clientWidth, ch: container.clientHeight }); };
  const filter = { instruments: false, utility: true }; // 계기·밸브는 숨기고 유틸리티 선은 표시 (유틸리티 PFD가 비지 않게)
  let selected = new Set();

  // ---- 화면 이동·확대
  const apply = () => {
    stage.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
    stage.style.setProperty('--z', v.z);
    remember();
  };
  const base = () => {
    const cw = container.clientWidth, ch = container.clientHeight;
    const s0 = Math.min(cw / v.pw, ch / v.ph) || 1;
    v.W = v.pw * s0;
    v.H = v.ph * s0;
    stage.style.width = `${v.W}px`;
    stage.style.height = `${v.H}px`;
    canvas.style.width = `${v.W}px`;
    canvas.style.height = `${v.H}px`;
  };
  /** 화면 맞춤: 도면 전체가 보이게 */
  function fit() {
    if (!v.page) return;
    base();
    v.z = 1;
    v.tx = (container.clientWidth - v.W) / 2;
    v.ty = (container.clientHeight - v.H) / 2;
    apply();
    scheduleRender();
  }
  /** 폭맞춤: 도면 가로 폭을 화면 폭에 맞추고 위쪽부터 */
  function fitWidth() {
    if (!v.page) return;
    base();
    v.z = Math.min(MAX_Z, Math.max(1, (container.clientWidth - 8) / v.W));
    v.tx = (container.clientWidth - v.W * v.z) / 2;
    v.ty = 4;
    apply();
    scheduleRender();
  }
  /** 도면을 열 때: 전에 보던 상태가 있으면 그대로, 없으면 폭맞춤 */
  function restore() {
    const saved = views.get(v.key);
    if (!saved) { fitWidth(); return; }
    base();
    Object.assign(v, { z: saved.z, tx: saved.tx, ty: saved.ty });
    apply();
    scheduleRender();
  }
  function zoomAt(f, mx, my) {
    const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * f));
    v.tx = mx - ((mx - v.tx) * z) / v.z;
    v.ty = my - ((my - v.ty) * z) / v.z;
    v.z = z;
    apply();
    scheduleRender();
  }
  function centerOn(b, minZ = 2.5) {
    const z = Math.max(v.z, minZ);
    const cx = ((b[0] + b[2]) / 2) * v.W, cy = ((b[1] + b[3]) / 2) * v.H;
    v.z = Math.min(MAX_Z, z);
    v.tx = container.clientWidth / 2 - cx * v.z;
    v.ty = container.clientHeight / 2 - cy * v.z;
    apply();
    scheduleRender();
  }

  container.addEventListener('wheel', (e) => {
    if (!v.page) return;
    e.preventDefault();
    const r = container.getBoundingClientRect();
    zoomAt(e.deltaY > 0 ? 1 / 1.15 : 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let drag = null, moved = false;
  container.addEventListener('pointerdown', (e) => {
    if (!v.page || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, id: e.pointerId };
    moved = false;
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) { moved = true; container.setPointerCapture(drag.id); container.classList.add('dragging'); }
    v.tx = drag.tx + dx;
    v.ty = drag.ty + dy;
    apply();
  });
  const end = () => { drag = null; container.classList.remove('dragging'); };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  // 숨겨졌다 다시 보일 때(보기 방식 전환)는 크기가 같으므로 보던 상태를 유지하고, 실제 크기가 바뀔 때만 맞춘다
  let lastSize = '';
  new ResizeObserver(() => {
    const size = `${container.clientWidth}x${container.clientHeight}`;
    if (!v.page || !container.clientWidth || size === lastSize) return;
    const first = !lastSize;
    lastSize = size;
    if (first) return;
    base();
    apply();
    scheduleRender();
  }).observe(container);

  // ---- 표시 항목 클릭
  marks.addEventListener('click', (e) => {
    if (moved) return;
    // From/To 따라가기 버튼
    const b = e.target.closest('[data-go]');
    if (b) { ui.select(JSON.parse(b.dataset.go)); return; }
    const m = e.target.closest('[data-id]');
    if (m) { ui.select({ type: m.dataset.type, id: m.dataset.id }, 'flow'); return; }
    // 도면의 선이나 화살표를 직접 눌러도 그 라인을 고른다 (Stream 번호가 없는 선도)
    const hit = hitLine(e);
    if (hit) { ui.select({ type: 'line', id: hit }, 'flow'); return; }
    const free = hitFree(e);
    if (free) {
      // 그 경로 위에 Line No.가 있으면 그 라인으로
      const own = pageLines().find((l) => traceDistance(free, [(l.loc.bbox[0] + l.loc.bbox[2]) / 2, (l.loc.bbox[1] + l.loc.bbox[3]) / 2]) < Math.max(l.loc.bbox[2] - l.loc.bbox[0], l.loc.bbox[3] - l.loc.bbox[1]) * 1.2);
      if (own) { ui.select({ type: 'line', id: own.id }, 'flow'); return; }
      freeTrace = free;
      ui.selectFree({ trace: free, ends: traceEnds(free), key: v.key });
    }
  });
  // 선 위에 마우스를 올리면 손가락 모양
  let hoverRaf = 0;
  marks.addEventListener('mousemove', (e) => {
    if (drag || hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      marks.style.cursor = !e.target.closest('[data-id], .pv-nav') && (hitLine(e) || nearSeg(e) >= 0) ? 'pointer' : '';
    });
  });
  marks.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pv-nav')) return;
    const m = e.target.closest('[data-id]');
    if (!m) return;
    // Off-page 연결은 짝이 되는 도면으로 이동
    const partner = m.dataset.type === 'node' ? ui.linkTarget(m.dataset.id) : null;
    if (partner) {
      ui.goPage(`${partner.loc.file_index}:${partner.loc.page}`);
      highlight([partner.id], true);
      ui.select({ type: 'node', id: partner.id }, 'flow');
    } else ui.open(m.dataset.type, m.dataset.id);
  });

  // ---- PDF 그리기 (확대하면 선명하게 다시 그림)
  let renderT = null;
  function scheduleRender() {
    clearTimeout(renderT);
    renderT = setTimeout(render, 180);
  }
  async function render() {
    if (!v.page) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = (v.W / v.pw) * v.z * dpr;
    scale = Math.min(scale, MAX_CANVAS_PX / v.pw, MAX_CANVAS_PX / v.ph);
    const want = `${v.key}@${scale.toFixed(3)}`;
    if (want === v.rendered) return;
    const seq = ++v.seq;
    v.task?.cancel();
    const vp = v.page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    v.task = v.page.render({ canvasContext: off.getContext('2d'), viewport: vp, background: '#ffffff' });
    try {
      await v.task.promise;
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      throw err;
    }
    if (seq !== v.seq) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    v.rendered = want;
  }

  // ---- 표시 항목
  const pct = (n) => `${(n * 100).toFixed(3)}%`;
  function buildMarks() {
    const r = v.result;
    const html = [];
    if (r && v.key) {
      const on = (x) => x.loc?.bbox && `${x.loc.file_index}:${x.loc.page}` === v.key;
      // NOTES 문단 안에서 찾은 스트림 번호는 특이사항 글이므로 값을 붙이지 않는다
      const inNotes = (b) => (notes.get(v.key) || []).some((n) => (b[0] + b[2]) / 2 >= n[0] && (b[0] + b[2]) / 2 <= n[2] && (b[1] + b[3]) / 2 >= n[1] && (b[1] + b[3]) / 2 <= n[3]);
      const box = (b, pad) => `left:${pct(b[0] - pad)};top:${pct(b[1] - pad)};width:${pct(b[2] - b[0] + pad * 2)};height:${pct(b[3] - b[1] + pad * 2)}`;
      for (const n of r.nodes) {
        if (!on(n)) continue;
        const ins = n.category === 'instrument' || n.category === 'valve';
        if (ins && !filter.instruments) continue;
        // 기본 보기는 원본 도면을 그대로 보여 주므로 검토 필요 표시는 하지 않는다 (붉은색은 선택에만)
        const cls = ['pv-mark', 'node', n.category, n.loc.source === 'model' ? 'model' : '', selected.has(n.id) ? 'sel' : ''];
        html.push(`<div class="${cls.join(' ')}" data-type="node" data-id="${esc(n.id)}" title="${esc(n.tag || n.name)}" style="${box(n.loc.bbox, 0.004)}"></div>`);
      }
      for (const l of r.lines) {
        if (l.kind === 'signal' || !on(l) || (l.kind === 'utility' && !filter.utility)) continue;
        const cls = ['pv-mark', 'line', l.kind, l.loc.source === 'model' ? 'model' : '', selected.has(l.id) ? 'sel' : ''];
        const b = l.loc.bbox;
        html.push(`<div class="${cls.join(' ')}" data-type="line" data-id="${esc(l.id)}" title="${esc(l.line_no || l.id)}" style="${box(b, 0.0025)}"></div>`);
        const val = inNotes(b) ? '' : ui.valueText(l);
        if (val) html.push(`<div class="pv-val${selected.has(l.id) ? ' sel' : ''}" data-type="line" data-id="${esc(l.id)}" style="left:${pct(b[0])};top:${pct(b[3] + 0.003)}">${esc(val)}</div>`);
      }
    }
    marks.innerHTML = html.join('');
    renderNav();
    drawFlow();
    msg.hidden = !!html.length || !v.page;
    msg.textContent = '이 도면에는 위치 정보가 있는 설비·라인이 없습니다. 자동배치 보기를 이용하세요.';
  }

  /** 선택한 항목 아래에 ◀ From / To ▶ 버튼: 눌러서 흐름을 따라간다 (다른 도면이면 그 도면으로 이동) */
  function renderNav() {
    marks.querySelector('.pv-nav')?.remove();
    const nav = ui.nav?.();
    if (!nav || (!nav.prev.length && !nav.next.length)) return;
    const a = nav.anchor;
    if (!a?.loc?.bbox || `${a.loc.file_index}:${a.loc.page}` !== v.key) return;
    const b = a.loc.bbox;
    const btn = (x, dir) => `<button type="button" class="${dir}" data-go='${esc(JSON.stringify(x.sel))}' title="${esc(x.title || x.label)}">${dir === 'prev' ? '◀ ' : ''}${esc(x.label)}${dir === 'next' ? ' ▶' : ''}</button>`;
    const el = document.createElement('div');
    el.className = 'pv-nav';
    el.style.left = pct((b[0] + b[2]) / 2);
    el.style.top = pct(b[3] + 0.006);
    el.innerHTML = `<div class="col">${nav.prev.map((x) => btn(x, 'prev')).join('')}</div><div class="col">${nav.next.map((x) => btn(x, 'next')).join('')}</div>`;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    marks.append(el);
  }

  /** 이 도면에 있는 라인들의 경로 (선 데이터가 준비된 뒤에만) */
  const pageLines = () => (v.result ? v.result.lines.filter((l) => l.kind !== 'signal' && l.loc?.bbox && `${l.loc.file_index}:${l.loc.page}` === v.key) : []);
  // 다른 스트림의 Line No. 표식에서 멈추도록 같은 도면의 다른 라인 위치를 넘긴다
  const traceOf = (l, geom) => {
    if (!traces.has(l.id)) {
      const stops = pageLines().filter((x) => x.id !== l.id && x.line_no && x.line_no !== l.line_no).map((x) => x.loc.bbox);
      traces.set(l.id, traceLine(geom, l.loc.bbox, { stops }));
    }
    return traces.get(l.id);
  };
  let readyGeom = null; // {key, geom}

  /** 주 흐름(Main Stream): 범례의 MAIN FLOW 견본과 같은 굵기·색의 선을 주황색으로 깔아 둔다 */
  async function drawMain(page, geom, key) {
    const it = (await textOf(page, key)).find((x) => /MAIN\s+FLOW/i.test(x.s) && !/SECONDARY|EVENTUAL/i.test(x.s));
    const label = it ? { x: it.x, y: it.y, h: it.h } : null;
    if (v.key !== key) return;
    const segs = mainFlowSegments(geom, label);
    mainSvg.innerHTML = segs.length ? `<path d="${segs.map((s) => `M${s[0]} ${s[1]}L${s[2]} ${s[3]}`).join('')}"/>` : '';
  }

  /** 도면 글자(정규 좌표). 글자 정보가 없으면 빈 목록 */
  function textOf(page, key) {
    if (!texts.has(key)) {
      const vp = page.getViewport({ scale: 1 });
      texts.set(key, page.getTextContent().then((tc) => tc.items.filter((x) => x.str?.trim()).map((x) => {
        const m = ui.pdfjs.Util.transform(vp.transform, x.transform);
        return { s: x.str, x: m[4] / vp.width, y: m[5] / vp.height, w: x.width / vp.width, h: Math.hypot(m[2], m[3]) / vp.height };
      })).catch(() => []));
    }
    return texts.get(key);
  }

  /** 이 도면 라인들의 경로를 화면을 멈추지 않게 하나씩 미리 계산 (선 클릭·마우스 올림용) */
  function warm() {
    const rg = readyGeom;
    const todo = pageLines().filter((l) => !traces.has(l.id));
    const step = () => {
      if (readyGeom !== rg || !todo.length) return;
      traceOf(todo.shift(), rg.geom);
      setTimeout(step, 0);
    };
    setTimeout(step, 50);
  }

  const pagePoint = (e) => {
    const r = container.getBoundingClientRect();
    return [(e.clientX - r.left - v.tx) / (v.W * v.z), (e.clientY - r.top - v.ty) / (v.H * v.z)];
  };
  const nearSeg = (e) => (readyGeom && readyGeom.key === v.key ? nearestSegment(readyGeom.geom, pagePoint(e), 6 / (v.W * v.z)) : -1);
  let freeTrace = null;

  /** Line No. 없는 선: 누른 선분에서 시작해 이어진 경로 (다른 Line No. 표식에서 멈춤) */
  function hitFree(e) {
    const seg = nearSeg(e);
    if (seg < 0) return null;
    return traceFromSegment(readyGeom.geom, seg, { stops: pageLines().filter((l) => l.line_no).map((l) => l.loc.bbox) });
  }

  /** 경로의 양 끝 (다른 선분과 이어지지 않은 끝점), 화살 머리가 닿은 끝은 arrow: true */
  function traceEnds(t) {
    const pts = t.segs.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]]);
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.0015;
    return pts.filter((p) => pts.filter((q) => near(p, q)).length === 1)
      .map((p) => ({ p, arrow: t.arrows.some((a) => traceDistance({ segs: [], arrows: [a] }, p) < 0.002) }));
  }

  /** 화면 위치 → 가장 가까운 라인 경로 (화면에서 6px 이내) */
  function hitLine(e) {
    if (!readyGeom || readyGeom.key !== v.key || !v.page) return null;
    const p = pagePoint(e);
    const tol = 6 / (v.W * v.z);
    let best = null, bestD = tol;
    for (const l of pageLines()) {
      if (!traces.has(l.id)) continue; // 아직 계산 전 (배경에서 계산 중)
      const d = traceDistance(traces.get(l.id), p);
      if (d < bestD) { bestD = d; best = l.id; }
    }
    return best;
  }

  /** 선택한 라인의 도면상 경로를 붉게: 설비를 고르면 그 설비에 연결된 라인들 */
  async function drawFlow() {
    const key = v.key;
    flowSvg.innerHTML = '';
    if (!v.result || !key || !selected.size) return;
    const on = (x) => x.loc?.bbox && `${x.loc.file_index}:${x.loc.page}` === key;
    const lines = new Map();
    for (const l of v.result.lines) {
      if (l.kind === 'signal' || !on(l)) continue;
      if (selected.has(l.id) || selected.has(l.from_id) || selected.has(l.to_id)) lines.set(l.id, l);
    }
    const free = selected.has(FREE_ID) && freeTrace ? [freeTrace] : [];
    if (!lines.size && !free.length) return;
    const geom = await geoms.get(key);
    if (!geom || key !== v.key) return;
    const parts = [];
    for (const t of [...[...lines.values()].slice(0, 12).map((l) => traceOf(l, geom)), ...free]) {
      if (!t) continue;
      // 점선 스타일로 그려진 선은 점선으로 (짧은 대시 조각들로 된 점선은 조각만 칠해 저절로 점선)
      const solid = t.segs.filter((s) => !s[4]), dash = t.segs.filter((s) => s[4]);
      const d = (xs) => xs.map((s) => `M${s[0]} ${s[1]}L${s[2]} ${s[3]}`).join('');
      if (solid.length) parts.push(`<path class="route" d="${d(solid)}"/>`);
      if (dash.length) parts.push(`<path class="route dash" d="${d(dash)}"/>`);
      for (const a of t.arrows) parts.push(`<polygon class="arrow" points="${a.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`);
    }
    flowSvg.innerHTML = parts.join('');
  }

  // 최근에 연 도면 몇 장만 pdf.js 해석 결과(연산 목록)를 남기고, 나머지는 비워 메모리를 아낀다
  const warmPages = new Map();
  function keepWarm(key, page) {
    warmPages.delete(key);
    warmPages.set(key, page);
    for (const [k, pg] of warmPages) {
      if (warmPages.size <= 5) break;
      if (k === v.key) continue;
      warmPages.delete(k);
      pg.cleanup();
    }
  }

  /** 이전·다음 도면을 미리 읽어 둔다: pdf.js 해석(워커)과 선 데이터. 넘길 때 그리기만 하면 된다 */
  function prefetch(key) {
    if (!v.result || !key || key === 'all' || geoms.has(key)) return;
    const [fi, p] = key.split(':').map(Number);
    setTimeout(() => {
      if (geoms.has(key) || !v.result) return;
      ui.getPdf(fi).then((doc) => doc.getPage(p)).then((page) => {
        if (geoms.has(key)) return;
        keepWarm(key, page);
        page.getOperatorList().catch(() => {}); // 화면 그리기용 연산 목록 (render가 같은 것을 다시 쓴다)
        geoms.set(key, extractGeometry(page, ui.pdfjs.OPS, ui.pdfjs.Util).catch(() => null));
        textOf(page, key);
      }).catch(() => {});
    }, 600);
  }

  async function setPage(key) {
    if (!v.result || !key || key === 'all') return;
    if (key !== v.key) {
      const [fi, p] = key.split(':').map(Number);
      v.key = key;
      v.rendered = '';
      freeTrace = null;
      v.page = null;
      marks.innerHTML = '';
      msg.hidden = false;
      msg.textContent = '도면을 불러오는 중…';
      try {
        const doc = await ui.getPdf(fi);
        const page = await doc.getPage(p);
        if (v.key !== key) return;
        v.page = page;
        keepWarm(key, page);
        if (!geoms.has(key)) geoms.set(key, extractGeometry(page, ui.pdfjs.OPS, ui.pdfjs.Util).catch(() => null));
        readyGeom = null;
        mainSvg.innerHTML = '';
        geoms.get(key).then((geom) => { if (geom && v.key === key) { readyGeom = { key, geom }; warm(); drawMain(page, geom, key); } });
        if (!notes.has(key)) textOf(page, key).then((items) => { notes.set(key, notesRegions(items)); if (v.key === key) buildMarks(); });
        const vp = page.getViewport({ scale: 1 });
        v.pw = vp.width;
        v.ph = vp.height;
      } catch (err) {
        msg.textContent = `도면을 표시할 수 없습니다: ${err.message}`;
        return;
      }
      lastSize = `${container.clientWidth}x${container.clientHeight}`;
      restore();
    }
    buildMarks();
  }

  function highlight(ids, focus) {
    selected = new Set(ids);
    const items = v.result ? [...v.result.nodes, ...v.result.lines].filter((x) => selected.has(x.id) && x.loc?.bbox) : [];
    const here = items.filter((x) => `${x.loc.file_index}:${x.loc.page}` === v.key);
    if (focus && !here.length && items.length) {
      // 다른 도면에 있으면 그 도면으로 이동
      const k = `${items[0].loc.file_index}:${items[0].loc.page}`;
      ui.goPage(k);
      setPage(k).then(() => { const b = items[0].loc.bbox; if (v.page) centerOn(b); });
      return;
    }
    // 클릭 직후 표시 항목을 다시 만들면 더블클릭이 끊기므로 선택 표시만 바꾼다
    marks.querySelectorAll('.pv-mark, .pv-val').forEach((m) => m.classList.toggle('sel', selected.has(m.dataset.id)));
    renderNav();
    drawFlow();
    if (focus && here.length) centerOn(here[0].loc.bbox);
  }

  return {
    /** reload: 원본 PDF가 바뀌었을 때(새 분석) 도면을 다시 연다 */
    show(result, key, reload = false) {
      v.result = result;
      traces.clear();
      if (readyGeom) warm();
      if (reload) { v.key = null; views.clear(); geoms.clear(); traces.clear(); texts.clear(); notes.clear(); warmPages.clear(); }
      return setPage(key);
    },
    setPage,
    prefetch,
    highlight,
    fit,
    fitWidth,
    refresh: buildMarks,
    setFilter(f) { Object.assign(filter, f); buildMarks(); },
    /** 결과가 없을 때: 도면과 표시를 모두 지운다 */
    reset() {
      v.seq++;
      v.task?.cancel();
      Object.assign(v, { result: null, key: null, page: null, rendered: '' });
      views.clear(); geoms.clear(); traces.clear(); texts.clear(); notes.clear(); warmPages.clear();
      readyGeom = null;
      freeTrace = null;
      selected = new Set();
      canvas.width = 0;
      canvas.height = 0;
      marks.innerHTML = '';
      flowSvg.innerHTML = '';
      mainSvg.innerHTML = '';
      msg.hidden = true;
    },
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
