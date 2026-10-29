// 분석 결과 JSON에 물질수지를 적용한 사본을 만든다 (보기 전용 HTML을 물질수지 포함으로 만들 때).
// 사용법: node scripts/apply-massbalance.mjs <result.json> <물질수지 .xlsx|.csv|.json> <out.json>
//   .json은 채팅 분석 페이지에 저장된 물질수지(읽은 표) 그대로
import fs from 'node:fs/promises';
import path from 'node:path';
import { readMassBalanceFile, applyMassBalance } from '../shared/massbalance.js';

const [resultPath, mbPath, outPath] = process.argv.slice(2);
if (!resultPath || !mbPath || !outPath) {
  console.error('usage: node scripts/apply-massbalance.mjs <result.json> <massbalance.xlsx|.csv|.json> <out.json>');
  process.exit(1);
}
const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const buf = await fs.readFile(mbPath);
const mb = /\.json$/i.test(mbPath)
  ? JSON.parse(buf.toString('utf8'))
  : await readMassBalanceFile(path.basename(mbPath), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const out = applyMassBalance(result, mb);
await fs.writeFile(outPath, JSON.stringify(out));
const st = out.mass_balance.stats;
console.log(`${outPath}: 물질수지 스트림 ${st.streams}개 중 ${st.matched_streams}개 매칭 (도면 라인 ${st.matched_lines}개)`);
