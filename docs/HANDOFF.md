# 인수인계: P&ID/PFD 분석 도구 (투자비 산출 입력용)

최종 갱신: 2026-10-29

## 1. 목적
엔지니어링 산출물인 P&ID(및 PFD) PDF를 분석해 투자비(CAPEX) 산출의 입력 조건을 만드는 도구.
- PDF 한 장 또는 여러 장을 입력하면 Claude가 도면을 판독한다.
- 공정 Flow를 그리고, 설비·라인을 클릭하면 상세 정보를 보여준다.
- 설비 리스트를 10행 표시 후 스크롤로 보여준다. 배관(스트림)·계기·범례 리스트도 있다.
- 연결되지 않았거나 부정확한 정보를 "검토 필요 항목"으로 따로 모으고, 더블클릭하면 원본 도면의 해당 위치를 확대해 보여준다.

## 2. 결정된 사항
- **기술 스택**
  - Node.js(Express) 서버와 빌드 단계 없는 vanilla JS 프런트엔드
  - Cytoscape(+dagre)로 Flow, pdf.js로 도면 표시
  - 분석 모델은 `claude-opus-5-5`
- **범례(Legend) 우선 판독**: 범례 시트에서 라인 번호 체계, 유체 코드, 배관 Class, 설비/계기 식별 문자, 기호를 먼저 읽고 나머지 시트에 적용한다.
  - 범례 예시 태그는 실제 항목으로 추출하지 않고, 위치 검색에서도 범례 페이지를 제외한다.
  - 범례에 없는 Class·유체 코드 등은 검토 항목으로 올린다.
- **PFD 지원**: 문서 종류가 PFD면 라인 번호·관경·Spec 검사 대신 스트림 번호와 물질수지표 값(라인 `specs`)을 쓴다.
- **실행 방식은 세 가지이고, 사용자는 ②채팅 분석 방식을 선택했다.**
  1. **페이지에서 바로 분석** (아티팩트 `sample` 기능)
     - API 키 없이 사용자 계정 사용량으로 분석한다.
     - 탭을 계속 열어 둬야 하고, 실제 Claude로는 끝까지 검증하지 못했다.
  2. **채팅 분석 (현재 주력)**
     - 페이지는 도면 업로드와 결과 보기만 한다. 분석은 Claude Code 채팅 세션이 하고, 결과를 다시 페이지에 넣는다.
     - 도면이 저장되므로 페이지는 **본인만 열람**하도록 새로 만들었다.
  3. **로컬 서버** (`npm start`, Anthropic API 키 필요)
     - 실제 키로는 실행해 본 적이 없다.
- **결과 공유**: 분석 결과를 화면 그대로 동작하는 **단일 HTML 파일**(보기 전용, 오프라인)로도 만든다.

## 3. 현재 진행 상황
- **저장소**: `git-naru/PID-Review`
  - 작업 브랜치는 `claude/sharp-brown-2w1b2p`이다.
  - PR #1, #2는 `main`에 머지됐다.
  - **그 뒤 커밋 6개는 아직 `main`에 없다**(PR 미생성). 내용: 대량 시트 이어서 분석, 채팅 분석 모드, PFD 지원, 병합 버그 수정, 단일 HTML 내보내기.
  - 테스트 10개가 통과한다(`npm test`).
- **아티팩트 페이지**
  - 채팅 분석용 (비공개): https://claude.ai/artifact/BjLxfaLP3jJLLJ3mk1TbND
  - 페이지에서 바로 분석용 ("링크가 있는 누구나" 공유 상태): https://claude.ai/artifact/4x6tjroj1SAKnMPnw9Ga2f
