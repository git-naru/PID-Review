# 인수인계: P&ID/PFD 분석 도구 (투자비 산출 입력용)

최종 갱신: 2026-10-30

## 1. 목적
엔지니어링 산출물인 P&ID·PFD PDF를 분석해 투자비(CAPEX) 산출의 입력 조건을 만드는 도구다.
- **도면 판독**: PDF 한 장 또는 여러 장을 넣으면 Claude가 판독한다. 공정 Flow, 설비·배관(스트림)·계기·범례 리스트(10행 표시 후 스크롤), 검토 필요 항목을 보여 준다.
- **원본 위치 확인**: 리스트나 검토 항목을 더블클릭하면 원본 도면의 해당 위치를 확대해 보여 준다.
- **물질수지 연동**: 물질수지(Mass Balance)를 넣으면 도면 스트림과 매칭해 유량, Li 농도(g/L) 등을 보여 준다.

## 2. 결정된 사항
### 실행 방식
사용자가 주로 쓰는 방식은 **채팅 분석**이다.
1. **채팅 분석 (주력)**: https://claude.ai/artifact/BjLxfaLP3jJLLJ3mk1TbND (비공개)
   - 페이지는 도면 업로드와 결과 보기만 한다.
   - 사용자가 채팅에 "분석 요청했어"라고 하면 Claude Code 세션이 분석해 결과를 페이지에 넣는다. 절차는 4장에 있다.
2. **페이지에서 바로 분석**: https://claude.ai/artifact/4x6tjroj1SAKnMPnw9Ga2f ("링크가 있는 누구나" 공유 상태)
   - 사용자 계정의 Claude로 분석한다. 실제 대량 분석은 미검증이다.
3. **로컬 서버**: `npm start`, API 키가 필요하다. 사용자가 비용 때문에 쓰지 않고 있다.
4. **결과 공유**: 보기 전용 단일 HTML(오프라인).
   - `scripts/build-standalone.mjs`로 만든다.
   - 화면 기능은 페이지와 같고, 물질수지 입력도 된다.

### 판독
- 범례(Legend) 시트를 먼저 읽고 나머지 시트에 적용한다.
- PFD는 스트림 번호와 물질수지표 값을 쓴다(`doc_type: 'pfd'`).
- 시트별 결과를 합칠 때 겹치는 id는 도면 번호를 붙여 구분한다.

### 물질수지 (`shared/massbalance.js`, Claude 호출 없이 브라우저에서 처리)
- **읽는 형식**
  - xlsx·csv·텍스트 PDF를 읽는다. 라이브러리 없이 zip/XML을 직접 읽으며, .xls와 DRM 파일은 읽지 못한다.
  - 여러 시트를 합친다. "NOMINAL/DESIGN FLOW" 제목 행은 항목 이름 앞에 붙인다. "Unit" 행에 적힌 설명도 처리한다.
- **매칭 순서**: 스트림 번호 → Line No. 행 → From/To 설비.
- **검토 항목**: 값 불일치, 물질수지에 없는 스트림, 도면에 없는 스트림.
- **Li 농도(g/L)**
  - 액상: Li+ % w/w × 밀도(t/m3) × 10
  - 슬러리: 액상 분율을 곱해 스트림 1 L당으로 계산하고 `*` 표시를 붙인다.
  - 고상 Li2CO3가 있으면 총 Li도 함께 낸다.
- **보여 주는 곳**
  - 상세 정보 맨 위
  - 물질수지 탭의 Li 열
  - Flow 표시 값 선택 목록
- **물질수지 조회**
  - Line No.·스트림 번호를 입력하고 Enter를 누르면 물질수지 표 창이 열린다.
  - 쉼표로 여러 개를 넣으면 나란히 비교한다. 창 안에서도 다시 조회할 수 있다.
  - 창에는 CSV 저장 버튼과 닫기 버튼이 있다.

