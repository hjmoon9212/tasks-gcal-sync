# Tasks ⇄ Google Calendar Sync

Obsidian Tasks(📅 due date가 있는 `#task`)를 Google Calendar **종일 이벤트**로 동기화하는 자체 플러그인. Morgen 대체용.

- **Obsidian = 할일 원천, Google Calendar = 조작 화면**(드래그·반복·타임블록은 GCal 앱이 담당)
- 멀티볼트: 볼트마다 설치 + 볼트별로 다른 구글 캘린더에 매핑 → GCal 한 화면이 통합 뷰
- 서버 없음. Obsidian이 열려 있을 때 동기화. 자격증명은 기기 로컬 **localStorage**에 저장(v0.3.8~, Obsidian Sync를 타지 않음).

## 현재 상태 (v0.4.5)
- ✅ **Obsidian → GCal**: due task를 종일 이벤트로 생성/갱신, 완료 표시(색상/제목 접두사/`#done` 폴백), 삭제·미일정화 반영.
- ✅ **GCal → Obsidian**: `syncToken` 증분 pull로 **날짜 이동·제목 변경·삭제**를 감지해 노트에 반영. 충돌은 필드 단위로 병합한다.
- 🔒 **완료는 Obsidian이 소유**(v0.4.0~): 노트 → 이벤트 한 방향으로만 흐른다. 캘린더에서 색이나 제목을 바꿔도 노트는 바뀌지 않는다.
- ✅ **멀티캘린더 라우팅**: `#gcal/<이름>` 태그로 task별 대상 캘린더 지정, 볼트별 기본 캘린더.
- ✅ **멀티기기 견고화**: 자격증명·records·syncTokens를 기기 로컬 localStorage에 격리 + GCal 이벤트에 마지막 push 스냅샷 임베드 → records는 캘린더에서 재구성 가능한 캐시다.
- 🖥️ **데스크탑 전용**(v0.4.1~): `isDesktopOnly: true` — 모바일에서는 로드되지 않는다. 노트 편집은 Obsidian Sync 가, GCal 반영은 상시 켜진 데스크톱이 맡는다.
- ⏳ **남음**: API 호출 병렬화, 완료된 지난 이벤트 자동 정리.
- 🔁 **재시도**: 429·5xx 와 **403 사용량 초과**(권한 오류와 본문 `reason` 으로 구분)를 지수 백오프 + 지터로 최대 3회. `Retry-After` 가 오면 그걸 따른다.

---

## 설치 (BRAT)

