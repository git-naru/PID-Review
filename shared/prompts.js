// P&ID 판독 지침 (서버 일괄 분석과 브라우저 단계별 분석이 같은 규칙을 쓰도록 공용으로 둔다).

export const ROLE = `You are a senior process/piping engineer reviewing Piping & Instrument Diagrams (P&IDs).
The extracted data will be used as input for CAPEX (investment cost) estimation, so completeness and
correctness of equipment data and pipe line data matter most.`;

export const LEGEND_GUIDE = `P&ID sets usually start with LEGEND / SYMBOLS / 범례 sheets that define the line numbering system,
fluid codes, piping classes, equipment tag prefixes, instrument identification letters, and the symbols for lines,
valves and instruments. Interpret every P&ID sheet with those conventions:
- split each line number by the legend's format into size / fluid_code / spec_class / insulation;
- classify equipment by the tag prefix definitions, instruments by the identification letters;
- recognise valves, instruments, line types and connectors by the legend symbols, not by guesswork.
Legend sheets contain example tags and line numbers - never extract nodes or lines from legend sheets.
If no legend is provided, use common industry conventions (ISA 5.1 etc.) and lower the confidence of items whose
meaning depends on project-specific codes.`;

export const EXTRACTION_GUIDE = `Extract every node (P&ID sheets only):
- equipment (tanks, vessels, columns, pumps, compressors, heat exchangers, filters, packages...). Merge the
  equipment data box / equipment list text into the matching equipment's specs. Spare pumps (A/B) are separate nodes.
- instruments (transmitters, indicators, controllers, switches) and valves of interest (control valves,
  safety/relief valves, on-off valves with tags). Untagged manual block valves can be omitted.
- off-page connectors (category "offpage") and battery limit / utility headers like CWS, CWR, LPS (category "battery_limit").
Extract every pipe line segment between nodes. Use the line number text written along the line. A line runs
from one node to another; tees/branches connect into another line - in that case set from/to to the node the
branch ultimately connects to on the flow path. Instrument signal/impulse lines are kind "signal" (instrument -> process node or valve).
Utility services (CW, steam, N2, IA...) are kind "utility".
Report issues you observe directly on the drawing (Korean text): lines ending without a destination, equipment
with no connected line, missing line number / size / spec class, data box values inconsistent with the symbol
(e.g. tag mismatch), duplicated tags, off-page connectors whose referenced drawing is not among the uploaded files,
illegible text, flow direction contradictions, and anything that does not follow the legend (undefined piping class
or fluid code, line numbers not matching the numbering format, symbols not defined in the legend).`;

export const RULES = `- Never invent data. If a value is not on the drawing, use an empty string and (if it matters for cost) raise an issue.
- Copy tags and line numbers exactly as written.
- Coordinates: a text layer with normalized centre coordinates (0-1, origin top-left) is provided for each page.
  Use it to place bbox precisely around the tag text or symbol. For scanned pages without text layer, estimate from the image.
- "from_id"/"to_id" must be ids that exist in "nodes", or empty string.
- Write summaries, issue titles and descriptions in Korean. Keep tags, line numbers and spec values in the original language.`;

// ---------------------------------------------------------------- 브라우저 단계별 분석용 프롬프트

const CODE_ROW = '{"code": string, "description": string}';

export const LEGEND_SHAPE = `{
  "line_number_format": string,           // e.g. "SIZE - FLUID CODE - SEQ. NO. - PIPING CLASS", include the example as written
  "fluid_codes": [${CODE_ROW}],
  "piping_classes": [${CODE_ROW}],        // material, rating, corrosion allowance as written
  "equipment_codes": [${CODE_ROW}],       // tag prefixes, e.g. P = PUMP
  "instrument_letters": [${CODE_ROW}],    // first letters as "F"; succeeding letters prefixed with "+", e.g. "+I"
  "symbols": [${CODE_ROW}],               // line types, valve / instrument / connector symbols, abbreviations
  "notes": string                         // general notes that matter for quantities or cost
}`;