### 화면 규칙 (사용자 요청으로 정해진 것)
- **Flow 보기 방식**: [기본 | 자동배치], 기본값은 **기본**이다(원본 PDF 도면 위에 표시).
  - 도면마다 확대·이동 상태를 기억한다. 처음에는 폭맞춤으로 열린다.
  - 도구 막대에 **폭맞춤**과 **화면 맞춤** 버튼이 있다.
- **공정 단위 · 도면 종류**: 공정 Flow 제목 오른쪽에 단위 드롭박스(BL1U, BL1D, BL2U, BL2D, HL1U, HL1D, BL3U)와 글씨 **PFD / P&ID**를 둔다.
  - 고른 종류만 색으로 표시한다(PFD 파랑, P&ID 초록).
  - 단위 × 도면 종류(묶음 키 `BL1U-PID` 등)마다 도면·결과·물질수지를 따로 둔다. 처음 화면은 **BL3U · PFD**다.
  - 지금 저장된 POSCO CP3 PFD와 물질수지는 BL3U · PFD에 속한다.
  - 입력할 때(도면 올리기·PDF 입력·물질수지 입력·끌어다 놓기) 먼저 공정 단위 드롭박스와 PFD / P&ID를 고르는 창(`#slotModal`)이 뜬다. 고른 묶음으로 화면을 바꾸고 그 묶음에 넣는다.
- **체크 항목**: 연결목록, Main Stream 두 개만 있고 **기본 꺼짐**. 계기·밸브, 유틸리티 체크는 사용자 요청으로 없앴다. 계기·밸브는 Flow에 표시하지 않고, 유틸리티 선은 항상 표시한다(용수·스팀·공기 PFD가 비지 않게).
- **전체화면**: 화면 맞춤 오른쪽 버튼. 공정 Flow 카드를 화면 가득 펼친다(브라우저 전체화면이 막히면 창 안에서 가득). 들어가고 나올 때 폭맞춤한다.
- **Line No. 표시**: Line No.에만 둥근 테두리를 두르고, 유량 등 표시 값은 테두리 없이 그 아래에 둔다.
- **붉은색은 선택한 항목에만 쓴다.**
  - 기본 보기에서는 검토 필요 항목을 붉게 표시하지 않는다. 자동배치는 기존대로 표시한다.
  - 사용자가 "검토 필요"를 주황색으로 바꾸는 수정을 거절했다.
- **선택한 Stream 경로 표시** (`shared/pdfGeom.js`): 도면의 실제 선과 화살촉을 붉게 칠하며, 투명도는 70%다.
  - **Stream 규칙(사용자 정의)**
    - Stream은 최소한 화살 머리까지 이어진다.
    - 화살 머리에서 다시 이어지는 선이 있으면 같은 Stream이다.
    - 교차는 끊김이 아니다.
  - **구현**: 같은 색·선 모양인 선을 따라간다. 갈림길·합류는 포함하고, 교차하는 곳은 직진한다.
    - 굵기만 다른 가지는 끝에 화살 머리가 있을 때만 포함한다.
    - 다른 Stream의 Line No. 표식이나 설비 기호(닫힌 도형·곡선)에서 멈춘다.
  - **점선**: 대시 조각으로 된 점선은 점선 그대로 칠한다.
- **선택 방법**
  - 도면의 선·화살표를 직접 클릭해도 선택된다. Stream 번호가 없는 선도 선택되며, 양 끝 설비로 From/To를 추정해 보여 준다.
  - 이미 선택한 것을 다시 누르면 선택이 취소된다(Flow·리스트).
- **연결목록 체크**: 선택 항목 아래에 ◀ From / To ▶ 이동 버튼을 띄운다. Off-page에서는 연결 도면으로 넘어간다.
- **Main Stream 체크**: 범례(SYMBOLS)의 "MAIN FLOW" 견본 선과 굵기·색이 같은 선을 주황색(투명도 80%)으로 표시한다. 견본이 없는 도면에서는 표시하지 않는다.
  - 색을 지정하지 않은 선은 PDF 기본색(검정)으로 본다. 0003번은 견본만 색 지정이 없어 누락됐었다.
  - POSCO 0006~0008번은 MAIN FLOW 굵기(2.04)의 공정선이 없어 표시되지 않는 것이 맞다.
