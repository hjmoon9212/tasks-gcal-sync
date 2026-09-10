import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings, migrateFeedColors } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { PersistedState, emptyState } from "./sync/StateStore";
import { GoogleAuth } from "./auth/GoogleAuth";
import { CalendarClient } from "./gcal/CalendarClient";
import { TaskRepository } from "./data/TaskRepository";
import { TaskWriter } from "./write/TaskWriter";
import { SkipKind, SyncEngine, SyncResult } from "./sync/SyncEngine";
import { SyncLogWriter, withDeviceTag } from "./sync/SyncLog";
import { EventFeed } from "./gcal/EventFeed";
import { GcalReadApi } from "./api/PublicApi";

interface PluginData {
  settings: PluginSettings;
  state?: PersistedState; // 구버전 호환: 예전엔 여기 state가 내장됨(현재는 state.json으로 분리)
}

/** 지금은 없는 옛 설정들. 남아 있으면 지우기만 한다. */
interface LegacySettings {
  syncPreset?: string; // 타이밍 프리셋(≤0.3.13) — 0.3.14에서 제거, 값은 직접 설정만
  pushOnly?: boolean; // 단방향 모드(≤0.3.13) — 0.3.14에서 제거, 항상 양방향
  doneOnFree?: boolean; // free(한가함)=완료 제스처(0.3.0~0.3.18) — 0.3.19에서 제거
  syncOnWindowSwitch?: boolean; // 창 전환 트리거(0.3.11~0.3.12) — 0.3.13에서 제거
  syncOnBlur?: boolean;
  syncOnFocus?: boolean;
  skipPullOnEdit?: boolean;
}

/** skip 사유를 사람이 읽는 말로. 숫자만 보여주면 원인을 못 찾는다. */
const SKIP_LABEL: Record<SkipKind, string> = {
  "vault-behind": "볼트 동기화 중",
  "duplicate-id": "🆔 중복",
  "hold-task-gone": "task 없음(보류)",
  "hold-due-invalid": "📅 없음(보류)",
  "hold-unschedule": "이벤트 삭제됨(보류)",
  "hold-conflict": "충돌 해결 보류(볼트 정착 대기)",
  "cold-start-create": "콜드 스타트(생성 보류)",
  "unsettled-create": "볼트 정착 대기(생성 보류)",
  "ensure-id-failed": "🆔 쓰기 실패",
  "create-failed": "이벤트 생성 실패",
  "pull-failed": "캘린더를 읽지 못함(쓰기 보류)",
  "push-precondition": "GCal이 그 사이 또 바뀜(push 포기)",
  "reconcile-error": "조정 실패",
};

/** localStorage 키. App.saveLocalStorage가 볼트 단위로 네임스페이스를 붙인다. */
const STATE_LS_KEY = "tasks-gcal-sync:state";

/** 로그 파일의 기본 경로. 실제 파일에는 여기에 기기 태그가 붙는다. */
const DEFAULT_LOG_PATH = "Logs/GCal 동기화 로그.md";

/**
 * 종료 직전 플러시에 허용하는 최대 시간(ms).
 *
 * Obsidian 이 `Tasks` 의 promise 를 await 하므로 **상한이 없으면 네트워크가 멎을 때 앱
 * 종료가 같이 멈춘다.** 끄려는 사람을 붙잡느니 그 편집을 다음 실행으로 미루는 편이 낫다 —
 * 미뤄도 잃지 않는다(못 올린 run 은 스냅샷을 안 건드린다).
 */
const QUIT_FLUSH_MAX_MS = 5_000;

/**
 * 기기-로컬 state 구조. 항목마다 성격이 다르다:
 *  - **자격증명** = 진실원천. 기기 고유이고 동기화되면 안 된다(v0.3.1의 존재 이유).
 *  - **records / syncTokens** = 캐시. 매핑도 스냅샷도 이미 GCal 이벤트의
 *    extendedProperties(tgsTaskId/tgsDue/tgsStart/tgsDone/tgsTitle)에 심겨 있어
 *    캘린더 스캔 한 번으로 복원된다(SyncEngine.rebuildRecords). 잃어도 된다.
 *
 * v0.3.8부터 저장 위치가 플러그인 폴더의 state.json → **localStorage**다.
 * state.json은 `.obsidian/plugins/...` 안이라 "설치된 커뮤니티 플러그인" 동기화가
 * 켜진 기기에서는 결국 동기화된다 — 기기-로컬이라는 전제가 거기서 깨져,
 * 자격증명이 Sync를 타고 기기끼리 파일 단위로 덮어써졌다. localStorage는 동기화되지 않는다.
 */
