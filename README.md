# P&ID Review

투자비(CAPEX) 산출의 입력 조건으로 쓰기 위해 P&ID(Piping & Instrument Diagram) PDF를 분석하는 웹 도구입니다.
PDF를 한 장 또는 여러 장 입력하면 Claude가 도면을 판독해 설비·배관·계기 정보를 추출하고, 연결성 검증을 거쳐 아래 결과를 보여줍니다.

- **공정 Flow**: 설비, Off-page, Battery Limit을 배관으로 연결한 흐름도. 설비나 라인을 클릭하면 상세 정보(사양, 연결 배관, 관경/Spec, 검토 사항)를 표시합니다.
- **설비 리스트 / 배관 리스트 / 계기·밸브**: 10건씩 표시되며, 그 이상은 스크롤해서 확인합니다. 검색할 수 있고, 더블클릭하면 원본 도면의 해당 위치로 이동합니다.
- **검토 필요 항목**: 미연결 설비, 끝단이 연결되지 않은 라인, 라인 번호·관경·Spec 누락, 태그 중복, 입력되지 않은 도면을 가리키는 Off-page 같은 항목을 모은 목록입니다. **더블클릭하면 입력된 P&ID의 해당 부분을 확대하고 강조 표시합니다.**
- **내보내기**: 설비/배관/계기/검토 항목 CSV(Excel 호환)와 전체 결과 JSON을 내려받을 수 있습니다.

## 실행

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # Claude API 키
npm start                             # http://localhost:3000
```

API 키가 없어도 **샘플 데모** 버튼으로 전체 기능을 확인할 수 있습니다. 데모는 `samples/`의 샘플 도면 2장과 미리 작성해 둔 판독 결과를 사용하며, 위치 보정과 연결성 검증은 실제 분석과 똑같이 실행됩니다.

환경 변수(선택):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 분석 모델 |
| `CLAUDE_EFFORT` | `high` | 판독 깊이 (`low`~`max`) |
| `CLAUDE_MAX_TOKENS` | `64000` | 출력 한도. 대형 도면 세트에서 한도 초과 오류가 나면 늘립니다 |

## 분석 방식

1. **텍스트 레이어 추출** (`server/pdfText.js`): pdf.js로 각 페이지의 텍스트와 좌표를 추출합니다. 세로 글자와, 계기 버블처럼 `FIC` / `101`로 나뉘어 표기된 태그도 처리합니다.
2. **Claude 판독** (`server/analyzer.js`): PDF 원본과 텍스트 레이어(좌표 포함)를 함께 보내고, JSON 스키마(Structured Outputs)로 도면·설비·배관·이슈를 받습니다. 정책상 거절이 발생하면 서버 측 fallback(`fallbacks: "default"`)이 다른 모델로 재시도합니다.
3. **후처리·검증** (`server/postprocess.js`):
   - 태그와 라인 번호를 텍스트 레이어에서 다시 찾아 위치(bbox)를 보정합니다. 텍스트 레이어가 없는 스캔 도면은 AI가 추정한 위치를 사용하고, 뷰어에 그 사실을 표시합니다.
   - 규칙 기반 검증: 미연결 설비/라인, 존재하지 않는 연결 대상, 라인 번호·관경·Spec 누락, 사양 없는 설비, 태그 중복, Off-page 짝 맞춤(입력된 도면끼리는 자동 연결).
   - AI가 보고한 이슈와 규칙 검증 결과를 합치되, 같은 대상·같은 유형의 이슈는 한 번만 남깁니다.

분석 진행 상황은 NDJSON 스트림(`POST /api/analyze`)으로 화면에 표시됩니다.

## 제한 사항

- 한 번에 분석할 수 있는 PDF는 총 22MB, 100페이지까지입니다(Claude API 요청 크기 한도 기준). 더 큰 도면 세트는 나누어 분석하세요.
- 판독 결과는 AI 추정이 포함된 1차 자료입니다. **신뢰도 낮음**과 **AI 추정 위치**로 표시된 항목은 원본 도면에서 다시 확인하세요.
- 배관 길이는 P&ID에 나타나지 않으므로 산출하지 않습니다(배관 물량은 관경·Spec·From/To 기준으로 정리).

## 개발

```bash
npm test          # 텍스트 위치 검색 및 검증 로직 테스트 (샘플 도면 사용)
npm run sample    # 샘플 P&ID PDF 재생성 (Python + reportlab 필요)
```

```
server/   index.js(API·정적 파일) · analyzer.js(Claude 호출) · pdfText.js(텍스트/좌표) · postprocess.js(검증)
public/   index.html · app.js(Flow·리스트·도면 뷰어) · styles.css
samples/  샘플 도면 2장(의도적 결함 포함) · demo-analysis.json
```