- **PFD 분석(바로 분석 페이지)**: 시트 분류에 "pfd"가 있다. 올릴 때 PFD를 골랐거나 PFD 시트가 더 많으면 PFD 지침(`PFD_NOTE`, `shared/prompts.js`)으로 판독하고 `doc_type: 'pfd'`로 낸다. 분류가 모두 "other"여도 파일명·도면 번호·제목에 PFD / PROCESS FLOW DIAGRAM이 있으면 PFD 시트로 본다. 채팅 분석도 `sheets.json`에 `pfd`를 쓸 수 있고, `doc.json`에 note가 없으면 `PFD_NOTE`를 쓴다.
- **이전 / 다음 버튼**: 도면 선택 상자 양옆. 넘길 도면이 없으면 버튼만 회색(비활성), 경고창 없음.
- **속도 관련 구조**
  - 리스트·검토 항목 표는 보이는 줄(앞뒤 30줄)만 만든다(`virtualRows`, 줄 높이 고정 `--row-h`). 클릭은 tbody 하나에서 받는다.
  - 기본 보기에서 이전·다음 도면을 미리 읽어 둔다(`pv.prefetch`: pdf.js 연산 목록 + 선 데이터). 최근 5장만 pdf.js 해석 결과를 남긴다.
  - 단일 HTML: 도면 PDF는 파일마다 `<script type="text/plain">`에 따로 넣고, 묶음을 처음 볼 때 푼다. pdf.js 워커는 파일 안에 일반 스크립트(iife)로 넣어 Blob 워커로 띄운다(파일로 연 페이지는 모듈 워커를 못 띄움). 워커가 "ready"를 안 보내면 같은 스레드로 처리한다(`public/set-pdf-worker.js`).
- **도면 안 물질수지**: 시트 안 스트림 표(H&MB) 값을 판독 때 라인 specs로 옮기고(`shared/prompts.js`), 물질수지 파일이 없으면 `drawingMassBalance()`로 물질수지를 만들어 쓴다(칩 "도면 스트림 표", 검토 항목은 만들지 않음). 파일을 넣으면 파일 우선, 도면 값과의 불일치는 검토 항목.
  - POSCO PFD의 스트림 표는 JBIG2 그림이다. pdf.js wasm 디코더를 `vendor/pdf-wasm.js`(base64, `scripts/pdf-wasm.mjs`가 생성)로 넣어 기본 보기에서도 표가 보이게 했다(`public/pdfopts.js`).
  - 도면 표 값은 반올림돼 있어 Li g/L이 물질수지 파일과 조금 다를 수 있다(1101: 도면 0.725, 파일 0.774).
- **NOTES 문단**: 도면 NOTES 안에서 찾은 스트림 번호에는 유량 등 값을 표시하지 않는다(특이사항 글이므로). Line No. 표식은 남긴다. (`notesRegions`, `shared/pdfGeom.js`)
- **용어**: Pond 등 도면 용어는 번역하지 않는다("연못" 대신 "Pond"). 판독 지시문(`shared/prompts.js` RULES)과 `doc.json` 요약에도 적용한다.

### 작업 관례
- 페이지 코드를 고치면 `npm test`와 `npm run build:artifact`를 실행한다.
- 그다음 **두 아티팩트를 같은 URL로 재게시**하고, POSCO 결과 HTML도 새로 만들어 사용자에게 보낸다.
- UI 문구와 답변은 한국어로 쓴다.

