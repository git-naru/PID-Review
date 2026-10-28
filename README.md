# P&ID Review

투자비(CAPEX) 산출의 입력 조건으로 쓰기 위해 P&ID(Piping & Instrument Diagram) PDF를 분석하는 웹 도구입니다.
PDF를 한 장 또는 여러 장 입력하면 Claude가 도면을 판독해 설비·배관·계기 정보를 추출하고, 연결성 검증을 거쳐 아래 결과를 보여줍니다.

- **범례(Legend) 반영**: P&ID 세트 앞부분의 범례 시트에서 라인 번호 체계, 유체 코드, 배관 Class, 설비/계기 식별 문자, 기호를 먼저 읽고, 이를 기준으로 나머지 도면을 해석합니다. 범례 탭에서 각 코드가 실제 도면에서 몇 건 쓰였는지 확인할 수 있습니다(예: Class별 적용 라인).
- **공정 Flow**: 설비, Off-page, Battery Limit을 배관으로 연결한 흐름도. 설비나 라인을 클릭하면 상세 정보(사양, 연결 배관, 관경/Spec, 검토 사항)를 표시합니다.
- **설비 리스트 / 배관 리스트 / 계기·밸브**: 10건씩 표시되며, 그 이상은 스크롤해서 확인합니다. 검색할 수 있고, 더블클릭하면 원본 도면의 해당 위치로 이동합니다.
- **검토 필요 항목**: 미연결 설비, 끝단이 연결되지 않은 라인, 라인 번호·관경·Spec 누락, 태그 중복, 입력되지 않은 도면을 가리키는 Off-page 같은 항목을 모은 목록입니다. **더블클릭하면 입력된 P&ID의 해당 부분을 확대하고 강조 표시합니다.**
- **내보내기**: 설비/배관/계기/검토 항목/범례 CSV(Excel 호환)와 전체 결과 JSON을 내려받을 수 있습니다. 배관 CSV에는 범례의 Class 설명(재질·Rating)이 함께 들어갑니다.

## 실행

실행 방법은 두 가지입니다.

### 1. claude.ai 아티팩트 (API 키 불필요)

`npm run build:artifact`로 만든 `dist/artifact/`를 claude.ai 아티팩트로 올리면, 별도 서버 없이 브라우저에서 동작합니다. 분석은 **페이지를 연 사람의 claude.ai 계정 Claude**로 실행되므로 API 키나 추가 결제가 필요 없고, 요금제 사용량에 포함됩니다. 처음 분석할 때 Claude 사용 허용을 한 번 묻습니다.

브라우저 분석은 Claude 호출을 단계별로 나눕니다(`public/engine.js`).
1. pdf.js로 텍스트 레이어를 추출하고 페이지 이미지를 렌더링합니다. 이미지는 전체 1장과 겹치게 자른 4분할입니다.
2. 시트 종류(범례/P&ID)를 분류합니다.
3. 범례 시트를 읽습니다.
4. P&ID 시트마다 따로 판독합니다. 시트당 1~3분 걸릴 수 있습니다.
5. 결과를 병합한 뒤 서버와 같은 후처리(`shared/postprocess.js`)를 거칩니다.

아티팩트는 다음 runtime capability를 선언해야 합니다.
- `sample: {images: true}`: Claude 호출, 이미지 포함
- `downloads`: CSV/JSON 저장

### 2. 채팅 분석 (도면은 페이지에 올리고, 분석은 Claude Code 채팅에서)

`dist/artifact-chat/`은 같은 화면의 변형입니다. 이 페이지는 도면을 올리고 결과를 보는 일만 하고, 분석은 Claude Code 채팅 세션이 맡습니다. 브라우저 탭을 열어 둘 필요가 없어서 수십 장 규모의 도면 세트에 적합합니다.

1. **페이지에서**: **도면 올리기**로 PDF를 올립니다(파일당 20MB 이하).
2. **페이지에서**: **분석 요청**을 누릅니다.
3. **채팅에서**: "분석 요청했어"라고 알립니다.
4. **세션에서**: 요청된 PDF를 받아 `scripts/session/` 순서로 분석합니다. 진행 상황은 페이지에 표시됩니다.
   - `prepare.mjs`: 텍스트 레이어 추출과 이미지 렌더링
   - 시트 분류와 범례 판독
   - `make-prompts.mjs`: 시트별 판독 지시문 생성
   - 시트별 판독(병렬)
   - `assemble.mjs`: 병합과 검증
