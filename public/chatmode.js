// "채팅 분석" 모드: 이 페이지는 도면을 올리고 결과를 보기만 하고, 분석은 Claude Code 채팅 세션이 한다.
//
// 데이터 흐름 (claude.ai 아티팩트의 assets + db 기능)
//   페이지  → assets: PDF 업로드 (파일당 20MB 이하)
//   페이지  → db files/<assetId>: {name, size, assetId, uploadedAt}  업로드 목록
//   페이지  → db jobs/<문서>: {status: "requested", slot, unit, doc_type, files:[...]}  분석 요청
//   세션    → db jobs/<문서>: {status: "analyzing", progress}        진행 상황
//   세션    → assets: 결과 JSON 업로드 후 jobs/<문서> {status: "done", resultAsset}
//   페이지  ← jobs 구독: 지금 묶음이 완료되면 결과 JSON과 PDF를 불러와 화면에 표시
//   페이지  → assets: 물질수지 표(읽은 결과 JSON) + db massbalance/<문서> {assetId, name}  다시 열어도 유지
//
// 공정 단위(BL1U ~ BL3U) × 도면 종류(PFD, P&ID)마다 따로 둔다 (묶음 키 예: "BL1U-PID").
//   files/<assetId>.slot 에 묶음 키 (없으면 기본 묶음 BL3U-PFD: 단위 구분 전에 올린 도면)
//   jobs/<문서>, massbalance/<문서>: 기본 묶음은 "current", 나머지는 묶음 키 그대로

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function setupChatMode(ui) {
  const { $, toast, esc, defaultSlot } = ui;
  const docOf = (slot) => (slot === defaultSlot ? 'current' : slot);
  const slotOf = (docId) => (docId === 'current' ? defaultSlot : docId);
  const use = (name) => window.claude.use(name).catch(() => null);
  const [db, assets, downloads] = await Promise.all([use('db'), use('assets'), use('downloads')]);
  ui.setDownloads(downloads);

  const notice = $('#apiNotice');
  notice.hidden = false;
  if (!db) {
    notice.textContent = '이 화면에서는 도면 목록과 분석 결과를 불러올 수 없습니다. claude.ai에 로그인한 상태에서 이 페이지를 열어 주세요. "샘플 데모"는 그대로 볼 수 있습니다.';
    $('#btnPick').disabled = true;
    return { upload() {}, request() {}, saveMassBalance() {}, setSlot() {}, refresh() { $('#btnPick').disabled = true; $('#btnAnalyze').disabled = true; } };
  }
  notice.className = 'notice info';
  notice.innerHTML = '<b>사용 방법</b> ① <b>도면 올리기</b>를 눌러 공정 단위와 PFD / P&amp;ID를 고른 뒤 ② 범례와 도면 PDF를 올리고 ③ <b>분석 요청</b>을 누르고 ④ Claude Code 채팅에 "BL3U · PFD 분석 요청했어"처럼 알려 주세요. 분석은 채팅에서 진행되고, 끝나면 이 페이지에 결과가 자동으로 표시됩니다.';
  if (!assets) {
    $('#btnPick').disabled = true;
    notice.innerHTML += '<br>도면은 이 페이지의 소유자와 편집자만 올릴 수 있습니다.';
  }

  const filesCol = db.collection('files');
  let slot = ui.slot().key; // 지금 화면의 묶음
  let allFiles = [];
  let files = []; // 지금 묶음의 도면
  let jobs = new Map(); // 묶음 → 분석 요청·진행 상황
  let job = null;
  const loadedResult = new Map(); // 묶음 → 불러온 결과 asset
  let uploading = false;

  // ---- 업로드 목록
  filesCol.orderBy('uploadedAt').onSnapshot((snap) => {
    allFiles = snap.docs.map((d) => d.data()).filter((f) => f?.assetId);
    pickFiles();
    renderFiles();
  }, () => toast('도면 목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.', true));

  function pickFiles() {
    files = allFiles.filter((f) => (f.slot || defaultSlot) === slot);
  }

  /** 단위·도면 종류를 바꿨을 때: 그 묶음의 도면, 분석 상태, 결과로 */
  function setSlot(next) {
    slot = next;
    pickFiles();
    syncJob();
  }

  function renderFiles() {
    const busy = job?.status === 'requested' || job?.status === 'analyzing';
    const ul = $('#fileChips');
    ul.innerHTML = files.map((f) => `<li title="${esc(f.name)}"><span>${esc(f.name)}</span><span class="size">${(f.size / 1048576).toFixed(1)}MB</span>${assets && !busy ? `<button type="button" data-rm="${esc(f.assetId)}" aria-label="${esc(f.name)} 삭제">×</button>` : ''}</li>`).join('');
    ul.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => remove(b.dataset.rm)));
    if (!uploading) {
      $('#fileHint').textContent = files.length
        ? `올린 도면 ${files.length}개 (${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1)}MB)`
        : `${ui.slot().label}: 올린 도면 없음 — 도면 올리기로 범례와 ${ui.slot().doc === 'pfd' ? 'PFD' : 'P&ID'} PDF를 올리거나 이 화면에 끌어다 놓으세요.`;
    }
    $('#btnAnalyze').disabled = !files.length || busy || uploading;
    $('#btnPick').disabled = !assets || uploading;
  }

  async function upload(list) {
    if (!assets) return;
    const pdfs = list.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfs.length < list.length) toast('PDF 파일만 올릴 수 있습니다.', true);
    const tooBig = pdfs.filter((f) => f.size > MAX_PDF_BYTES);
    if (tooBig.length) toast(`20MB를 넘는 파일은 올릴 수 없습니다: ${tooBig.map((f) => f.name).join(', ')}\nPDF를 나누어 올려 주세요.`, true);
    const todo = pdfs.filter((f) => f.size <= MAX_PDF_BYTES && !files.some((x) => x.name === f.name && x.size === f.size));
    if (!todo.length) return;
    const target = slot; // 올리는 도중 묶음을 바꿔도 처음 묶음에 넣는다
    uploading = true;
    $('#btnPick').disabled = true;
    $('#btnAnalyze').disabled = true;
    try {
      for (const [i, f] of todo.entries()) {
        $('#fileHint').textContent = `올리는 중 ${i + 1}/${todo.length}: ${f.name}`;
        const res = await assets.upload(f, { type: 'application/pdf' });
        await filesCol.doc(res.id).set({ name: f.name, size: f.size, assetId: res.id, slot: target, uploadedAt: new Date().toISOString() });
      }
      toast(`${slotLabel(target)}에 ${todo.length}개 파일을 올렸습니다.`);
    } catch (e) {
      toast(uploadErrorMessage(e), true);
    } finally {
      uploading = false;
      renderFiles();
    }
  }

  async function remove(assetId) {
    const f = files.find((x) => x.assetId === assetId);
    try {
      await assets.delete(assetId);
      await filesCol.doc(assetId).delete();
      toast(`${f?.name || '파일'}을(를) 지웠습니다.`);
    } catch (e) {
      toast(uploadErrorMessage(e), true);
    }
  }

  // ---- 분석 요청과 진행 상황
  async function request() {
    if (!files.length) return;
    const s = ui.slot();
    const body = {
      ...(job || {}),
      slot: s.key,
      unit: s.unit,
      doc_type: s.doc,
      status: 'requested',
      files: files.map((f) => ({ assetId: f.assetId, name: f.name, size: f.size })),
      requestedAt: new Date().toISOString(),
      progress: null,
      message: '',
    };
    try {
      await db.doc(`jobs/${docOf(s.key)}`).set(body);
    } catch {
      toast('분석 요청을 저장하지 못했습니다. 이 페이지에 쓰기 권한이 있는지 확인해 주세요.', true);
    }
  }

  db.collection('jobs').onSnapshot((snap) => {
    jobs = new Map(snap.docs.filter((d) => d.exists).map((d) => [slotOf(d.id), d.data()]));
    syncJob();
  }, () => toast('분석 상태를 불러오지 못했습니다. 페이지를 새로고침해 주세요.', true));

  function syncJob() {
    job = jobs.get(slot) || null;
    renderJob();
    renderFiles();
    if (job?.resultAsset && job.resultAsset !== loadedResult.get(slot)) loadResult(slot, job.resultAsset);
    // 검색은 같은 공정 단위의 PFD와 P&ID를 함께 찾으므로, 다른 쪽 결과도 JSON만 미리 받아 둔다(도면 PDF는 넘어갈 때)
    const sib = slot.replace(/-(PFD|PID)$/, (m, d) => (d === 'PFD' ? '-PID' : '-PFD'));
    const sj = jobs.get(sib);
    if (sj?.resultAsset && sj.resultAsset !== searchLoaded.get(sib) && sj.resultAsset !== loadedResult.get(sib)) loadSearchData(sib, sj.resultAsset);
  }

  const searchLoaded = new Map();
  async function loadSearchData(at, resultAsset) {
    searchLoaded.set(at, resultAsset);
    try {
      const res = await fetch(`/_blob/${resultAsset}`);
      if (!res.ok) throw new Error(String(res.status));
      ui.setSearchData?.(at, await res.json());
    } catch {
      searchLoaded.delete(at); // 검색에서만 빠진다 (그 묶음을 고르면 평소대로 불러옴)
    }
  }

  function renderJob() {
    const s = job?.status;
    const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    if (s === 'requested') {
      ui.showRunBox(`${slotLabel(slot)} 분석 요청됨 (${when(job.requestedAt)}, 파일 ${job.files?.length || 0}개). Claude Code 채팅에 "${slotLabel(slot)} 분석 요청했어"라고 알려 주세요.`, '요청 문구 복사');
      ui.setRunAction(copyRequestText);
    } else if (s === 'analyzing') {
      const p = job.progress || {};
      const count = p.total ? ` ${p.done || 0}/${p.total}` : '';
      ui.showRunBox(`${slotLabel(slot)} 채팅에서 분석 중${count}${p.stage ? ` · ${p.stage}` : ''}. 이 페이지를 닫아도 분석은 계속되고, 끝나면 결과가 표시됩니다.`);
    } else if (s === 'error') {
      ui.showRunBox(`분석 중 문제가 생겼습니다: ${job.message || '알 수 없는 오류'}`, null, true);
    } else if (s === 'done') {
      ui.showRunBox(`${slotLabel(slot)} 분석 완료 (${when(job.finishedAt)})${job.message ? ` · ${job.message}` : ''}`);
    } else {
      ui.showRunBox(null);
    }
  }

  async function copyRequestText() {
    const text = `${slotLabel(slot)} 분석 요청했어`;
    try {
      await navigator.clipboard.writeText(text);
      toast(`"${text}"를 복사했습니다. 채팅에 붙여 넣어 주세요.`);
    } catch {
      toast(`채팅에 "${text}"라고 입력해 주세요.`);
    }
  }

  async function loadResult(at, resultAsset) {
    loadedResult.set(at, resultAsset);
    try {
      const res = await fetch(`/_blob/${resultAsset}`);
      if (!res.ok) throw new Error(String(res.status));
      const result = await res.json();
      // 도면 PDF는 볼 때 그 장만 받는다 (전부 받고 시작하면 큰 묶음은 수십 초)
      const sources = result.files.map((f) => ui.lazySource(async () => {
        const r = await fetch(`/_blob/${f.assetId}`);
        if (!r.ok) throw new Error(`${f.name}: ${r.status}`);
        return r.arrayBuffer();
      }));
      ui.applyResult(result, sources, at);
    } catch (e) {
      loadedResult.delete(at);
      toast(`분석 결과를 불러오지 못했습니다 (${e.message}). 결과에 쓰인 도면이 지워졌는지 확인해 주세요.`, true);
    }
  }

  // ---- 물질수지: 읽은 표를 JSON으로 저장해 다음에 열 때도 적용
  const mbAssets = new Map(); // 묶음 → 적용한 물질수지 asset
  db.collection('massbalance').onSnapshot((snap) => {
    const docs = new Map(snap.docs.filter((d) => d.exists && d.data()?.assetId).map((d) => [slotOf(d.id), d.data()]));
    for (const at of [...mbAssets.keys()]) {
      if (!docs.has(at)) { mbAssets.delete(at); ui.setMassBalance(null, { quiet: true, slot: at }); }
    }
    for (const [at, d] of docs) {
      if (d.assetId === mbAssets.get(at)) continue;
      mbAssets.set(at, d.assetId);
      fetch(`/_blob/${d.assetId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((mb) => ui.setMassBalance(mb, { quiet: true, slot: at }))
        .catch(() => { mbAssets.delete(at); toast(`${slotLabel(at)}의 저장된 물질수지를 불러오지 못했습니다.`, true); });
    }
  }, () => {});

  async function saveMassBalance(mb) {
    const at = slot;
    const mbRef = db.doc(`massbalance/${docOf(at)}`);
    if (!assets) {
      if (mb) toast('물질수지를 이 화면에만 적용했습니다. 페이지에 저장하려면 편집 권한이 필요합니다.');
      return;
    }
    const prev = mbAssets.get(at);
    try {
      if (mb) {
        const res = await assets.upload(new Blob([JSON.stringify(mb)], { type: 'application/json' }), { type: 'application/json' });
        mbAssets.set(at, res.id);
        await mbRef.set({ assetId: res.id, name: mb.name, streams: mb.streams.length, uploadedAt: new Date().toISOString() });
      } else {
        mbAssets.delete(at);
        await mbRef.delete();
      }
      if (prev) await assets.delete(prev).catch(() => {});
    } catch (e) {
      toast(`물질수지를 페이지에 저장하지 못했습니다. ${uploadErrorMessage(e)}`, true);
    }
  }

  renderFiles();
  return { upload, request, saveMassBalance, setSlot, refresh: renderFiles };
}

const slotLabel = (key) => key.replace('-PFD', ' · PFD').replace('-PID', ' · P&ID');

function uploadErrorMessage(e) {
  switch (e?.code) {
    case 'too_large': return '파일이 20MB를 넘습니다. PDF를 나누어 올려 주세요.';
    case 'unsupported_type': return 'PDF 파일만 올릴 수 있습니다.';
    case 'quota_or_state': return '이 페이지의 저장 공간이 가득 찼습니다. 쓰지 않는 도면을 지운 뒤 다시 올려 주세요.';
    case 'rate_limited': return '너무 자주 올리고 있습니다. 잠시 후 다시 시도해 주세요.';
    case 'upstream_auth': return '로그인이 만료되었습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
    case 'not_granted':
    case 'capability_disabled': return '이 화면에서는 도면을 올릴 수 없습니다.';
    case 'store_unavailable': return '저장 공간에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
    default: return `파일 처리 중 오류가 발생했습니다${e?.code ? ` (${e.code})` : ''}.`;
  }
}