## 3. 현재 진행 상황
- **저장소**: `git-naru/PID-Review`
  - 작업 브랜치는 `claude/sharp-brown-2w1b2p`이다.
  - PR #1, #2 이후 **커밋 약 30개가 `main`에 없다**(PR 미생성).
  - 테스트 25개가 통과한다.
- **POSCO CP3 PFD 8장 분석 완료** (`319020-00626-0000-PR-PFD-00001~00008`)
  - 결과: 설비 125, 스트림 196, 검토 항목 82건(물질수지 2건 포함)
  - 채팅 분석 페이지에 저장된 데이터
    - db `jobs/current`(BL3U · PFD 묶음): `status: done`, 결과 asset `beb65a8b7b692540ded29fb87b314cd2`("연못"→"Pond" 수정본, 이전 `6deebc1e…`)
    - 원본 PDF 8개는 페이지 assets에 있다(asset id는 결과 JSON의 `files[].assetId`).
- **실제 물질수지 반영**: `319020-00626-0000-PR-CAL-00001_B.xlsx`
  - 46개 스트림 모두 매칭됐다.
  - 페이지 db `massbalance/current`(BL3U · PFD 묶음)에 asset `1f5619f35c2489f4c7a60e4dd21da30b`로 저장돼 있어, 페이지를 열면 자동 적용된다.
  - 새 검토 항목 2건
    - 스트림 1090 % Moisture가 도면 100.0, 물질수지 0으로 다르다.
    - 도면 스트림 1095는 물질수지에 없다.
- **BL2U · PFD 38장 분석 완료** (Sal de Oro Project Stage 2, `319020-00265-*`, `319020-00367-*`)
  - 결과: 설비 795, 스트림/라인 1,374, 도면 스트림 표 439개(전부 매칭, Li g/L 336개), 검토 항목 491건(높음 91)
  - db `jobs/BL2U-PFD`: `status: done`, 결과 asset `76286012aaf6319a6750ede8684459f7`(Off-page 짝짓기 개선 후 재병합, 높음 91→66; 이전 `ffce3386…`), PDF 38개는 결과 JSON `files[].assetId`
  - 물질수지 파일 없이 도면 스트림 표로 물질수지를 쓴다. 시트마다 항목 이름이 조금씩 달라 표시 값 목록이 길다(정리 필요).
  - 보낸 파일: `BL2U_PFD_분석결과.html` (`build-standalone.mjs … BL2U-PFD`)
- **BL2U · P&ID 112장 분석 완료** (범례 4장 f0·f1·f15·f16, Typical 2장 f2·f17 제외, P&ID 106장)
  - 결과: 설비 783, 계기 3,045, 밸브 542, 라인 2,100, Off-page 연결 525, 검토 항목 4,050건(높음 336)
  - db `jobs/BL2U-PID`: `status: done`, 결과 asset은 db 문서의 `resultAsset`(OCR 위치 반영본), PDF 112개는 결과 JSON `files[].assetId`
  - 이 세트는 **도면 안 글자가 외곽선**이라 텍스트 레이어에 태그·라인 번호가 없다(표제란만 텍스트). 판독 때 bbox를 생략시켜 위치가 비었고, OCR(`scripts/session/ocr-*.py`)로 채웠다. 이제 `hasTagText()`로 판단해 이런 시트는 모델이 bbox를 낸다.
  - Filtering Earth 제조·분배 2장(Rev. N)은 CANCELED, 벤더 패키지 안 라인과 일부 압축공기 시트는 라인 번호 없음
  - 판독은 Agent 13개 동시 실행, 사용량 제한(429)에 한 번 걸려 리셋 후 빠진 시트만 다시 띄웠다.
- **사용자에게 보낸 결과 HTML**: `PID_Review_BL3U_BL2U_분석결과.html`(BL3U · PFD 물질수지 포함, BL2U · PFD, BL2U · P&ID를 한 파일에, 약 224MB). 이전에 묶음별 파일(`POSCO_CP3_PFD_분석결과.html`, `BL2U_PFD_분석결과.html`, `BL2U_PID_분석결과.html`)도 보냈다.
- **이번 세션의 작업 파일은 새 세션에 없다**(scratchpad). 결과 HTML을 다시 만드는 방법은 4장 끝에 있다.