- **첫 실제 분석 완료**: POSCO CP3 Option 1 탄산리튬 공정 개념 **PFD 8장**(`319020-00626-0000-PR-PFD-00001~00008`)
  - 결과: 설비 125, 스트림 196, 검토 항목 80건(높음 5 / 중간 47 / 낮음 28)
  - 높음 5건 예: Ca-Mg 반응기 수량 불일치(Note 4는 2기 이상 요구, 도면은 1기), 증발기 시스템 범위 불명확, 주요 설비 수량 미확정
  - 결과는 채팅 분석 페이지에 들어 있다.
    - db `jobs/current`: `status: done`, `resultAsset: 6deebc1e2942be9a27c3507769ccf644`
    - 업로드한 PDF 8개는 페이지 assets에 남아 있다.
  - 단일 HTML `POSCO_CP3_PFD_분석결과.html`(6.8MB)을 사용자에게 전달했다.
- **분석 중 발견해 고친 버그**: 시트별 결과를 합칠 때 시트마다 겹치는 id(PUMP-1 등)가 다른 시트에 잘못 연결됐다.
  - 이 때문에 "미연결 설비"와 "대응 Off-page 없음"이 대량으로 잘못 나왔다.
  - `shared/merge.js`에서 도면 번호를 붙여 id를 구분하도록 고쳤다.
- **샘플 도면 리허설**: 실제 Claude 판독으로 설비·배관을 정확히 읽었고, 의도한 결함 6가지를 모두 검출했다. 시트당 1~4분 걸린다.

## 4. 채팅 분석 처리 절차
사용자가 "분석 요청했어"라고 하면 아래 순서로 처리한다. 작업 폴더는 세션 scratchpad 아래 `jobN/`이다.
1. **요청 확인**: `ArtifactData`로 `jobs/current`를 읽는다. `files[]`에 assetId와 파일명이 있다.
2. **진행 표시**: `jobs/current`를 `status: analyzing`과 `progress {done,total,stage}`로 업데이트한다. `if_version` 필수.
3. **PDF 내려받기**: Artifact `action: read`로 `path: <assetId>` 하나씩 받는다(`paths` 일괄 읽기는 asset에 안 됨). `files.json`을 `[{name, path, assetId}]` 형식으로 만든다.
4. **준비**: `node scripts/session/prepare.mjs <work> <work>/files.json` 실행. `manifest.json`, `classify.txt`, `img/*.jpg`가 생긴다.
5. **분류와 범례**
   - `classify.txt`를 보고 `sheets.json`을 작성한다(`sheet_type`: legend / pid / other).
   - 범례 시트가 있으면 읽어서 `legend.json`을 작성한다.
   - PFD면 `doc.json`에 `{"doc_type":"pfd","note":"PFD 판독 지침","summary":"전체 요약"}`을 쓴다. 지침 예시는 이번 작업의 doc.json 내용을 참고한다.
6. **판독 지시문 생성**: `node scripts/session/make-prompts.mjs <work>` 실행. `prompts/f<fi>-p<p>.txt`가 생긴다.
7. **시트별 판독**: 시트마다 Agent를 하나씩 병렬로 띄운다. 각 Agent는 지시문을 읽고 이미지를 열어 판독한 뒤 `out/f<fi>-p<p>.json`을 쓴다. 완료될 때마다 진행 상황을 업데이트한다.
8. **병합·검증**: `node scripts/session/assemble.mjs <work>` 실행. `result.json`이 생긴다. 높음 등급 규칙 이슈가 많으면 원인을 먼저 확인한다(노이즈 여부).
9. **결과 업로드**: Artifact `publish`에 `url`, `file_path: result.json`, `asset: true`를 주면 asset id가 나온다.
10. **완료 표시**: `jobs/current`를 `{status:'done', resultAsset:<id>, finishedAt, message}`로 업데이트한다. 페이지가 자동으로 표시한다.
11. **(선택) 단일 HTML**: `node scripts/build-standalone.mjs <work>/result.json <PDF 폴더(원래 파일명)> <out.html>` 실행 후 SendUserFile로 전달한다.