커뮤니티 스토어 미등록 베타. [BRAT](https://github.com/TfTHacker/obsidian42-brat)으로 설치·자동 업데이트한다.

1. 커뮤니티 플러그인에서 **BRAT** 설치·활성화.
2. BRAT → **Add beta plugin** → `hjmoon9212/tasks-gcal-sync` 입력.
3. BRAT이 최신 GitHub Release의 `main.js`·`manifest.json`을 내려받아 설치.
4. 이후 새 Release가 올라오면 BRAT이 자동으로 업데이트(수동: **Check for updates**).

> 소스에서 직접 빌드해 설치하려면 [개발](#개발) 참고. `main.js`는 리포에 커밋되지 않고 Release 애셋으로만 배포된다.

---

## 1. Google Cloud OAuth 클라이언트 만들기 (1회)

1. https://console.cloud.google.com → 새 프로젝트 생성.
2. **API 및 서비스 → 라이브러리** → "Google Calendar API" 검색 → **사용 설정**.
3. **API 및 서비스 → OAuth 동의 화면**:
   - User Type: **외부(External)** 선택 → 앱 이름/이메일만 채우고 저장.
   - **테스트 사용자(Test users)** 에 본인 Google 계정 추가 (게시 안 해도 됨).
   - Scope는 추가 안 해도 됨(플러그인이 요청).
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**:
   - 애플리케이션 유형: **데스크톱 앱(Desktop app)**.
   - 생성 후 나오는 **Client ID**와 **Client Secret**을 복사.

> 데스크톱 앱 클라이언트는 PKCE + 루프백(127.0.0.1)을 사용하므로 redirect URI를 따로 등록할 필요가 없습니다.

## 2. 플러그인 설정

1. Obsidian → 설정 → 커뮤니티 플러그인 → **Tasks ⇄ Google Calendar Sync** 켜기.
2. 플러그인 설정 탭에서:
   - **Client ID / Client Secret** 붙여넣기.
   - **Google 인증** 버튼 클릭 → 브라우저에서 로그인·허용 → "인증 완료" 창 → Obsidian으로 복귀.
   - **목록 불러오기** → 드롭다운에서 이 볼트를 올릴 **대상 캘린더** 선택. (볼트 전용 캘린더를 GCal에서 미리 하나 만들어 두는 걸 권장)
   - Global filter(기본 `#task`), 완료 prefix(기본 `#done`), 동기화 주기 등 확인.
3. 리본의 달력 아이콘 또는 명령어 **"지금 동기화"** 실행.

> **모바일**: v0.4.1 부터 `isDesktopOnly: true` 라 **모바일에서는 플러그인이 아예 로드되지 않는다.** 노트는 Obsidian Sync 가 옮기고 GCal 반영은 데스크톱이 하므로 잃는 기능은 없다. 이유는 셋 — 가끔 잠깐만 켜져 반영이 늘 스테일하고, iOS 는 백그라운드 진입 직후 JS 를 정지시켜 예약해 둔 후속 동기화가 사라지며, 좁은 화면에서 체크박스 오탭이 난다(`✅` 는 되돌릴 수 없는 손실이다). 각 기기에서 인증이 필요하므로 데스크톱마다 Client ID/Secret 을 넣고 인증한다.

## 동작 규칙
- 대상: `#task` + 📅 due 가 있는 task. **새 이벤트 생성 범위**: 오늘 이후 due(+ `includeOverdue` 시 미완료 overdue). 이미 record가 있는 항목은 범위와 무관하게 계속 reconcile.
- **완료 표시(표시 전용)**: 완료한 task의 이벤트를 **색상**(`doneColorId`, 기본 8=회색)과 **제목 접두사**(미완료 ☐ / 완료 ☑️)로 표시한다. 둘 다 껐을 때만 `#done` 폴백.
  > **완료는 GCal에서 바꿀 수 없다(v0.4.0~).** GCal엔 "완료"라는 어휘가 없어서 색·제목·free 같은 다른 용도의 필드를 빌려 읽어야 했는데, 빌린 필드는 다른 이유로도 바뀌고 **오탐의 결과가 노트에 ✅를 쓰는 것**(반복이면 다음 회차 줄 생성 + 🆔 발급)이라 파괴적이었다. 0.3.6·0.3.13·0.3.15·0.3.17·0.3.19가 전부 이 주변에서 났다. 날짜는 GCal의 1급 필드라 값 자체가 의미이고 멱등하게 맞출 수 있어 양방향으로 남는다.
- 🆔 없는 task는 첫 동기화 때 6자리 ID를 자동 부여(Tasks 표준 필드, Morgen 비의존). `findByTaskId`로 기기 간 중복 생성 방지(adoption).
- task의 due 변경 → 이벤트 날짜 갱신. 🛫 start가 있으면 start~due 다중일. task 삭제/due 제거 → 이벤트 삭제.
- **⏰ 타임블록**: `⏰ HH:MM-HH:MM`(종료 생략 시 시작+1시간, 항상 같은 날 안으로 정규화)이 있으면 시간지정 이벤트, 없으면 종일. **단 🛫 start 가 📅 due 보다 앞선 다중일 task 에서는 ⏰ 를 무시하고 종일 다중일 블록으로 만든다** — GCal 의 시간지정 이벤트는 "첫날 시작시각 → 마지막날 종료시각" 한 덩어리라 "여러 날 · 매일 같은 시간대"로는 읽히지 않는다(그건 반복 이벤트라야 표현된다). 노트의 ⏰ 는 지우지 않으므로 🛫 를 떼거나 📅 를 당겨 하루짜리가 되면 시각이 그대로 살아난다.
- 양방향(날짜·제목): GCal에서 날짜 이동/제목 변경/삭제 시 필드(due/start/title) 단위로 병합. 같은 필드가 양쪽에서 바뀐 경우에만 GCal을 채택하고 warn을 남긴다. 완료는 병합 대상이 아니다.

## 명령 / 견고성
- 리본 달력 아이콘 또는 명령 **지금 동기화**.
- **🆔 백필** — 기존 이벤트 설명에 🆔 주입(구 데이터 정리).
- **동기화 리포트(sync-report)** — 마지막 결과 · **건너뛴 이유(사유별)** · 실패 목록 · 인증 상태 · 전수 스캔 경과. 상태바에 마우스를 올려도 같은 내용이 뜬다.
- **캘린더 전수 스캔(rebuild-records)** — 매핑 재구성 + 고아 이벤트 회수. 평소엔 **하루 1회** 자동으로 돌고(캐시가 비면 즉시), 이 명령으로 언제든 강제할 수 있다.
- **중복 이벤트 정리(cleanup-duplicates)** — 같은 task의 GCal 중복 이벤트 삭제(하나만 유지).

> record 를 잃은 orphan 이벤트는 **전수 스캔이 record 로 회수한 뒤 "task 없음 → 삭제" 경로가 정리**한다. 따로 명령이 필요 없다.
- 타이밍은 각 항목을 직접 설정한다(프리셋 없음): 편집 시 자동 동기화 · 편집 후 대기(초) · 최소 간격(초) · 시작 시 동기화 · 주기(분, 0=끔).

## 알려진 한계
- **캘린더에서 완료 불가**: 완료는 Obsidian에서만 바꾼다(위 참조). 아이폰 기본 캘린더든 Google Calendar 앱이든 마찬가지.
- **모바일 미지원**: `isDesktopOnly: true`(v0.4.1~). 되돌리려면 `manifest.json` 을 고쳐 재배포한다 — 설정 UI 로는 못 켠다.
- **이벤트 설명**: 플러그인이 관리하는 건 `— tasks-gcal-sync —` 마커 **아래**뿐이다(v0.4.3~). 그 위에 적은 메모는 보존된다. 다만 이벤트를 그 run 에 읽지 못했으면 설명을 아예 안 보내므로, 딥링크 줄번호 같은 값이 한 사이클 낡을 수 있다.

---

## 개발
```bash
npm install
npm run dev                  # 워치 빌드
npm run build                # 타입체크 + 프로덕션 번들 → main.js
npm test                     # esbuild로 tests/*.test.ts 번들 → node 실행
npm run version-bump 0.3.3   # manifest/package/versions.json 버전 일괄 통일
```
테스트는 `esbuild.test.mjs`가 `tests/*.test.ts`를 `.test-build/`로 묶어 node로 돌린다(별도 러너 의존성 없음). `obsidian` 모듈은 `tests/obsidian-stub.ts`로 alias된다. CI(`.github/workflows/ci.yml`)와 릴리스(`release.yml`) 모두 `npm run build && npm test`를 돌리므로 **테스트가 깨지면 Release가 만들어지지 않는다.**
- `src/data/TaskLine.ts` — 이모지 줄 파싱/수술적 재작성(순수 함수). 테스트: `tests/taskline.test.ts`.
- `src/sync/reconcile.ts` — **조정 판단(순수 함수)**. 무엇을 pull/push/삭제할지, 어떤 가드가 걸리는지를 I/O 없이 결정한다. 파괴적 동작 허용 여부는 `destructiveAllowed` 한 곳에만 있다. 테스트: `tests/decide.test.ts`(결정표).
- `src/sync/SyncEngine.ts` — 그 결정의 **실행**(GCal 호출·노트 쓰기) + 이벤트 스냅샷(`privateProps`)·record 복원(`recordFromEvent`)으로 기기 간 상태 견고화. 테스트: `tests/reconcile.test.ts`(스텁으로 run() 구동).
- `src/main.ts` — 플러그인 진입점. 설정은 `data.json`, 자격증명·records·syncTokens는 기기 로컬 **localStorage**에 저장(구 `state.json`은 로드 시 1회 이관 후 삭제).

### 상태 저장 위치
| 데이터 | 위치 | Sync 대상 | 이유 |
|---|---|:---:|---|
| settings(비밀 제외) | `data.json` | ✅ | Obsidian Sync로 기기 전파 |
| 자격증명(clientId·secret·refreshToken) | localStorage | ❌ | secret이 Sync로 새거나 롤백되지 않게 기기 로컬 격리 |
| records(task↔event 매핑) | localStorage | ❌ | 유실 시 이벤트 스냅샷(`tgs*`)으로 재구성 가능 |
| syncTokens(증분 pull) | localStorage | ❌ | 기기별 단일 소비자 — 공유 시 서로 토큰 오염 |

> localStorage는 볼트 파일이 아니라 Obsidian Sync를 타지 않는다(v0.3.8~). 이전 버전이 쓰던 `<pluginDir>/state.json`은 플러그인 폴더 안이라 "설치된 커뮤니티 플러그인" 동기화가 켜진 기기에서 결국 동기화돼 자격증명이 덮어써졌다 — 지금은 로드 시 1회 이관하고 파일을 지운다. **기기마다 각자 인증이 필요하다.**

---

## 배포 (버전업 → BRAT 전파)

배포는 **manifest 버전과 같은 이름의 git 태그를 push**하면 GitHub Actions(`.github/workflows/release.yml`)가 자동으로 처리한다.

```bash
# 1. 세 버전 파일 통일 (예: 0.3.3)
npm run version-bump 0.3.3     # manifest/package/versions.json

# 2. 빌드·테스트로 깨지지 않는지 확인
npm run build

# 3. 소스 커밋·푸시 (main.js는 gitignore라 커밋 안 됨)
git add manifest.json package.json versions.json src/
git commit -m "v0.3.3: ..."
git push

# 4. 버전과 같은 태그 push  ← 배포 방아쇠 (v 접두사 없이!)
git tag 0.3.3
git push origin 0.3.3
```

태그 push 순간 Actions가 `npm ci && npm run build` 후 `main.js`·`manifest.json`·`versions.json`을 첨부한 **GitHub Release**를 만든다. BRAT은 이 최신 Release를 확인해 `manifest.json` 버전이 설치본보다 높으면 자동 업데이트한다.

세 버전 파일의 역할:

| 파일 | 읽는 주체 | 역할 |
|---|---|---|
| `manifest.json` | Obsidian 본체 | **실제 버전**. 업데이트 판정 기준 |
| `versions.json` | BRAT / 커뮤니티 스토어 | `버전 → 최소 Obsidian 버전(minAppVersion)` 이력 매핑 |
| `package.json` | 개발용(npm) | 빌드용. 헷갈림 방지로 버전만 동기화 |