interface StateFile {
  records: PersistedState["records"];
  syncTokens: PersistedState["syncTokens"];
  lastFullScanAt?: PersistedState["lastFullScanAt"];
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string | null;
  /**
   * 동기화 로그 파일에 붙는 이 기기의 이름.
   *
   * **자격증명과 같은 이유로 여기(localStorage)에 있다** — data.json에 두면 기기끼리
   * 동기화돼 서로의 태그를 덮어쓰고, 그러면 두 기기가 결국 같은 파일에 쓰게 되어
   * 분리한 의미가 없어진다. 한 번 정해지면 바뀌지 않는다(사용자가 설정에서 바꾸기 전까지).
   */
  logDeviceTag?: string;
}

export default class TasksGcalSyncPlugin extends Plugin {
  settings!: PluginSettings;
  state!: PersistedState;
  auth!: GoogleAuth;
  client!: CalendarClient;
  repo!: TaskRepository;
  writer!: TaskWriter;
  engine!: SyncEngine;
  log!: SyncLogWriter;
  feed!: EventFeed;
  /**
   * 다른 플러그인이 쓰는 공개 읽기 API(`gcal-calendar-view`).
   * 한 번 나간 모양은 없애지 않는다 → src/api/PublicApi.ts
   */
  api!: GcalReadApi;

  private syncing = false;
  private intervalId: number | null = null;
  private autoPushTimer: number | null = null;
  private followUpTimer: number | null = null;
  private feedIntervalId: number | null = null;
  private lastSyncAt = 0; // 마지막 동기화 "완료" 시각(ms) — 최소 간격 계산 기준
  private lastResult: SyncResult | null = null;
  private lastFatal: string | null = null;
  private statusBar!: HTMLElement;

  async onload(): Promise<void> {
    // **어느 버전이 돌고 있는지 먼저 말한다.** BRAT 업데이트는 기기마다 따로라, 기기 간
    // 버전 불일치가 곧 사고의 형태였다(2026-08-09). "고쳤는데 그대로다"의 첫 번째 원인은
    // 늘 "그 기기가 아직 옛 버전"이므로 로그 맨 위에서 확인할 수 있어야 한다.
    console.log(
      `[tasks-gcal-sync] v${this.manifest.version} 로드 (${this.app.vault.getName()})`
    );
    await this.loadAll();
    void this.noteLegacyLogFile();

    this.auth = new GoogleAuth(
      () => ({
        clientId: this.settings.clientId,
        clientSecret: this.settings.clientSecret,
        refreshToken: this.settings.refreshToken,
      }),
      async (token) => {
        this.settings.refreshToken = token;
        await this.saveState(); // refreshToken은 기기-로컬 자격증명 → 로컬에만 저장
      }
    );
    this.client = new CalendarClient(this.auth);
    this.repo = new TaskRepository(this.app, () => this.settings.globalFilter);
    this.writer = new TaskWriter(this.app, () => this.settings.globalFilter);
    this.log = new SyncLogWriter(this.app, () => ({
      enabled: this.settings.syncLogEnabled,
      path: this.logPath(),
      maxKB: this.settings.syncLogMaxKB,
      logSkips: this.settings.syncLogSkips,
    }));
    this.engine = new SyncEngine(
      this.app,
      this.settings,
      this.state,
      this.repo,
      this.client,
      this.writer,
      () => this.saveState()
    );

    // 캘린더 뷰용 외부 일정 피드.
    // ⛔ this.state 를 넘기지 않는다 — syncToken 은 동기화 엔진의 증분 커서이고,
    //    표시용 소비자가 공유하면 그 자리에서 동기화가 망가진다. 인자가 없다는 사실이
    //    그 제약의 집행 수단이다(→ src/gcal/EventFeed.ts).
    this.feed = new EventFeed(
      this.client,
      () => this.settings.feedCalendars ?? [],
      () => this.auth.isAuthenticated()
    );
    this.api = this.feed;

    // 수동 실행은 force — 사용자가 명시적으로 요청한 것이므로 콜드 스타트/뒤처짐 보류를
    // 우회한다(자동 트리거만 보류 대상).
    this.addRibbonIcon("calendar-clock", "Tasks → Google Calendar 동기화", () =>
      this.runSync(false, { force: true, manual: true, trigger: "수동(리본)" })
    );
    this.addCommand({
      id: "sync-now",
      name: "지금 동기화 (Tasks → Google Calendar)",
      callback: () =>
        this.runSync(false, { force: true, manual: true, trigger: "수동(명령)" }),
    });
    this.addCommand({
      id: "backfill-ids",
      name: "기존 이벤트 설명에 🆔 백필",
      callback: () => this.backfillIds(),
    });
    this.addCommand({
      id: "sync-report",
      name: "동기화 리포트 (마지막 결과 · 건너뛴 이유 · 실패)",
      callback: () => this.showReport(),
    });
    this.addCommand({
      id: "rebuild-records",
      name: "캘린더 전수 스캔 (매핑 재구성 · 고아 이벤트 회수)",
      callback: () =>
        this.runSync(false, {
          fullScan: true,
          force: true,
          manual: true,
          trigger: "수동(전수 스캔)",
        }),
    });
    this.addCommand({
      id: "cleanup-duplicates",
      name: "중복 이벤트 정리 (같은 task의 GCal 중복 삭제)",
      callback: () => this.cleanupDuplicates(),
    });
    this.addCommand({
      id: "open-sync-log",
      name: "동기화 로그 열기 (건별 상세 기록)",
      callback: () => this.openSyncLog(),
    });
    this.addCommand({
      id: "refresh-events",
      name: "캘린더 뷰 일정 새로 고침",
      callback: () => {
        void (async () => {
          await this.feed.refreshAll();
          // 결과를 말한다. "받아옵니다" 만 띄우고 조용히 실패하면, 화면에 남은 낡은
          // 일정이 **성공한 결과처럼** 보인다.
          new Notice(
            this.feed.lastError
              ? `일정 조회 실패 — ${this.feed.lastError}`
              : "캘린더 뷰 일정을 다시 받아왔습니다."
          );
        })();
      },
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("GCal —");
    this.addSettingTab(new SettingsTab(this.app, this));

    // task 편집 시 자동 push (디바운스). 파일 저장 이벤트 기준.
    // 마크다운이 아니거나 우리가 방금 쓴 파일이면 무시 — pull이 노트를 고칠 때마다
    // 그 modify로 no-op 동기화가 한 번 더 도는 것을 막는다.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        // 로그 파일은 우리가 매 run 끝에 쓴다. 이걸 편집으로 받으면
        // [동기화 → 로그 기록 → modify → 자동 push → 동기화]가 끝없이 돈다.
        if (file.path === this.logPath()) return;
        if (this.writer.wroteRecently(file.path, 10_000)) return;
        this.scheduleAutoPush();
      })
    );

