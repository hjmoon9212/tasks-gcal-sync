import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { PersistedState, emptyState } from "./sync/StateStore";
import { GoogleAuth } from "./auth/GoogleAuth";
import { CalendarClient } from "./gcal/CalendarClient";
import { TaskRepository } from "./data/TaskRepository";
import { TaskWriter } from "./write/TaskWriter";
import { CompletionHandler } from "./write/CompletionHandler";
import { SyncEngine } from "./sync/SyncEngine";

interface PluginData {
  settings: PluginSettings;
  state?: PersistedState; // 구버전 호환: 예전엔 여기 state가 내장됨(현재는 state.json으로 분리)
}

/** 지금은 없는 옛 설정들. 남아 있으면 지우기만 한다. */
interface LegacySettings {
  syncPreset?: string; // 타이밍 프리셋(≤0.3.13) — 0.3.14에서 제거, 값은 직접 설정만
  pushOnly?: boolean; // 단방향 모드(≤0.3.13) — 0.3.14에서 제거, 항상 양방향
  syncOnWindowSwitch?: boolean; // 창 전환 트리거(0.3.11~0.3.12) — 0.3.13에서 제거
  syncOnBlur?: boolean;
  syncOnFocus?: boolean;
  skipPullOnEdit?: boolean;
}

/** localStorage 키. App.saveLocalStorage가 볼트 단위로 네임스페이스를 붙인다. */
const STATE_LS_KEY = "tasks-gcal-sync:state";

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
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string | null;
}

export default class TasksGcalSyncPlugin extends Plugin {
  settings!: PluginSettings;
  state!: PersistedState;
  auth!: GoogleAuth;
  client!: CalendarClient;
  repo!: TaskRepository;
  writer!: TaskWriter;
  completion!: CompletionHandler;
  engine!: SyncEngine;

  private syncing = false;
  private intervalId: number | null = null;
  private autoPushTimer: number | null = null;
  private lastSyncAt = 0; // 마지막 동기화 "완료" 시각(ms) — 최소 간격 계산 기준
  private statusBar!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadAll();

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
    this.completion = new CompletionHandler(this.app);
    this.engine = new SyncEngine(
      this.app,
      this.settings,
      this.state,
      this.repo,
      this.client,
      this.writer,
      this.completion,
      () => this.saveState()
    );

    // 수동 실행은 force — 사용자가 명시적으로 요청한 것이므로 콜드 스타트/뒤처짐 보류를
    // 우회한다(자동 트리거만 보류 대상).
    this.addRibbonIcon("calendar-clock", "Tasks → Google Calendar 동기화", () =>
      this.runSync(false, { force: true })
    );
    this.addCommand({
      id: "sync-now",
      name: "지금 동기화 (Tasks → Google Calendar)",
      callback: () => this.runSync(false, { force: true }),
    });
    this.addCommand({
      id: "backfill-ids",
      name: "기존 이벤트 설명에 🆔 백필",
      callback: () => this.backfillIds(),
    });
    this.addCommand({
      id: "cleanup-duplicates",
      name: "중복 이벤트 정리 (같은 task의 GCal 중복 삭제)",
      callback: () => this.cleanupDuplicates(),
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
        if (this.writer.wroteRecently(file.path, 10_000)) return;
        this.scheduleAutoPush();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.setupInterval();
      if (this.settings.syncOnStartup && this.auth.isAuthenticated()) {
        // 메타데이터 캐시가 준비될 시간을 약간 둠.
        // 시작 시 1회는 캘린더 전체를 훑어 records를 재구성한다 → record를 잃은
        // 이벤트(고아)가 시야에 들어와 다음 사이클에 정리된다.
        window.setTimeout(() => this.runSync(true, { fullScan: true }), 3000);
      }
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);
  }

  /**
   * 편집 후 디바운스하여 동기화.
   *  - 디바운스: 편집이 멎고 autoPushDebounceSeconds 뒤에 실행. 연속 편집(날짜 → 시작일 →
   *    우선순위)이 한 번으로 합쳐진다.
   *  - 최소 간격: 직전 동기화 완료 후 minSyncIntervalSeconds가 안 지났으면 남은 만큼 더 미룬다.
   *    타이머를 하나만 쓰므로 그 사이 편집이 더 들어와도 실행 횟수는 늘지 않는다.
   */
  scheduleAutoPush(): void {
    if (!this.settings.autoPushOnEdit) return;
    if (!this.auth.isAuthenticated()) return;
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);

    const debounce = Math.max(0, this.settings.autoPushDebounceSeconds) * 1000;
    const delay = Math.max(debounce, this.cooldownRemaining());

    this.autoPushTimer = window.setTimeout(() => {
      this.autoPushTimer = null;
      // 편집 트리거도 pull을 함께 한다(0.3.13~). 증분 pull은 캘린더당 목록 호출 1회로 싸고,
      // 원격을 안 보고 미는 run은 "로컬 무조건 승"이 되어 GCal의 최신 변경을 덮어쓴다.
      this.runSync(true);
    }, delay);
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
        this.runSync(true);
      }, m * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  async runSync(
    silent = false,
    opts: { pull?: boolean; fullScan?: boolean; force?: boolean } = {}
  ): Promise<void> {
    if (this.syncing) return;
    if (!this.auth.isAuthenticated()) {
      if (!silent) new Notice("먼저 설정에서 Google 인증을 하세요.");
      return;
    }
    this.syncing = true;
    this.statusBar.setText("GCal ⟳");
    try {
      const r = await this.engine.run(opts);
      if (!silent || r.created || r.updated || r.moved || r.deleted || r.pulled) {
        const msg =
          `GCal 동기화: +${r.created} ~${r.updated} ↔${r.moved} -${r.deleted} ⬇${r.pulled}` +
          (r.skipped ? ` (skip ${r.skipped})` : "");
        console.log("[tasks-gcal-sync]", msg);
        new Notice(msg, 10000);
      }
      this.statusBar.setText(`GCal ✓ ${this.nowHM()}`);
    } catch (e: any) {
      console.error("[tasks-gcal-sync]", e);
      if (!silent) new Notice("동기화 실패: " + e.message);
      this.statusBar.setText(`GCal ⚠ ${this.nowHM()}`);
    } finally {
      this.syncing = false;
      this.lastSyncAt = Date.now(); // 최소 간격은 "완료" 시각 기준 (실패해도 연타 방지)
    }
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

    // 캐시(records/syncTokens)는 GCal에서 복원되므로 이관할 필요가 없다.
    // 지켜야 하는 건 자격증명뿐 — 우선순위: localStorage > 구 state.json > data.json.
    const local = this.loadLocalState();
    this.state = local
      ? { records: local.records ?? {}, syncTokens: local.syncTokens ?? {} }
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
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken: this.settings.refreshToken,
    };
    this.app.saveLocalStorage(STATE_LS_KEY, JSON.stringify(sf));
  }

  /** 설정 UI 저장용: 설정(data.json) + 자격증명/state(기기 로컬 localStorage) 둘 다 기록. */
  async saveAll(): Promise<void> {
    await this.saveSettings();
    await this.saveState();
  }
}
