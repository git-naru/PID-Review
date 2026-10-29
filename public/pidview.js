// Flow "기본" 보기: 원본 PDF 도면을 그대로 그리고, 그 위에 설비·Line No. 위치를 클릭할 수 있게 얹는다.
// 위치는 분석 결과의 bbox(텍스트 레이어에서 찾은 위치, 없으면 AI 추정 위치)를 쓴다. 도면은 한 번에 한 장.
//
// ui: {getPdf(fileIndex) → Promise<PDFDocumentProxy>, select(sel, from), open(type, id), valueText(line) → string,
//      linkTarget(nodeId) → node | null, goPage(key), nav() → {anchor, prev: [{label, sel}], next: [...]} | null}

const MIN_Z = 0.5, MAX_Z = 16;
const MAX_CANVAS_PX = 8192;

export function createPidView(container, ui) {
  container.innerHTML = '<div class="pv-stage"><canvas class="pv-canvas"></canvas><div class="pv-marks"></div></div><div class="pv-msg" hidden></div>';
  const stage = container.querySelector('.pv-stage');
  const canvas = container.querySelector('.pv-canvas');
  const marks = container.querySelector('.pv-marks');
  const msg = container.querySelector('.pv-msg');

  const v = { result: null, key: null, page: null, pw: 0, ph: 0, W: 0, H: 0, z: 1, tx: 0, ty: 0, task: null, seq: 0, rendered: '' };
  // 도면별로 마지막 확대·이동 상태를 기억 (보기 방식을 바꿨다 돌아와도 그대로)
  const views = new Map();
  const remember = () => { if (v.key && v.page) views.set(v.key, { z: v.z, tx: v.tx, ty: v.ty, cw: container.clientWidth, ch: container.clientHeight }); };
  const filter = { instruments: false, utility: true };
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
    if (m) ui.select({ type: m.dataset.type, id: m.dataset.id }, 'flow');
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
      const box = (b, pad) => `left:${pct(b[0] - pad)};top:${pct(b[1] - pad)};width:${pct(b[2] - b[0] + pad * 2)};height:${pct(b[3] - b[1] + pad * 2)}`;
      for (const n of r.nodes) {
        if (!on(n)) continue;
        const ins = n.category === 'instrument' || n.category === 'valve';
        if (ins && !filter.instruments) continue;
        const cls = ['pv-mark', 'node', n.category, n.issue_ids.length ? 'flag' : '', n.loc.source === 'model' ? 'model' : '', selected.has(n.id) ? 'sel' : ''];
        html.push(`<div class="${cls.join(' ')}" data-type="node" data-id="${esc(n.id)}" title="${esc(n.tag || n.name)}" style="${box(n.loc.bbox, 0.004)}"></div>`);
      }
      for (const l of r.lines) {
        if (l.kind === 'signal' || !on(l) || (l.kind === 'utility' && !filter.utility)) continue;
        const cls = ['pv-mark', 'line', l.kind, l.issue_ids.length ? 'flag' : '', l.loc.source === 'model' ? 'model' : '', selected.has(l.id) ? 'sel' : ''];
        const b = l.loc.bbox;
        html.push(`<div class="${cls.join(' ')}" data-type="line" data-id="${esc(l.id)}" title="${esc(l.line_no || l.id)}" style="${box(b, 0.0025)}"></div>`);
        const val = ui.valueText(l);
        if (val) html.push(`<div class="pv-val" data-type="line" data-id="${esc(l.id)}" style="left:${pct(b[0])};top:${pct(b[3] + 0.003)}">${esc(val)}</div>`);
      }
    }
    marks.innerHTML = html.join('');
    renderNav();
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

  async function setPage(key) {
    if (!v.result || !key || key === 'all') return;
    if (key !== v.key) {
      const [fi, p] = key.split(':').map(Number);
      v.key = key;
      v.rendered = '';
      v.page = null;
      marks.innerHTML = '';
      msg.hidden = false;
      msg.textContent = '도면을 불러오는 중…';
      try {
        const doc = await ui.getPdf(fi);
        const page = await doc.getPage(p);
        if (v.key !== key) return;
        v.page = page;
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
    marks.querySelectorAll('.pv-mark').forEach((m) => m.classList.toggle('sel', selected.has(m.dataset.id)));
    renderNav();
    if (focus && here.length) centerOn(here[0].loc.bbox);
  }

  return {
    /** reload: 원본 PDF가 바뀌었을 때(새 분석) 도면을 다시 연다 */
    show(result, key, reload = false) {
      v.result = result;
      if (reload) { v.key = null; views.clear(); }
      return setPage(key);
    },
    setPage,
    highlight,
    fit,
    fitWidth,
    refresh: buildMarks,
    setFilter(f) { Object.assign(filter, f); buildMarks(); },
    reset() { v.result = null; v.key = null; v.page = null; marks.innerHTML = ''; },
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