5. **세션에서**: 결과 JSON을 페이지 저장소에 올립니다. 페이지가 자동으로 결과를 표시합니다.

데이터는 페이지의 저장 기능에 들어 있습니다.
- `assets`: 업로드한 PDF와 결과 JSON
- `db` `files/<assetId>`: 업로드 목록
- `db` `jobs/current`: 요청 상태, 진행 상황, 결과 위치

필요한 capability는 `assets`, `db`, `user`, `downloads`입니다. 도면이 저장되므로 페이지 공유 범위에 주의하세요.

### 3. 로컬 서버 (Anthropic API 키 사용)


```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # Claude API 키
npm start                             # http://localhost:3000
```

API 키가 없어도 **샘플 데모** 버튼으로 전체 기능을 확인할 수 있습니다. 데모는 `samples/`의 샘플 범례 1장, P&ID 2장과 미리 작성해 둔 판독 결과를 사용하며, 위치 보정과 연결성 검증은 실제 분석과 똑같이 실행됩니다.

환경 변수(선택):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 분석 모델 |
| `CLAUDE_EFFORT` | `high` | 판독 깊이 (`low`~`max`) |
| `CLAUDE_MAX_TOKENS` | `64000` | 출력 한도. 대형 도면 세트에서 한도 초과 오류가 나면 늘립니다 |

## 분석 방식

1. **텍스트 레이어 추출** (`server/pdfText.js`): pdf.js로 각 페이지의 텍스트와 좌표를 추출합니다. 세로 글자와, 계기 버블처럼 `FIC` / `101`로 나뉘어 표기된 태그도 처리합니다.
2. **Claude 판독** (`server/analyzer.js`): PDF 원본과 텍스트 레이어(좌표 포함)를 함께 보내고, JSON 스키마(Structured Outputs)로 범례·도면·설비·배관·이슈를 받습니다. 먼저 범례 시트를 읽고, 그 체계에 따라 라인 번호를 관경·유체·Class·보온으로 나누고 기호와 태그를 분류합니다. 범례 시트에 적힌 예시 태그는 실제 항목으로 추출하지 않습니다. 범례가 없으면 ISA 5.1 등 일반 관례로 해석합니다. 정책상 거절이 발생하면 서버 측 fallback(`fallbacks: "default"`)이 다른 모델로 재시도합니다.
3. **후처리·검증** (`server/postprocess.js`):
   - 태그와 라인 번호를 텍스트 레이어에서 다시 찾아 위치(bbox)를 보정합니다. 범례 시트의 예시 표기를 실제 위치로 오인하지 않도록 범례 페이지는 검색에서 제외합니다. 텍스트 레이어가 없는 스캔 도면은 AI가 추정한 위치를 사용하고, 뷰어에 그 사실을 표시합니다.
   - 규칙 기반 검증: 미연결 설비/라인, 존재하지 않는 연결 대상, 라인 번호·관경·Spec 누락, 사양 없는 설비, 태그 중복, Off-page 짝 맞춤(입력된 도면끼리는 자동 연결).
   - 범례 대조: 범례에 없는 배관 Class·유체 코드·설비 Tag 접두어·계기 측정변수 문자를 검출합니다. 범례 시트가 입력되지 않았으면 그 사실도 검토 항목으로 알립니다.
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
npm run build:artifact   # claude.ai 아티팩트 번들 생성 (dist/artifact)
```

```
server/   index.js(API·정적 파일) · analyzer.js(Claude API 호출) · pdfText.js(Node용 pdf.js 래퍼)
shared/   pidText.js(텍스트/좌표) · postprocess.js(검증) · prompts.js(판독 지침) — 서버·브라우저 공용
public/   index.html · app.js(Flow·리스트·도면 뷰어) · engine.js(아티팩트용 브라우저 분석) · styles.css
public/   chatmode.js(채팅 분석 모드: 업로드·요청·결과 표시)
scripts/  build-artifact.mjs(아티팩트 번들 생성 → dist/artifact, dist/artifact-chat)
scripts/session/  prepare.mjs · render_pages.py · make-prompts.mjs · assemble.mjs (채팅 세션 분석, Python + pypdfium2 필요)
shared/   merge.js(시트별 결과 병합)
samples/  샘플 범례 1장 + P&ID 2장(의도적 결함 포함) · demo-analysis.json
```
