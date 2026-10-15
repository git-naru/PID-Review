// Claude API를 이용한 P&ID 분석.
import Anthropic from '@anthropic-ai/sdk';
import { textLayerForPrompt } from './pdfText.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 64000);
const EFFORT = process.env.CLAUDE_EFFORT || 'high';

const str = { type: 'string' };
const LOC = {
  type: 'object',
  additionalProperties: false,
  required: ['file_index', 'page', 'bbox'],
  properties: {
    file_index: { type: 'integer', description: '0-based index of the uploaded file' },
    page: { type: 'integer', description: '1-based page number' },
    bbox: {
      description: 'Normalized [x0,y0,x1,y1] (0-1, origin top-left) around the tag/label or symbol. null if unknown.',
      anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }],
    },
  },
};
const CONFIDENCE = { type: 'string', enum: ['high', 'medium', 'low'] };
const CODE_TABLE = {
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['code', 'description'], properties: { code: str, description: str } },
};

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'legend', 'drawings', 'nodes', 'lines', 'issues'],
  properties: {
    summary: { type: 'string', description: 'Korean, 2-4 sentences describing the process' },
    legend: {
      type: 'object',
      additionalProperties: false,
      description: 'Conventions read from the legend / symbol sheets. Empty arrays and found=false when no legend sheet was provided.',
      required: ['found', 'pages', 'line_number_format', 'fluid_codes', 'piping_classes', 'equipment_codes', 'instrument_letters', 'symbols', 'notes'],
      properties: {
        found: { type: 'boolean' },
        pages: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['file_index', 'page'], properties: { file_index: { type: 'integer' }, page: { type: 'integer' } } },
        },
        line_number_format: { type: 'string', description: 'e.g. SIZE - FLUID CODE - SEQUENCE NO. - PIPING CLASS (- INSULATION). Include the example as written.' },
        fluid_codes: CODE_TABLE,
        piping_classes: { ...CODE_TABLE, description: 'Piping class/spec codes with material, rating, corrosion allowance as written' },
        equipment_codes: { ...CODE_TABLE, description: 'Equipment tag prefixes, e.g. P = PUMP' },
        instrument_letters: { ...CODE_TABLE, description: 'Instrument identification letters. Prefix succeeding-letter entries with "+" in code (e.g. "+I") to distinguish them from first letters.' },
        symbols: { ...CODE_TABLE, description: 'Line types, valve/fitting/instrument symbols and abbreviations. code = short symbol name' },
        notes: { type: 'string', description: 'General notes relevant to quantities / cost (Korean or original)' },
      },
    },
    drawings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file_index', 'page', 'sheet_type', 'drawing_no', 'title', 'revision'],
        properties: {
          file_index: { type: 'integer' }, page: { type: 'integer' },
          sheet_type: { type: 'string', enum: ['legend', 'pid', 'other'] },
          drawing_no: str, title: str, revision: str,
        },
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tag', 'name', 'category', 'equipment_type', 'service', 'specs', 'offpage_ref', 'loc', 'confidence', 'note'],
        properties: {
          id: { type: 'string', description: 'Unique id. Use the tag when it exists (e.g. "P-101A"); for off-page connectors use "OPC:<drawing>:<n>"' },
          tag: str,
          name: str,
          category: { type: 'string', enum: ['equipment', 'instrument', 'valve', 'offpage', 'battery_limit', 'other'] },
          equipment_type: { type: 'string', description: 'e.g. Pump, Tank, Vessel, Column, Heat Exchanger, Compressor, Filter, Control Valve, Safety Valve, Transmitter...' },
          service: str,
          specs: {
            type: 'array',
            description: 'All data written for the item (capacity, size, design P/T, MOC, motor kW, duty, type...). Keep original units.',
            items: { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: str, value: str } },
          },
          offpage_ref: { type: 'string', description: 'For offpage/battery_limit: referenced drawing number or destination text. Empty string otherwise.' },
          loc: LOC,
          confidence: CONFIDENCE,
          note: str,
        },
      },
    },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'line_no', 'kind', 'size', 'fluid_code', 'spec_class', 'insulation', 'service', 'from_id', 'to_id', 'inline_items', 'loc', 'confidence', 'note'],
        properties: {
          id: { type: 'string', description: 'Unique id. Use the full line number when available, else "LINE-<n>"' },
          line_no: { type: 'string', description: 'Full line number exactly as written, e.g. 6"-P-1001-A1A. Empty string if none.' },
          kind: { type: 'string', enum: ['process', 'utility', 'signal'] },
          size: str,
          fluid_code: str,
          spec_class: { type: 'string', description: 'Piping class/spec (e.g. A1A). Empty string if not written.' },
          insulation: str,
          service: str,
          from_id: { type: 'string', description: 'Node id at the upstream end. Empty string if the line end is not connected to anything identifiable.' },
          to_id: { type: 'string', description: 'Node id at the downstream end. Empty string if not connected.' },
          inline_items: { type: 'array', items: str, description: 'Tags of valves/instruments installed on this line' },
          loc: LOC,
          confidence: CONFIDENCE,
          note: str,
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'title', 'description', 'related_ids', 'loc'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: ['unconnected', 'missing_info', 'inconsistent', 'unreadable', 'offpage_unmatched', 'duplicate', 'other'] },
          title: { type: 'string', description: 'Korean, short' },
          description: { type: 'string', description: 'Korean, what is wrong and what to check' },
          related_ids: { type: 'array', items: str },
          loc: LOC,
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior process/piping engineer reviewing Piping & Instrument Diagrams (P&IDs).
The extracted data will be used as input for CAPEX (investment cost) estimation, so completeness and
correctness of equipment data and pipe line data matter most.

