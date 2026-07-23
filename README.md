# Tasks ⇄ Google Calendar Sync

Obsidian Tasks(📅 due date가 있는 `#task`)를 Google Calendar **종일 이벤트**로 동기화하는 자체 플러그인. Morgen 대체용.

- **Obsidian = 할일 원천, Google Calendar = 조작 화면**(드래그·반복·타임블록은 GCal 앱이 담당)
- 멀티볼트: 볼트마다 설치 + 볼트별로 다른 구글 캘린더에 매핑 → GCal 한 화면이 통합 뷰
- 서버 없음. Obsidian이 열려 있을 때 동기화. 토큰은 Obsidian Sync로 모바일 전파.

## 현재 상태 (v0.2.0)
- ✅ **Phase 1 — 단방향(Obsidian → GCal)**: due task를 종일 이벤트로 생성/갱신, 완료=색상/접두사(`#done` 폴백), 삭제·미일정화 반영.
- ✅ **Phase 2 — 양방향(GCal → Obsidian)**: `syncToken` 증분 pull로 날짜 이동/완료/삭제 감지, LWW 충돌 해결. (기본은 `pushOnly: true` = 안전하게 단방향 출고, 설정에서 양방향 전환)
- ✅ **멀티캘린더 라우팅**: `#gcal/<이름>` 태그로 task별 대상 캘린더 지정, 볼트별 기본 캘린더.
- ✅ **멀티기기 견고화(0.2.0)**: syncToken을 기기 로컬 저장(기기 간 오염 차단) + GCal 이벤트에 마지막 push 스냅샷 임베드(records 유실/충돌 시 재구성).
- ⏳ **남음**: 반복 task(🔁) 미완료 해제 처리, 모바일 실기기 검증.

> **다중 기기 주의**: 플러그인 코드(`main.js`/`manifest.json`)는 Obsidian Sync가 **파일 단위 Last-Write-Wins**로 동기화한다. 여러 기기에서 각각 빌드/편집하면 옛 버전이 역전파돼 롤백날 수 있으므로, **한 기기를 빌드 정본으로 고정**하고 나머지는 받아서 리로드만 할 것. 파일 교체는 반드시 **Obsidian이 켜진 상태**에서(꺼진 채 외부 편집하면 Sync가 감지 못 해 롤백 위험).

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

## 동작 규칙
- 대상: `#task` + 📅 due 가 있는 task. **새 이벤트 생성 범위**: 오늘 이후 due(+ `includeOverdue` 시 미완료 overdue). 이미 record가 있는 항목은 범위와 무관하게 계속 reconcile.
- 완료 표시: **색상**(`doneColorId`, 기본 8) + 제목 접두사(미완료 ☐ / 완료 ☑️) + `#done` 폴백.
- 🆔 없는 task는 첫 동기화 때 6자리 ID를 자동 부여(Tasks 표준 필드, Morgen 비의존). `findByTaskId`로 기기 간 중복 생성 방지(adoption).
- task의 due 변경 → 이벤트 날짜 갱신. 🛫 start가 있으면 start~due 다중일. task 삭제/due 제거 → 이벤트 삭제.
- 양방향(pushOnly=off): GCal에서 날짜 이동/완료/삭제 시 파일 mtime vs event.updated **LWW**로 반영.

## 명령 / 견고성
- 리본 달력 아이콘 또는 명령 **지금 동기화**.
- **🆔 백필** — 기존 이벤트 설명에 🆔 주입(구 데이터 정리).
- **중복 이벤트 정리(cleanup-duplicates)** — 같은 task의 GCal 중복 이벤트 삭제(하나만 유지). *record 없는 orphan 이벤트는 대상 아님.*
- 자동 push(편집 디바운스), 시작 시 동기화, N분 주기(0=수동).

## 알려진 한계
- **반복 task(🔁) 미완료 해제**: `uncomplete`가 Tasks API를 쓰지 않아, 이미 생성된 다음 회차가 남는다.
- **orphan 이벤트**: record 포인터 없이 GCal에만 남은 이벤트는 자동 정리하지 않음(무해).

## 개발
```bash
npm install
npm run dev            # 워치 빌드
npm run build          # 타입체크 + 프로덕션 번들
npm run version-bump 0.2.1   # manifest/package/versions.json 버전 일괄 통일
```
- `src/data/TaskLine.ts` — 이모지 줄 파싱/수술적 재작성(순수 함수). 테스트: `tests/taskline.test.ts`.
- `src/sync/SyncEngine.ts` — 동기화 로직(push + pull). 이벤트 스냅샷(`privateProps`)·record 복원(`recordFromEvent`)으로 기기 간 상태 견고화.
- `src/main.ts` — 플러그인 진입점. `syncTokens`는 기기 로컬 localStorage(`app.saveLocalStorage`), records/settings만 `data.json`에 저장.

### 상태 저장 위치
| 데이터 | 위치 | 이유 |
|---|---|---|
| settings(OAuth 포함) | `data.json` | Obsidian Sync로 기기 전파 |
| records(task↔event 매핑) | `data.json` | 유실 시 이벤트 스냅샷으로 재구성 가능 |
| syncTokens(증분 pull) | 기기 로컬 localStorage | 기기별 단일 소비자 — 공유 시 서로 토큰 오염 |