- 페이지 코드를 고친 뒤에는 `npm run build:artifact`를 실행한다. 그다음 `dist/artifact-chat/index.html`(채팅용)과 `dist/artifact/index.html`(직접 분석용)을 같은 URL로 재게시한다.
- scratchpad는 세션마다 사라지므로 이번 작업 폴더(job1)는 새 세션에 없다. 원본 PDF와 결과 JSON은 아티팩트에 남아 있다.

## 5. 남은 할 일
1. **PR 생성 및 머지**: 브랜치의 미머지 커밋 6개를 `main`에 반영한다(사용자 요청 시).
2. **실제 P&ID로 검증**: 지금까지 실제 도면은 PFD뿐이었다. 범례 시트가 있는 실제 P&ID 세트로 판독 정확도를 확인한다.
3. **대량 세트(약 75장) 처리 확인**: 사용자가 처음 75장으로 시도했다가 "페이지에서 바로 분석" 방식이 5/75에서 멈췄다.
   - 이어서 분석과 실패 시트 분할 재시도로 고쳤지만 실제 Claude로는 미검증이다.
   - 채팅 분석 방식으로 처리할 때 Agent 동시 실행 수와 사용량을 조절해야 한다.
4. **노이즈 줄이기**: 낮음 등급에 근거가 약한 지적이 일부 섞인다(예: "예비 펌프 미표시").
   - PFD에서 이름 없는 펌프에 임시 이름(PUMP-1 등)을 붙이는 방식도 검토가 필요하다.
5. **Flow 가독성**: 시트가 많으면 노드가 빽빽하다. 지금은 첫 도면만 기본 표시한다. 시트 간 연결 보기 개선을 검토한다.
6. **로컬 서버 API 경로를 실제 키로 1회 검증**: 사용자는 추가 비용 때문에 보류 중이다.
7. **공유 설정 확인**: "직접 분석" 페이지가 링크 공유 상태다. 도면 업로드에는 비공개 채팅 분석 페이지를 쓴다.

## 6. 관련 파일
| 경로 | 내용 |
|---|---|
| `server/index.js` | Express API (`/api/analyze`, `/api/demo`, `/api/status`) |
| `server/analyzer.js` | Claude API 일괄 분석 (Structured Outputs, 서버 방식) |
| `server/pdfText.js` | Node용 pdf.js 래퍼 |
| `shared/pidText.js` | 텍스트 레이어 추출, 태그 위치 검색 (세로 글자·분리된 계기 태그·가까운 위치 우선) |
| `shared/postprocess.js` | 결과 정규화, 위치 보정, 연결성·범례 검증, PFD 처리, Off-page 짝짓기 |
| `shared/merge.js` | 시트별 결과 병합 (id 충돌 처리, 분할 판독 결과 합치기) |
| `shared/prompts.js` | 판독 지침과 결과 형식 (서버·브라우저·세션 공용) |
| `public/index.html`, `app.js`, `styles.css` | 화면 (Flow, 리스트, 검토 항목, 도면 뷰어, 실행 모드 분기) |
| `public/engine.js` | 페이지에서 바로 분석 (단계별 호출, 이어서 분석, 시트 분할 재시도) |
| `public/chatmode.js` | 채팅 분석 모드 (업로드 → 분석 요청 → 결과 표시) |
| `public/set-pdf-worker.js` | 단일 HTML용 pdf.js 워커 대체 |
| `scripts/build-artifact.mjs` | 아티팩트 번들 생성 (`dist/artifact`, `dist/artifact-chat`) |
| `scripts/build-standalone.mjs` | 보기 전용 단일 HTML 생성 |
| `scripts/session/prepare.mjs`, `render_pages.py`, `make-prompts.mjs`, `assemble.mjs` | 채팅 세션 분석 단계별 스크립트 |
| `samples/PID-100-000~002.pdf`, `demo-analysis.json`, `make_sample_pid.py` | 샘플 도면(범례 1 + P&ID 2, 의도적 결함 포함)과 데모 결과 |
| `test/postprocess.test.js` | 테스트 10개 |
| `README.md` | 실행 방법 전체 |