Your job:
0. Find the legend sheets first. P&ID sets usually start with LEGEND / SYMBOLS / 범례 sheets that define the line
   numbering system, fluid codes, piping classes, equipment tag prefixes, instrument identification letters, and the
   symbols for lines, valves and instruments. Read them completely and fill "legend". Then interpret every other
   sheet with those conventions:
   - split each line number by the legend's format into size / fluid_code / spec_class / insulation;
   - classify equipment by the tag prefix definitions, instruments by the identification letters;
   - recognise valves, instruments, line types and connectors by the legend symbols, not by guesswork.
   Legend sheets contain example tags and line numbers - never extract nodes or lines from legend sheets.
   If no legend is provided, use common industry conventions (ISA 5.1 etc.), set legend.found=false, and lower the
   confidence of items whose meaning depends on project-specific codes.
1. Read every page of every uploaded P&ID. Identify drawing number, title, revision and sheet_type from the title block.
2. Extract every node (P&ID sheets only):
   - equipment (tanks, vessels, columns, pumps, compressors, heat exchangers, filters, packages...). Merge the
     equipment data box / equipment list text into the matching equipment's specs. Spare pumps (A/B) are separate nodes.
   - instruments (transmitters, indicators, controllers, switches) and valves of interest (control valves,
     safety/relief valves, on-off valves with tags). Untagged manual block valves can be omitted.
   - off-page connectors (category "offpage") and battery limit / utility headers like CWS, CWR, LPS (category "battery_limit").
3. Extract every pipe line segment between nodes. Use the line number text written along the line. A line runs
   from one node to another; tees/branches connect into another line - in that case set from/to to the node the
   branch ultimately connects to on the flow path. Instrument signal/impulse lines are kind "signal" (instrument -> process node or valve).
   Utility services (CW, steam, N2, IA...) are kind "utility".
4. Report issues you observe directly on the drawing (Korean text): lines ending without a destination, equipment
   with no connected line, missing line number / size / spec class, data box values inconsistent with the symbol
   (e.g. tag mismatch), duplicated tags, off-page connectors whose referenced drawing is not among the uploaded files,
   illegible text, flow direction contradictions, and anything that does not follow the legend (undefined piping class
   or fluid code, line numbers not matching the numbering format, symbols not defined in the legend).

Rules:
- Never invent data. If a value is not on the drawing, use an empty string and (if it matters for cost) raise an issue.
- Copy tags and line numbers exactly as written.
- Coordinates: a text layer with normalized centre coordinates (0-1, origin top-left) is provided for each page.
  Use it to place bbox precisely around the tag text or symbol. For scanned pages without text layer, estimate from the image.
- "from_id"/"to_id" must be ids that exist in "nodes", or empty string.
- Write summary, issue titles and descriptions in Korean. Keep tags, line numbers and spec values in the original language.`;

/**
 * @param {Array<{name:string, buffer:Buffer, text:object}>} files
 * @param {(ev:object)=>void} onProgress
 */
export async function analyzeWithClaude(files, onProgress = () => {}) {
  const client = new Anthropic();

  const content = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `FILE ${i}: ${f.name}` });
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') },
      title: f.name,
    });
  });
  const textLayer = files.map((f, i) => textLayerForPrompt(i, f.name, f.text)).join('\n\n');
  content.push({
    type: 'text',
    text: `Text layer extracted from the PDFs (use for exact tags and coordinates):\n\n${textLayer}\n\n` +
      `Analyze all ${files.length} file(s) above as one P&ID set and return the JSON.`,
  });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  let chars = 0;
  let lastEmit = 0;
  stream.on('text', (delta) => {
    chars += delta.length;
    const now = Date.now();
    if (now - lastEmit > 800) {
      lastEmit = now;
      onProgress({ stage: 'generating', chars });
    }
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new AnalysisError('모델이 요청 처리를 거절했습니다. 도면 내용을 확인한 뒤 다시 시도해 주세요.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AnalysisError('도면 정보가 많아 출력 한도를 초과했습니다. 파일을 나누어 분석하거나 CLAUDE_MAX_TOKENS 값을 늘려 주세요.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AnalysisError('분석 결과(JSON)를 해석하지 못했습니다. 다시 시도해 주세요.');
  }
  return {
    raw: parsed,
    meta: { model: message.model, usage: message.usage },
  };
}

export class AnalysisError extends Error {}

export function isApiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