    // 종료 직전에 밀린 편집 push 를 흘려보낸다 — onunload 는 타이머를 버리기만 한다.
    this.registerQuitFlush();

    this.app.workspace.onLayoutReady(() => {
      this.setupInterval();
      this.setupFeedInterval();
      if (this.settings.syncOnStartup && this.auth.isAuthenticated()) {
        // 메타데이터 캐시가 준비될 시간을 약간 둠.
        // 전수 스캔은 엔진이 하루 1회로 알아서 판단한다(캐시가 비었으면 즉시).
        // 예전엔 실행할 때마다 캘린더 ±2년치를 훑었다.
        window.setTimeout(() => this.runSync(true, { trigger: "시작 시" }), 3000);
      }
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);
    if (this.followUpTimer !== null) window.clearTimeout(this.followUpTimer);
    if (this.feedIntervalId !== null) window.clearInterval(this.feedIntervalId);
    // 캐시는 메모리에만 있다 — 언로드하면 남의 회의 제목이 아무데도 안 남는다
    this.feed?.unload();
    // 쌓아 둔 로그 블록을 흘려보낸다(await 할 수 없으므로 best-effort).
    void this.log?.flush();
  }

  /**
   * 편집 후 디바운스하여 동기화.
   *  - 디바운스: 편집이 멎고 autoPushDebounceSeconds 뒤에 실행. 연속 편집(날짜 → 시작일 →
   *    우선순위)이 한 번으로 합쳐진다. 타이머를 하나만 쓰므로 그 사이 편집이 더 들어와도
   *    실행 횟수는 늘지 않는다.
   *
   * ⛔ **최소 간격을 여기 걸지 않는다**(0.9.0~). 그 값의 목적은 *"빈 run 을 자주 돌리지
   * 말자"* 인데 편집 트리거는 **사용자가 실제로 뭔가 바꾼 시점**이라 해당하지 않는다.
   * 걸어 두면 직전 run 직후의 편집이 최대 minSyncIntervalSeconds 만큼 밀리고 — 기본값
   * 조합에서 최대 60초였다 — 그 창 안에 Obsidian 이 꺼지면 그 편집은 이 세션에서 GCal 에
   * 닿지 못한다. 창을 좁히는 것이 「편집 → push 전 종료」를 줄이는 첫 번째 수단이다.
   * (남은 창은 `quit` 훅이 회수한다 → onload 의 workspace.on("quit"))
   */
  scheduleAutoPush(): void {
    if (!this.settings.autoPushOnEdit) return;
    if (!this.auth.isAuthenticated()) return;
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);

    const delay = Math.max(0, this.settings.autoPushDebounceSeconds) * 1000;