## 4. 채팅 분석 처리 절차
사용자가 "BL1U · P&ID 분석 요청했어"처럼 말하면 아래 순서로 처리한다. 작업 폴더는 scratchpad 아래 `jobN/`이다.
- **묶음(단위 × PFD/P&ID)마다 문서가 따로다.** `jobs/<문서>`, `massbalance/<문서>`에서 `<문서>`는 BL3U · PFD면 `current`, 나머지는 묶음 키(`BL1U-PID`, `HL1D-PFD` 등)다. 아래의 `jobs/<문서>`는 요청한 묶음의 문서다.
- 묶음을 말하지 않았으면 `jobs` 컬렉션을 `list`해 `status: requested`인 문서를 찾는다.
1. **요청 확인**: `ArtifactData`로 `jobs/<문서>`를 읽는다. `files[]`에 assetId와 파일명이 있고, `slot`, `unit`, `doc_type`(`pfd`|`pid`)이 있다.
2. **진행 표시**: `status: analyzing`과 `progress {done,total,stage}`로 업데이트한다. `if_version`이 필수다.
3. **PDF 내려받기**: Artifact `action: read`에 `path: <assetId>`를 주고 하나씩 받는다(`paths` 일괄은 asset에 안 됨). `files.json`을 `[{name, path, assetId}]` 형식으로 만든다.
4. **준비**: `node scripts/session/prepare.mjs <work> <work>/files.json`
5. **분류와 범례**
   - `classify.txt`를 보고 `sheets.json`을 작성한다.
   - 범례가 있으면 `legend.json`을 작성한다.
   - PFD면 `doc.json`에 `{"doc_type":"pfd","note":...,"summary":...}`를 쓴다.
6. **판독 지시문 생성**: `node scripts/session/make-prompts.mjs <work>`
7. **시트별 판독**: 시트마다 Agent를 병렬로 띄워 `out/f<fi>-p<p>.json`을 쓰게 한다.
8. **병합**: `node scripts/session/assemble.mjs <work>`를 실행하면 `result.json`이 생긴다.
8-1. **(위치가 빈 경우) OCR로 위치 채우기**: 결과에서 설비·라인 위치(`loc.bbox`)가 거의 없으면 도면 글자가 외곽선인 세트다. `apt-get install -y tesseract-ocr` 후 `python3 scripts/session/ocr-sheets.py <work>`(220 dpi, 시트당 약 17초) → `python3 scripts/session/ocr-place.py <work>` → 다시 `assemble.mjs`. 라인 번호는 대부분 잡히고, 계기 버블 안 글자는 잘 안 잡힌다.
9. **결과 업로드**: Artifact `publish`에 `url`, `file_path: result.json`, `asset: true`를 준다.
10. **완료 표시**: `jobs/<문서>`에 `{status:'done', resultAsset, finishedAt, message}`를 쓴다.
11. **(선택) 단일 HTML**: `node scripts/build-standalone.mjs <result.json> <PDF 폴더(원래 파일명)> <out.html> <묶음 키, 예: BL2U-PFD>` (묶음 키를 주면 그 단위·종류로 열린다)
    - 여러 묶음을 한 파일에: `node scripts/build-standalone.mjs --multi <out.html> BL3U-PFD <result.json> <PDF 폴더> BL2U-PID <result.json> <PDF 폴더> ...` (공정 단위·PFD / P&ID 선택으로 바꿔 본다, 처음엔 첫 묶음)

**POSCO 결과 HTML 다시 만들기** (새 세션)
1. 결과 asset `beb65a8b…`과 PDF asset 8개, 물질수지 asset `1f5619f3…`을 `Artifact read`로 받는다.
2. PDF는 원래 파일명으로 한 폴더에 둔다.
3. `node scripts/apply-massbalance.mjs result.json mb.json result-mb.json`
4. `node scripts/build-standalone.mjs result-mb.json <PDF 폴더> POSCO_CP3_PFD_분석결과.html BL3U-PFD`

