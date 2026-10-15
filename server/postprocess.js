// Claude 분석 결과 정규화 + 텍스트 레이어 기반 위치 보정 + 규칙 기반 검증.
import { normalizeTag, findTagOnPages, findAllTagBoxes } from './pdfText.js';

export const ISSUE_CATEGORY_LABELS = {
  unconnected: '미연결',
  missing_info: '정보 누락',
  inconsistent: '불일치',
  unreadable: '판독 불확실',
  offpage_unmatched: 'Off-page 미매칭',
  duplicate: '중복',
  other: '기타',
};
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * @param {object} raw  Claude 출력(JSON 스키마 형식)
 * @param {Array<{name:string, text:{pageCount:number,pages:Array}}>} files
 */
export function postprocess(raw, files) {
  const drawings = arr(raw.drawings).map((d) => ({
    file_index: int(d.file_index), page: int(d.page, 1),
    drawing_no: s(d.drawing_no), title: s(d.title), revision: s(d.revision),
  }));

  // ---- 노드 정규화 & id 중복 제거
  const usedIds = new Set();
  const nodes = arr(raw.nodes).map((n, i) => {
    let id = s(n.id) || s(n.tag) || `NODE-${i + 1}`;
    if (usedIds.has(id)) {
      let k = 2;
      while (usedIds.has(`${id}#${k}`)) k++;
      id = `${id}#${k}`;
    }
    usedIds.add(id);
    return {
      id,
      tag: s(n.tag),
      name: s(n.name),
      category: s(n.category) || 'other',
      equipment_type: s(n.equipment_type),
      service: s(n.service),
      specs: arr(n.specs).map((x) => ({ name: s(x.name), value: s(x.value) })).filter((x) => x.name || x.value),
      offpage_ref: s(n.offpage_ref),
      loc: normLoc(n.loc, files),
      confidence: s(n.confidence) || 'medium',
      note: s(n.note),
      _origId: s(n.id),
    };
  });

  const nodeByKey = new Map();
  for (const n of nodes) {
    for (const k of [n.id, n._origId, n.tag]) {
      const key = normalizeTag(k);
      if (key && !nodeByKey.has(key)) nodeByKey.set(key, n);
    }
  }

  const ruleIssues = [];
  const usedLineIds = new Set();
  const lines = arr(raw.lines).map((l, i) => {
    let id = s(l.id) || s(l.line_no) || `LINE-${i + 1}`;
    if (usedLineIds.has(id) || usedIds.has(id)) {
      let k = 2;
      while (usedLineIds.has(`${id}#${k}`)) k++;
      id = `${id}#${k}`;
    }
    usedLineIds.add(id);
    const line = {
      id,
      line_no: s(l.line_no),
      kind: ['process', 'utility', 'signal'].includes(l.kind) ? l.kind : 'process',
      size: s(l.size),
      fluid_code: s(l.fluid_code),
      spec_class: s(l.spec_class),
      insulation: s(l.insulation),
      service: s(l.service),
      from_id: '',
      to_id: '',
      inline_items: arr(l.inline_items).map(s).filter(Boolean),
      loc: normLoc(l.loc, files),
      confidence: s(l.confidence) || 'medium',
      note: s(l.note),
    };
    for (const end of ['from_id', 'to_id']) {
      const ref = s(l[end]);
      if (!ref) continue;
      const target = nodeByKey.get(normalizeTag(ref));
      if (target) {
        line[end] = target.id;
      } else {
        ruleIssues.push({
          severity: 'high', category: 'inconsistent',
          title: `라인 연결 대상 불명 (${ref})`,
          description: `${label(line)}의 ${end === 'from_id' ? '시작' : '끝'} 지점이 "${ref}"로 표시되어 있으나 해당 설비/계기를 도면에서 찾을 수 없습니다. 태그 오기 또는 누락 여부를 확인하세요.`,
          related_ids: [line.id],
        });
      }
    }
    return line;
  });

  // ---- 위치 보정 (텍스트 레이어에서 태그 검색)
  for (const n of nodes) locate(n, [n.tag, n.name, n.offpage_ref, n._origId], files);
  for (const l of lines) locate(l, [l.line_no], files);

  // ---- 규칙 기반 검증
  const degree = new Map(nodes.map((n) => [n.id, { process: 0, utility: 0, signal: 0 }]));
  for (const l of lines) {
    for (const end of [l.from_id, l.to_id]) if (end && degree.has(end)) degree.get(end)[l.kind]++;
  }
  const inlineTags = new Set(lines.flatMap((l) => l.inline_items.map(normalizeTag)));

  for (const l of lines) {
    if (l.kind !== 'signal' && (!l.from_id || !l.to_id)) {
      const missing = !l.from_id && !l.to_id ? '양 끝단' : !l.from_id ? '시작점' : '끝점';
      ruleIssues.push({
        severity: 'high', category: 'unconnected',
        title: `라인 ${missing} 미연결`,
        description: `${label(l)}의 ${missing}이(가) 어떤 설비·계기·Off-page에도 연결되어 있지 않습니다. 배관 물량 산출 전 연결처를 확인하세요.`,
        related_ids: [l.id],
      });
    }
    if (l.kind === 'signal') continue;
    if (!l.line_no) {
      ruleIssues.push({
        severity: 'medium', category: 'missing_info',
        title: '라인 번호 없음',
        description: `${describeEnds(l, nodes)} 구간 배관에 라인 번호가 표기되어 있지 않습니다.`,
        related_ids: [l.id],
      });
    }
    const missing = [!l.size && '관경(Size)', !l.spec_class && 'Spec/Class'].filter(Boolean);
    if (missing.length) {
      ruleIssues.push({
        severity: 'medium', category: 'missing_info',
        title: `배관 ${missing.join(', ')} 누락`,
        description: `${label(l)}에 ${missing.join(', ')} 정보가 없어 배관 투자비 산출이 불가합니다.`,
        related_ids: [l.id],
      });
    }
  }

  const tagCount = new Map();
  for (const n of nodes) {
    const key = normalizeTag(n.tag);
    if (key) tagCount.set(key, [...(tagCount.get(key) || []), n]);
  }
  for (const [, list] of tagCount) {
    if (list.length > 1) {
      ruleIssues.push({
        severity: 'medium', category: 'duplicate',
        title: `태그 중복 (${list[0].tag})`,
        description: `동일 태그 ${list[0].tag}가 ${list.length}개 항목에 사용되었습니다. 태그 번호를 확인하세요.`,
        related_ids: list.map((n) => n.id),
      });
    }
  }

  for (const n of nodes) {
    const d = degree.get(n.id);
    if (n.category === 'equipment' && d.process + d.utility === 0) {
      ruleIssues.push({
        severity: 'high', category: 'unconnected',
        title: `미연결 설비 (${n.tag || n.name})`,
        description: `${nodeLabel(n)}에 연결된 배관이 없습니다. 미사용 설비인지, 연결 배관이 누락되었는지 확인하세요.`,
        related_ids: [n.id],
      });
    }
    if ((n.category === 'instrument' || n.category === 'valve') && d.process + d.utility + d.signal === 0 && !inlineTags.has(normalizeTag(n.tag))) {
      ruleIssues.push({
        severity: 'low', category: 'unconnected',
        title: `연결 정보 없는 계기/밸브 (${n.tag || n.name})`,
        description: `${nodeLabel(n)}가 어느 라인·설비에 설치되었는지 확인되지 않습니다.`,
        related_ids: [n.id],
      });
    }
    if (n.category === 'equipment' && n.specs.length === 0) {
      ruleIssues.push({
        severity: 'low', category: 'missing_info',
        title: `설비 사양 정보 없음 (${n.tag || n.name})`,
        description: `${nodeLabel(n)}의 용량·크기·설계조건·재질 등 사양이 도면에서 확인되지 않습니다. 장비 리스트/데이터시트로 보완이 필요합니다.`,
        related_ids: [n.id],
      });
    }
    if (n.confidence === 'low') {
      ruleIssues.push({
        severity: 'low', category: 'unreadable',
        title: `판독 신뢰도 낮음 (${n.tag || n.name || n.id})`,
        description: `${nodeLabel(n)}의 판독 결과 신뢰도가 낮습니다. 원본 도면에서 확인하세요.${n.note ? ` (${n.note})` : ''}`,
        related_ids: [n.id],
      });
    }
    // 텍스트 레이어가 있는 도면인데 태그를 찾지 못한 경우
    const hasText = files[n.loc.file_index]?.text.pages.some((p) => p.runs.length > 0);
    if (hasText && n.tag && ['equipment', 'instrument', 'valve'].includes(n.category) && n.loc.source !== 'text') {
      ruleIssues.push({
        severity: 'low', category: 'unreadable',
        title: `태그 텍스트 미확인 (${n.tag})`,
        description: `${nodeLabel(n)} 태그가 PDF 텍스트에서 확인되지 않았습니다. 판독 오류이거나 도면 표기가 다를 수 있습니다.`,
        related_ids: [n.id],
      });
    }
    // 같은 페이지에 계기 태그가 두 번 이상 표기된 경우 (모델이 하나로 합친 경우 대비)
    if ((n.category === 'instrument' || n.category === 'valve') && n.tag && (tagCount.get(normalizeTag(n.tag))?.length ?? 0) < 2) {
      const pg = files[n.loc.file_index]?.text.pages.find((p) => p.page === n.loc.page);
      const boxes = pg ? findAllTagBoxes(n.tag, pg) : [];
      if (boxes.length > 1) {
        ruleIssues.push({
          severity: 'medium', category: 'duplicate',
          title: `태그 중복 표기 (${n.tag})`,
          description: `도면 ${n.loc.page}페이지에 ${n.tag} 태그가 ${boxes.length}회 표기되어 있습니다. 서로 다른 계기에 같은 번호가 부여되었는지 확인하세요.`,
          related_ids: [n.id],
          loc: { file_index: n.loc.file_index, page: n.loc.page, bbox: boxes[0].map(round4), source: 'text', marks: boxes.map((b) => b.map(round4)) },
        });
      }
    }
  }

  const links = pairOffpages(nodes, lines, drawings, ruleIssues);

  // ---- 이슈 병합 (모델 이슈 우선, 같은 카테고리/대상의 규칙 이슈는 생략)
  const modelIssues = arr(raw.issues).map((x) => ({
    severity: SEVERITY_RANK[x.severity] !== undefined ? x.severity : 'medium',
    category: ISSUE_CATEGORY_LABELS[x.category] ? x.category : 'other',
    title: s(x.title), description: s(x.description),
    related_ids: arr(x.related_ids).map((r) => resolveId(r, nodes, lines)).filter(Boolean),
    loc: x.loc ? normLoc(x.loc, files) : null,
    source: 'model',
  }));
  const merged = [...modelIssues];
  for (const r of ruleIssues) {
    const dup = modelIssues.some((m) => m.category === r.category && m.related_ids.some((id) => r.related_ids.includes(id)));
    if (!dup) merged.push({ loc: null, ...r, source: 'rule' });
  }
  const byId = new Map([...nodes, ...lines].map((x) => [x.id, x]));
  const issues = merged
    .map((iss) => {
      const rel = iss.related_ids.map((id) => byId.get(id)).find((x) => x?.loc?.bbox);
      const loc = iss.loc?.marks ? iss.loc : rel ? rel.loc : iss.loc || null;
      return { ...iss, loc, category_label: ISSUE_CATEGORY_LABELS[iss.category] };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((iss, i) => ({ id: `ISS-${String(i + 1).padStart(3, '0')}`, ...iss }));

  for (const n of nodes) delete n._origId;
  const issueIdsFor = (id) => issues.filter((i) => i.related_ids.includes(id)).map((i) => i.id);
  for (const x of [...nodes, ...lines]) x.issue_ids = issueIdsFor(x.id);

  return {
    summary: s(raw.summary),
    drawings,
    files: files.map((f, i) => ({ index: i, name: f.name, pageCount: f.text.pageCount, hasTextLayer: f.text.pages.some((p) => p.runs.length > 0) })),
    nodes,
    lines,
    links,
    issues,
    stats: {
      equipment: nodes.filter((n) => n.category === 'equipment').length,
      instruments: nodes.filter((n) => n.category === 'instrument').length,
      valves: nodes.filter((n) => n.category === 'valve').length,
      lines: lines.filter((l) => l.kind !== 'signal').length,
      issues: { high: 0, medium: 0, low: 0, ...countBy(issues, 'severity') },
    },
  };
}

function pairOffpages(nodes, lines, drawings, ruleIssues) {
  const offpages = nodes.filter((n) => n.category === 'offpage');
  const drawingOf = (n) => drawings.find((d) => d.file_index === n.loc.file_index && d.page === n.loc.page)
    || drawings.find((d) => d.file_index === n.loc.file_index);
  const refText = (n) => normalizeTag(n.offpage_ref || n.name || n.tag);
  const known = drawings.map((d) => normalizeTag(d.drawing_no)).filter(Boolean);
  const lineNosOf = (n) => new Set(lines.filter((l) => l.from_id === n.id || l.to_id === n.id).map((l) => normalizeTag(l.line_no)).filter(Boolean));

  const links = [];
  const paired = new Set();
  for (const a of offpages) {
    if (paired.has(a.id)) continue;
    const aRef = refText(a);
    const aDwg = normalizeTag(drawingOf(a)?.drawing_no);
    const targetDwg = known.find((k) => aRef.includes(k) && k !== aDwg);
    if (!targetDwg) {
      ruleIssues.push({
        severity: 'medium', category: 'offpage_unmatched',
        title: `참조 도면 미입력 (${a.offpage_ref || a.name || a.tag})`,
        description: `${nodeLabel(a)}가 가리키는 도면이 입력된 P&ID에 없습니다. 연결 도면을 추가로 입력하거나 Battery Limit 여부를 확인하세요.`,
        related_ids: [a.id],
      });
      continue;
    }
    const candidates = offpages.filter((b) => b !== a && !paired.has(b.id)
      && normalizeTag(drawingOf(b)?.drawing_no) === targetDwg
      && (!aDwg || refText(b).includes(aDwg)));
    const aLines = lineNosOf(a);
    const best = candidates.find((b) => [...lineNosOf(b)].some((ln) => aLines.has(ln))) || (candidates.length === 1 ? candidates[0] : null);
    if (best) {
      paired.add(a.id); paired.add(best.id);
      const aIsSource = lines.some((l) => l.to_id === a.id);
      links.push({ id: `LINK:${a.id}~${best.id}`, from_id: aIsSource ? a.id : best.id, to_id: aIsSource ? best.id : a.id });
    } else {
      ruleIssues.push({
        severity: 'high', category: 'offpage_unmatched',
        title: `대응 Off-page 없음 (${a.offpage_ref || a.name || a.tag})`,
        description: `${nodeLabel(a)}가 참조하는 도면에서 되돌아오는 Off-page 연결(또는 동일 라인 번호)을 찾을 수 없습니다.`,
        related_ids: [a.id],
      });
    }
  }
  return links;
}

function locate(item, candidates, files) {
  const f = files[item.loc.file_index];
  const searchFiles = f ? [[item.loc.file_index, f], ...files.map((x, i) => [i, x]).filter(([i]) => i !== item.loc.file_index)] : files.map((x, i) => [i, x]);
  for (const text of candidates) {
    if (!text || normalizeTag(text).length < 3) continue;
    for (const [fi, file] of searchFiles) {
      const hit = findTagOnPages(text, file.text.pages, fi === item.loc.file_index ? item.loc.page : 1);
      if (hit) {
        item.loc = { file_index: fi, page: hit.page, bbox: hit.bbox.map(round4), source: 'text' };
        return;
      }
    }
  }
  if (item.loc.bbox) item.loc.source = 'model';
}

function normLoc(loc, files) {
  const fi = int(loc?.file_index);
  const file_index = files[fi] ? fi : 0;
  const pageCount = files[file_index]?.text.pageCount || 1;
  const page = Math.min(Math.max(int(loc?.page, 1), 1), pageCount);
  let bbox = Array.isArray(loc?.bbox) && loc.bbox.length === 4 && loc.bbox.every((v) => Number.isFinite(v)) ? loc.bbox.map(Number) : null;
  if (bbox && bbox.some((v) => v > 1.5)) bbox = bbox.map((v) => v / 1000); // 0-1000 스케일로 답한 경우
  if (bbox) {
    const [a, b, c, d] = bbox;
    bbox = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)].map((v) => round4(Math.min(1, Math.max(0, v))));
    if (bbox[2] - bbox[0] <= 0 && bbox[3] - bbox[1] <= 0) bbox = null;
  }
  return { file_index, page, bbox, source: bbox ? 'model' : 'none' };
}

function resolveId(ref, nodes, lines) {
  const key = normalizeTag(ref);
  if (!key) return '';
  const hit = [...nodes, ...lines].find((x) => normalizeTag(x.id) === key)
    || nodes.find((n) => normalizeTag(n.tag) === key)
    || lines.find((l) => normalizeTag(l.line_no) === key);
  return hit ? hit.id : '';
}

function describeEnds(l, nodes) {
  const name = (id) => nodes.find((n) => n.id === id)?.tag || id || '?';
  return `${name(l.from_id)} → ${name(l.to_id)}`;
}
const label = (l) => (l.line_no ? `라인 ${l.line_no}` : `라인(${l.id})`);
const nodeLabel = (n) => `${n.tag || n.id}${n.name ? ` ${n.name}` : ''}`;
const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const round4 = (v) => Math.round(v * 10000) / 10000;
const countBy = (list, key) => list.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {});