export const SHEET_SHAPE = `{
  "drawing": {"drawing_no": string, "title": string, "revision": string},
  "sheet_summary": string,                // Korean, 1-2 sentences on what this sheet does
  "nodes": [{
    "id": string,                         // the tag when it exists; off-page connectors "OPC:<drawing_no>:<n>"
    "tag": string, "name": string,
    "category": "equipment" | "instrument" | "valve" | "offpage" | "battery_limit" | "other",
    "equipment_type": string,             // Pump, Tank, Vessel, Heat Exchanger, Control Valve, Transmitter...
    "service": string,
    "specs": [{"name": string, "value": string}],  // every data value written for it, original units
    "offpage_ref": string,                // offpage / battery_limit: referenced drawing no. or destination; else ""
    "bbox": [x0, y0, x1, y1] | null,      // normalized 0-1, origin top-left, around the tag or symbol
    "confidence": "high" | "medium" | "low",
    "note": string
  }],
  "lines": [{
    "id": string,                         // the full line number, else "LINE-<n>"
    "line_no": string, "kind": "process" | "utility" | "signal",
    "size": string, "fluid_code": string, "spec_class": string, "insulation": string, "service": string,
    "from_id": string, "to_id": string,   // node ids from "nodes" above, or "" when not connected
    "inline_items": [string],             // tags of valves / instruments installed on the line
    "stream_no": string,                  // stream number marker (diamond/flag/box) written on the line, else ""
    "specs": [{"name": string, "value": string}],  // stream / line data from a stream table or line list (flow, density, temperature...), original units; [] when none
    "bbox": [x0, y0, x1, y1] | null,      // around the line number label
    "confidence": "high" | "medium" | "low",
    "note": string
  }],
  "issues": [{
    "severity": "high" | "medium" | "low",
    "category": "unconnected" | "missing_info" | "inconsistent" | "unreadable" | "offpage_unmatched" | "duplicate" | "other",
    "title": string, "description": string,   // Korean
    "related_ids": [string],
    "bbox": [x0, y0, x1, y1] | null
  }]
}`;

/** 시트 분류: 각 페이지의 표제란 부근 텍스트로 범례/P&ID/기타를 판별 */
export function classifyPrompt(pageSnippets, hasImages) {
  return `${ROLE}

Classify each page of an uploaded P&ID set. For every page decide whether it is a legend / symbols sheet ("legend"),
a P&ID sheet ("pid") or anything else such as a cover or index ("other"), and read its drawing number, title and revision
from the title block.${hasImages ? '\nPages without a text layer are attached as images, in the order they are listed below as (image n).' : ''}

Pages (text found in the title block area and any heading words):
${pageSnippets}

Reply with only a JSON array, one object per page listed above:
[{"file_index": number, "page": number, "sheet_type": "legend" | "pid" | "other", "drawing_no": string, "title": string, "revision": string}]`;
}

/** 범례 시트 한 장 판독 */
export function legendPrompt({ sheetLabel, textLayer, imageNote }) {
  return `${ROLE}

This page (${sheetLabel}) is a LEGEND / SYMBOLS sheet of a P&ID set. Read it completely: the line numbering system,
fluid codes, piping classes, equipment identification, instrument identification letters, symbols and general notes.
Copy codes exactly as written. Leave a list empty when the sheet does not define it. Never invent entries.
${imageNote}

Text layer of this page (cx,cy | text, normalized 0-1, origin top-left):
${textLayer}

Reply with only this JSON object:
${LEGEND_SHAPE}`;
}

/**
 * P&ID 시트 한 장 판독.
 * region: 결과가 길어 시트를 나눠 판독할 때 이번 요청이 맡는 부분 {box:[x0,y0,x1,y1], index, count}
 * hasTextLayer: 텍스트 레이어가 있으면 위치는 텍스트에서 다시 찾으므로 bbox를 생략해 출력을 줄인다
 */
export function sheetPrompt({ sheetLabel, legendJson, drawingsList, textLayer, imageNote, region = null, hasTextLayer = false, docNote = '' }) {
  const regionNote = region
    ? `\nThis sheet is too dense for one answer, so it is read in ${region.count} overlapping parts. In THIS request read only part ${region.index}: x ${region.box[0]}-${region.box[2]}, y ${region.box[1]}-${region.box[3]} (normalized page coordinates).
Extract the nodes whose tag or symbol lies in this part and the lines whose line number label lies in it. For a line that leaves this part,
still give from_id/to_id when you can read the node at the other end (use its tag as the id).\n`
    : '';
  const sizeNote = hasTextLayer
    ? '\nKeep the answer compact: this page has a text layer, so set every "bbox" to null (positions are matched from the text). Keep "note" under 10 words and leave it "" when there is nothing to note.'
    : '\nKeep the answer compact: keep "note" under 10 words and leave it "" when there is nothing to note.';
  return `${ROLE}

Analyze ONE P&ID sheet: ${sheetLabel}.${regionNote}${docNote ? `\n${docNote}\n` : ''} Other sheets of the set are analyzed separately; the drawings uploaded in this set are:
${drawingsList}
Off-page connectors pointing to a drawing that is not in this list should be reported as offpage_unmatched issues.

Project legend (read from the legend sheets; empty means no legend was provided):
${legendJson}

${LEGEND_GUIDE}

${EXTRACTION_GUIDE}

Rules:
${RULES}${sizeNote}
${imageNote}

Text layer of this ${region ? 'part' : 'page'} (cx,cy | text, normalized 0-1, origin top-left):
${textLayer}

Reply with only this JSON object:
${SHEET_SHAPE}`;
}