## 5. 남은 할 일
1. **PR 생성·머지**: 미머지 커밋을 `main`에 반영한다(사용자 요청 시).
2. **P&ID 판독 정확도 검증**: BL2U P&ID 106장을 처리했다. 사용자 검토 결과에 따라 지시문을 다듬는다. 미연결 높음(250건)은 대부분 라인 끝점이 비어 있는 경우다.
3. **큰 단일 HTML 속도**: 통합 파일(약 225MB) 기준 열기 약 4.5초, BL2U · P&ID 첫 전환 약 1초, 다음 도면 0.5~2초. 남은 시간은 대부분 A1 도면을 캔버스에 그리는 시간이다(처음엔 낮은 해상도로 보여 주는 방식을 고려할 수 있음).
4. **경로 추적 개선**
   - Line No.가 연결 기호 옆에 있으면 기호 외곽선만 칠해지는 경우가 있다(예: 1번 도면 1214).
   - 같은 색·선 모양의 다른 배관이 표식 없이 이어진 곳에서는 함께 칠해질 수 있다.
   - 도면 1장 기준 경로 계산에 수 초가 걸린다(배경에서 미리 계산함).
5. **위치 찾기에서 Notes 영역 제외**: POSCO 1번 도면 Notes 문단의 스트림 번호(1315 등)에 위치가 잡힌다.
6. **검토 항목 노이즈 줄이기**, PFD의 이름 없는 펌프 임시 이름(PUMP-1) 검토.
7. **"직접 분석" 페이지 공유 설정 확인**: 링크 공유 상태라, 도면 업로드에는 비공개 채팅 분석 페이지를 쓴다.

## 6. 관련 파일
| 경로 | 내용 |
|---|---|
| `public/index.html`, `app.js`, `styles.css` | 화면: Flow 도구 막대·리스트·검토 항목·상세 정보·도면 뷰어·물질수지 조회 창 |
| `public/pidview.js` | Flow **기본 보기**: 원본 PDF + 클릭 영역, Line No. 테두리·값 태그, 선택 경로·Main Stream 표시, 선 클릭 선택, 연결목록 버튼, 확대·이동 기억 |
| `shared/pdfGeom.js` | PDF 벡터 선·화살촉 추출, Stream 경로 추적, 번호 없는 선 추적, Main Stream 선 찾기 |
| `shared/massbalance.js` | 물질수지 읽기·매칭·검토 항목, Flow 표시 값, Li 농도 계산 |
| `public/chatmode.js` | 채팅 분석 모드: 업로드, 분석 요청, 결과·물질수지 불러오기와 저장 |
| `public/engine.js` | 페이지에서 바로 분석 |
| `shared/postprocess.js`, `merge.js`, `pidText.js`, `prompts.js` | 결과 정규화·검증, 시트 병합, 텍스트 위치, 판독 지침 |
| `server/*.js` | 로컬 서버(API 키 방식) |
| `scripts/build-artifact.mjs` | 아티팩트 번들(`dist/artifact`, `dist/artifact-chat`) |
| `scripts/build-standalone.mjs` | 보기 전용 단일 HTML |
| `scripts/apply-massbalance.mjs` | 결과 JSON에 물질수지 적용(단일 HTML용) |
| `scripts/session/*` | 채팅 분석 단계별 스크립트 |
| `samples/` | 샘플 범례 1장 + P&ID 2장, 데모 결과, 샘플 물질수지(`PID-100-MB.xlsx/.csv`) |
| `test/postprocess.test.js`, `test/massbalance.test.js` | 테스트 23개(후처리·병합·경로 추적·물질수지·Li) |
| `README.md` | 사용법 전체 |