    this.autoPushTimer = window.setTimeout(() => {
      this.autoPushTimer = null;
      // 편집 트리거도 pull을 함께 한다(0.3.13~). 증분 pull은 캘린더당 목록 호출 1회로 싸고,
      // 원격을 안 보고 미는 run은 "로컬 무조건 승"이 되어 GCal의 최신 변경을 덮어쓴다.
      this.runSync(true, { trigger: "편집 자동" });
    }, delay);
  }

  /**
   * 종료 직전, 밀린 편집 push 를 흘려보낸다(0.9.0~).
   *
   * `onunload()` 는 예약된 타이머를 **취소만** 하고 버린다. 그래서 편집 후 디바운스가
   * 끝나기 전에 Obsidian 을 끄면 그 편집은 이 세션에서 GCal 에 닿지 못했다.
   * `workspace.on("quit")` 이 넘겨주는 `Tasks.add()` 는 Obsidian 이 **종료 전에 await**
   * 해 주는 공식 창구다.
   *
   * 짚어둘 것:
   *  - 새 트리거를 만드는 게 아니라 **이미 예약된 push 를 앞당길 뿐**이다. 그래서 0.3.11의
   *    창 전환 트리거를 0.3.13이 없앤 이유(*"스테일 구간에서 push 를 한 번 더 유발한다"*)에
   *    걸리지 않는다 — 밀린 편집이 없으면 아무것도 하지 않는다.
   *  - **반드시 상한을 건다.** Obsidian 이 이 promise 를 await 하므로 네트워크가 멎으면
   *    종료가 그만큼 멈춘다.
   *  - **force 를 붙이지 않는다.** 볼트가 뒤처졌으면 보류되는 게 맞고, 보류돼도 잃지 않는다 —
   *    push 못 한 run 은 스냅샷을 안 건드리므로 다음 실행에서 정상 push 로 흘러간다.
   *  - 문서상 "Not guaranteed to actually run"(강제종료·크래시)이라 best-effort 다. 그래도
   *    지금은 100% 버리고 있으므로 순수 개선이다.
   */
  private registerQuitFlush(): void {
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        // 쌓아 둔 보류 기록은 밀린 편집이 없어도 내보낸다 → SyncLogWriter.append
        tasks.add(() => this.log.flush());
        if (this.autoPushTimer === null) return; // 밀린 편집 없음
        window.clearTimeout(this.autoPushTimer);
        this.autoPushTimer = null;
        tasks.add(() =>
          Promise.race([
            this.runSync(true, { trigger: "종료 직전" }),
            new Promise<void>((r) => window.setTimeout(r, QUIT_FLUSH_MAX_MS)),
          ])
        );
      })
    );
  }

  /** 최소 간격이 지나기까지 남은 시간(ms). 0이면 지금 돌아도 된다. */
  private cooldownRemaining(): number {
    const cooldown = Math.max(0, this.settings.minSyncIntervalSeconds) * 1000;
    return Math.max(0, this.lastSyncAt + cooldown - Date.now());
  }

  setupInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const m = this.settings.syncIntervalMinutes;
    if (m > 0) {
      this.intervalId = window.setInterval(() => {
        // 방금 편집 트리거로 돌았으면 이번 틱은 건너뛴다(최소 간격).
        if (this.cooldownRemaining() > 0) return;
        this.runSync(true, { trigger: `주기(${m}분)` });
      }, m * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  /**
   * 캘린더 뷰에 그릴 외부 일정만 따로 갱신하는 주기. **동기화 주기와 무관하다.**
   *
   * 회의는 우리 동기화와 상관없이 바뀌므로 주기가 달라야 맞고, 실제로 사용자가 볼
   * 필요가 있는 것은 "회의가 바뀌었을 때" 뿐이다. 그래서 여기서 하는 일은 강제 재조회
   * 하나이고, 내용이 정말 달라졌을 때만 EventFeed 가 뷰에 알린다(→ eventsSignature).
   * 재조회 중에도 뷰는 낡은 사본을 계속 그리므로 화면이 비지 않는다.
   */
  setupFeedInterval(): void {
    if (this.feedIntervalId !== null) {
      window.clearInterval(this.feedIntervalId);
      this.feedIntervalId = null;
    }
    const m = this.settings.feedRefreshMinutes;
    if (m > 0) {
      this.feedIntervalId = window.setInterval(
        () => void this.feed.refreshTracked({ force: true }),
        m * 60_000
      );
      this.registerInterval(this.feedIntervalId);
    }
  }

  async runSync(
    silent = false,
    opts: {
      pull?: boolean;
      fullScan?: boolean;
      force?: boolean;
      /**
       * 사람이 직접 누른 실행인가. 그때는 캘린더 뷰의 일정도 같이 다시 받아온다 —
       * "지금 맞춰라" 는 뜻이므로 회의 쪽만 낡은 채로 두면 절반만 한 것이 된다.
       * **자동 트리거에는 절대 붙이지 않는다**(v0.7.0~0.7.2 가 그렇게 해서 5분마다
       * 일정 막대가 깜빡였다 → EventFeed 클래스 주석).
       */
      manual?: boolean;
      /** 로그에 남길 실행 계기(수동·주기·편집 등). 원인 추적에 이게 있어야 한다. */
      trigger?: string;
    } = {}
  ): Promise<void> {
    // 진행 중이면 이번 호출은 버린다. 다만 **그냥 버리면 안 된다** — 2026-08-06 사고에서
    // 시작 run이 도는 동안 발화한 자동 트리거가 재예약 없이 사라졌다. 보류 재확인이
    // 촘촘해질수록 겹칠 확률이 올라가므로, 자동 호출은 조금 뒤로 다시 잡는다.
    if (this.syncing) {
      if (!opts.force) this.scheduleFollowUp(5_000);
      return;
    }
    if (!this.auth.isAuthenticated()) {
      if (!silent) new Notice("먼저 설정에서 Google 인증을 하세요.");
      return;
    }
    this.syncing = true;
    this.statusBar.setText("GCal ⟳");
    try {
      const r = await this.engine.run(opts);
      this.lastResult = r;
      this.lastFatal = null;
      // **자동 run 은 피드를 건드리지 않는다**(v0.7.3). 피드는 `tgsTaskId` 가 **없는**
      // 이벤트만 담고, 엔진이 만들고 고치고 지우는 건 전부 task 이벤트다 — 즉 run 이
      // 끝났다는 사실은 피드가 보여 줄 내용과 아무 상관이 없다. 예전엔 여기서 무효화를
      // 했고, 그 탓에 동기화가 돌 때마다 일정 막대가 통째로 사라졌다 돌아왔다.
      // 자동 갱신은 feedRefreshMinutes 주기로 따로 돈다(→ setupFeedInterval).
      //
      // 다만 **사람이 직접 누른 run 은 예외**(v0.7.4). "지금 맞춰라" 는 뜻이므로 회의
      // 쪽만 낡은 채로 두면 절반만 한 것이 된다. 던지고 잊는다 — 동기화 결과 보고가
      // 네트워크 뒤에 갇히면 안 되고, 재조회 중에도 화면은 비지 않는다.
      if (opts.manual) void this.feed.refreshAll();
      // 엔진이 뭔가를 미뤘으면(체크 해제 보류 · 볼트 뒤처짐 · 콜드 스타트) 그 시점에 한 번
      // 더 돈다. 이게 없으면 보류가 풀려도 다음 주기(기본 5분)까지 GCal이 그대로라
      // "아무 일도 안 일어난다"로 보인다.
      if (r.retryAfterMs) this.scheduleFollowUp(r.retryAfterMs);
      const skipDetail = this.describeSkips(r);
      if (skipDetail) console.log("[tasks-gcal-sync] 건너뜀:", skipDetail);
      for (const f of r.failures) {
        console.error(`[tasks-gcal-sync] 실패 ${f.where}: ${f.message}`);
      }
      const summary =
        `+${r.created} ~${r.updated} ↔${r.moved} -${r.deleted} ⬇${r.pulled}` +
        (r.skipped ? ` (skip ${r.skipped})` : "");
      if (!silent || r.created || r.updated || r.moved || r.deleted || r.pulled) {
        const msg = `GCal 동기화: ${summary}`;
        console.log("[tasks-gcal-sync]", msg);
        new Notice(msg, 10000);
      }
      // Notice는 10초, 상태바는 마지막 하나, console은 재시작하면 사라진다 →
      // "무엇이 왜 지워졌나"에 나중에 답할 수 있는 건 이 파일뿐이다.
      await this.log.append(summary, r.entries, opts.trigger ?? "수동");
      // **항목별 실패는 예외가 아니라 결과다.** 예전엔 전부 catch 로 삼키고 상태바에
      // `✓` 를 찍어서, 인증이 통째로 깨진 채 "도는 것 같은데 아무것도 안 바뀌는"
      // 상태가 며칠 갔다(2026-07-21). 하나라도 터졌으면 눈에 보이게 한다.
      if (r.failures.length) {
        this.statusBar.setText(`GCal ⚠ ${this.nowHM()}`);
        if (!silent) {
          new Notice(
            `동기화 중 ${r.failures.length}건 실패 — ${r.failures[0].message}`,
            10000
          );
        }
      } else {
        this.statusBar.setText(`GCal ✓ ${this.nowHM()}`);
      }
      this.statusBar.setAttribute("aria-label", this.reportText());
    } catch (e: any) {
      console.error("[tasks-gcal-sync]", e);
      this.lastFatal = e?.message ?? String(e);
      await this.log.append(
        "동기화 중단",
        [{ action: "FAIL", detail: `run 전체 실패: ${this.lastFatal}` }],
        opts.trigger ?? "수동"
      );
      if (!silent) new Notice("동기화 실패: " + e.message);
      this.statusBar.setText(`GCal ⚠ ${this.nowHM()}`);
      this.statusBar.setAttribute("aria-label", this.reportText());
    } finally {
      this.syncing = false;
      this.lastSyncAt = Date.now(); // 최소 간격은 "완료" 시각 기준 (실패해도 연타 방지)
    }
  }

  /** 보류가 풀리는 시점에 후속 동기화 1회. 겹치면 마지막 것만 남는다. */
  private scheduleFollowUp(delay: number): void {
    if (this.followUpTimer !== null) window.clearTimeout(this.followUpTimer);
    this.followUpTimer = window.setTimeout(() => {
      this.followUpTimer = null;
      this.runSync(true, { trigger: "보류 해제 후속" });
    }, delay);
  }

  private describeSkips(r: SyncResult): string {
    return (Object.keys(r.skips) as SkipKind[])
      .filter((k) => r.skips[k])
      .map((k) => `${SKIP_LABEL[k]} ${r.skips[k]}`)
      .join(" · ");
  }

  /** 상태바 tooltip · 리포트 명령이 함께 쓰는 요약. */
  private reportText(): string {
    const lines: string[] = [];
    const r = this.lastResult;
    lines.push(
      this.lastSyncAt
        ? `마지막 동기화: ${this.nowHM()} 기준 ${Math.round(
            (Date.now() - this.lastSyncAt) / 1000
          )}초 전`
        : "아직 동기화한 적 없음"
    );
    if (this.lastFatal) lines.push(`⚠ 동기화 실패: ${this.lastFatal}`);
    if (r) {
      lines.push(
        `결과: 생성 ${r.created} · 수정 ${r.updated} · 이동 ${r.moved} · 삭제 ${r.deleted} · 노트반영 ${r.pulled}`
      );
      const skips = this.describeSkips(r);
      if (skips) lines.push(`건너뜀 ${r.skipped}건 — ${skips}`);
      for (const f of r.failures.slice(0, 5)) {
        lines.push(`⚠ ${f.where}: ${f.message}`);
      }
      if (r.failures.length > 5) {
        lines.push(`… 외 ${r.failures.length - 5}건 (콘솔 참고)`);
      }
    }
    if (!this.auth.isAuthenticated()) lines.push("⚠ Google 미인증");
    const scan = this.state.lastFullScanAt;
    lines.push(
      scan
        ? `전수 스캔: ${Math.round((Date.now() - scan) / 3600_000)}시간 전`
        : "전수 스캔: 아직 안 함"
    );
    return lines.join("\n");
  }

  /** 동기화 로그 경로(볼트 루트 기준). 비어 있으면 기본값. */
  /** 설정에 적힌 '기본 경로'. 실제 파일은 여기에 기기 태그가 붙은 형제 파일이다. */
  logBasePath(): string {
    const p = this.settings.syncLogPath?.trim();
    return normalizePath(p || DEFAULT_LOG_PATH);
  }

  /**
   * 이 기기가 실제로 쓰는 로그 파일 경로.
   *
   * 기기마다 다른 파일에 쓴다 → withDeviceTag 주석 참고. `vault.on("modify")`의
   * 자기 파일 제외도 이 값을 보므로 경로가 바뀌어도 따라온다.
   */
  logPath(): string {
    return withDeviceTag(this.logBasePath(), this.deviceTag());
  }

  /**
   * 이 기기의 이름. 최초 1회 정해 localStorage에 굳힌다.
   *
   * Obsidian Sync의 기기 이름을 빌리되 **라벨로만 쓴다** — 비공식 API이고 Sync가
   * 꺼져 있거나 아직 준비되지 않았을 수 있다. 없으면 난수로 대체하고, 그 뒤로는
   * 신호가 오든 말든 굳힌 값을 쓴다(파일 이름이 도중에 바뀌면 기록이 두 파일로 갈린다).
   */
  deviceTag(): string {
    if (!this.state) return ""; // loadAll 전 — withDeviceTag가 기본 경로를 그대로 준다
    if (this.state.logDeviceTag) return this.state.logDeviceTag;
    const sync = (this.app as any).internalPlugins?.plugins?.sync?.instance;
    const name =
      typeof sync?.deviceName === "string" && sync.deviceName.trim()
        ? sync.deviceName.trim()
        : `기기-${Math.random().toString(36).slice(2, 6)}`;
    this.state.logDeviceTag = name;
    void this.saveState();
    return name;
  }

  /**
   * 0.8.0 이전의 **기기 공용** 로그가 남아 있으면 한 번 알린다.
   *
   * 이름을 바꾸거나 지우지 않는다 — 그 자체가 동기화 이벤트라 지금 없애려는 바로 그
   * 충돌 표면을 다시 만든다. 새 파일로 옮겨 가고, 옛 파일은 사용자가 판단한다.
   */
  private async noteLegacyLogFile(): Promise<void> {
    try {
      const legacy = this.logBasePath();
      if (legacy === this.logPath()) return;
      if (!(await this.app.vault.adapter.exists(legacy))) return;
      console.log(
        `[tasks-gcal-sync] 이 기기의 로그는 이제 "${this.logPath()}" 에 쌓입니다. ` +
          `이전 통합 로그 "${legacy}" 는 그대로 두었습니다(필요 없으면 직접 삭제).`
      );
    } catch {
      /* 안내일 뿐이라 실패해도 무시한다 */
    }
  }

  /** 설정에서 기기 이름을 바꾼다. 옛 파일은 그대로 두고 새 파일로 옮겨 간다. */
  async setDeviceTag(name: string): Promise<void> {
    const v = name.trim();
    if (!v || v === this.state.logDeviceTag) return;
    this.state.logDeviceTag = v;
    await this.saveState();
  }

  /**
   * 로그 노트를 새 탭으로 연다.
   * 볼트 인덱스 밖(.obsidian 등)에 두면 Obsidian이 노트로 취급하지 않아 열 수 없다 —
   * 그때는 경로를 옮기라고 알린다(조용히 실패하면 로그가 없는 것처럼 보인다).
   */
  async openSyncLog(): Promise<void> {
    const path = this.logPath();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(f);
      return;
    }
    if (await this.app.vault.adapter.exists(path)) {
      new Notice(
        `로그가 볼트 인덱스 밖에 있어 열 수 없습니다:\n${path}\n설정에서 볼트 안 경로(예: Logs/…)로 바꾸세요.`,
        12000
      );
      return;
    }
    new Notice("아직 기록된 동기화 로그가 없습니다.", 6000);
  }

  private showReport(): void {
    const text = this.reportText();
    console.log("[tasks-gcal-sync] 리포트\n" + text);
    new Notice(text, 15000);
  }

  private nowHM(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }

  async backfillIds(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      new Notice("먼저 Google 인증을 하세요.");
      return;
    }
    new Notice("기존 이벤트에 🆔 백필 시작…");
    try {
      const r = await this.engine.backfillDescriptions();
      const msg = `백필 완료: ${r.ok}개 성공${r.fail ? `, ${r.fail} 실패` : ""}`;
      console.log("[tasks-gcal-sync]", msg);
      new Notice(msg, 10000);
    } catch (e: any) {
      new Notice("백필 실패: " + e.message);
      console.error(e);
    }
  }

  async cleanupDuplicates(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      new Notice("먼저 Google 인증을 하세요.");
      return;
    }
    new Notice("중복 이벤트 정리 시작…");
    try {
      const r = await this.engine.cleanupDuplicates();
      const msg = `중복 정리 완료: ${r.removed}개 삭제 (${r.checked}개 task 확인)`;
      console.log("[tasks-gcal-sync]", msg);
      new Notice(msg, 10000);
    } catch (e: any) {
      new Notice("중복 정리 실패: " + e.message);
      console.error(e);
    }
  }

  private loadLocalState(): StateFile | null {
    try {
      const raw = this.app.loadLocalStorage(STATE_LS_KEY);
      if (raw === null || raw === undefined || raw === "") return null;
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as StateFile;
    } catch (e) {
      console.error("[tasks-gcal-sync] 로컬 state 로드 실패:", e);
      return null;
    }
  }

  /** 구버전 state.json(플러그인 폴더 내). 자격증명 회수 + 삭제에만 쓴다. */
  private async loadLegacyStateFile(): Promise<StateFile | null> {
    const path = normalizePath(`${this.manifest.dir}/state.json`);
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      return JSON.parse(await this.app.vault.adapter.read(path)) as StateFile;
    } catch (e) {
      console.error("[tasks-gcal-sync] state.json 로드 실패:", e);
      return null;
    }
  }

  /** 남겨두면 Sync를 타고 되살아나 자격증명이 계속 새어나간다 → 이관 후 지운다. */
  private async removeLegacyStateFile(): Promise<void> {
    const path = normalizePath(`${this.manifest.dir}/state.json`);
    try {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
        console.log("[tasks-gcal-sync] 구 state.json 이관 완료 → 삭제");
      }
    } catch (e) {
      console.warn("[tasks-gcal-sync] state.json 삭제 실패(무시):", e);
    }
  }

  private async loadAll(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.migrateTiming();
    migrateFeedColors(this.settings);

    // 캐시(records/syncTokens)는 GCal에서 복원되므로 이관할 필요가 없다.
    // 지켜야 하는 건 자격증명뿐 — 우선순위: localStorage > 구 state.json > data.json.
    const local = this.loadLocalState();
    this.state = local
      ? {
          records: local.records ?? {},
          syncTokens: local.syncTokens ?? {},
          lastFullScanAt: local.lastFullScanAt,
          logDeviceTag: local.logDeviceTag,
        }
      : data?.state ?? emptyState(); // 아주 옛 버전: data.json 내장 state
    const legacy = await this.loadLegacyStateFile();

    // data.json 쪽 값은 가장 낮은 우선순위 — Sync를 타는 곳이라 롤백된 옛 secret일 수 있다.
    const firstStr = (...v: (string | undefined)[]) => v.find((s) => !!s);
    const firstDef = <T>(...v: (T | undefined)[]) =>
      v.find((x) => x !== undefined);
    this.settings.clientId =
      firstStr(local?.clientId, legacy?.clientId, this.settings.clientId) ?? "";
    this.settings.clientSecret =
      firstStr(
        local?.clientSecret,
        legacy?.clientSecret,
        this.settings.clientSecret
      ) ?? "";
    this.settings.refreshToken =
      firstDef(
        local?.refreshToken,
        legacy?.refreshToken,
        this.settings.refreshToken
      ) ?? null;
    // localStorage가 비었거나 구 state.json이 남아 있으면 정규화해서 다시 적는다.
    const migrate = !local || !!legacy;

    if (!this.state.syncTokens) this.state.syncTokens = {};
    if (!this.state.records) this.state.records = {};

    // 구버전(단일 대상 캘린더) → 기본 캘린더로 마이그레이션
    if (this.settings.targetCalendarId && !this.settings.defaultCalendarId) {
      this.settings.defaultCalendarId = this.settings.targetCalendarId;
      this.settings.defaultCalendarName = this.settings.targetCalendarName ?? "";
    }
    // 구버전 records(calendarId 없음) → 기본 캘린더로 간주
    for (const rec of Object.values(this.state.records)) {
      if (!rec.calendarId) rec.calendarId = this.settings.defaultCalendarId;
    }

    if (migrate) {
      await this.saveState(); // 로컬 state 생성/갱신(자격증명 + 캐시)
      await this.saveSettings(); // data.json을 settings(비밀 제외)만으로 재기록
    }
    // 로컬 저장이 끝난 뒤에 지운다 — 순서가 반대면 중간에 죽었을 때 자격증명을 잃는다.
    if (legacy) await this.removeLegacyStateFile();
  }

  /**
   * 없어진 옵션을 settings에서 떼어낸다. 다음 저장 때 data.json에서도 빠진다.
   * 값은 읽지 않는다 — 타이밍은 각 항목을 직접 설정하고(프리셋 없음),
   * 동기화는 항상 양방향이다(단방향 없음). 기존 값이 남아 있어도 무시한다.
   */
  private migrateTiming(): void {
    const dead: (keyof LegacySettings)[] = [
      "doneOnFree",
      "skipPullOnEdit",
      "syncOnBlur",
      "syncOnFocus",
      "syncOnWindowSwitch",
      "syncPreset",
      "pushOnly",
    ];
    for (const k of dead) delete (this.settings as Partial<LegacySettings>)[k];
  }

  /** 설정만 data.json에 저장 — 자격증명(clientId·clientSecret·refreshToken)은 제외해 Sync로 새어나가지 않게 한다. */
  async saveSettings(): Promise<void> {
    const safe: Partial<PluginSettings> = { ...this.settings };
    delete safe.clientId;
    delete safe.clientSecret;
    delete safe.refreshToken;
    await this.saveData({ settings: safe as PluginSettings });
  }

  /**
   * 자격증명 + 캐시(records/syncTokens)를 기기-로컬 localStorage에 저장.
   * 볼트 파일을 건드리지 않으므로 Obsidian Sync를 타지 않는다.
   */
  async saveState(): Promise<void> {
    const sf: StateFile = {
      records: this.state.records,
      syncTokens: this.state.syncTokens,
      lastFullScanAt: this.state.lastFullScanAt,
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken: this.settings.refreshToken,
      logDeviceTag: this.state.logDeviceTag,
    };
    this.app.saveLocalStorage(STATE_LS_KEY, JSON.stringify(sf));
  }

  /** 설정 UI 저장용: 설정(data.json) + 자격증명/state(기기 로컬 localStorage) 둘 다 기록. */
  async saveAll(): Promise<void> {
    await this.saveSettings();
    await this.saveState();
  }
}
