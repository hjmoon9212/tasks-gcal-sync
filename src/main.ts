import { Notice, Plugin, normalizePath } from "obsidian";
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

/**
 * 기기-로컬 state.json 파일 구조(Obsidian Sync 대상 아님).
 * records/syncTokens에 더해 **자격증명(clientId·clientSecret·refreshToken)** 도 여기 보관 →
 * 동기화되는 data.json엔 secret이 남지 않아, Sync 롤백이 자격증명을 옛 값으로 되돌리지 못한다.
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
        await this.saveState(); // refreshToken은 기기-로컬 자격증명 → state.json에만 저장
      }
    );
    this.client = new CalendarClient(this.auth);
    this.repo = new TaskRepository(this.app, () => this.settings.globalFilter);
    this.writer = new TaskWriter(this.app);
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

    this.addRibbonIcon("calendar-clock", "Tasks → Google Calendar 동기화", () =>
      this.runSync()
    );
    this.addCommand({
      id: "sync-now",
      name: "지금 동기화 (Tasks → Google Calendar)",
      callback: () => this.runSync(),
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
    this.registerEvent(
      this.app.vault.on("modify", () => this.scheduleAutoPush())
    );

    this.app.workspace.onLayoutReady(() => {
      this.setupInterval();
      if (this.settings.syncOnStartup && this.auth.isAuthenticated()) {
        // 메타데이터 캐시가 준비될 시간을 약간 둠
        window.setTimeout(() => this.runSync(true), 3000);
      }
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);
  }

  /** 편집 후 디바운스하여 동기화. 우리 자신의 쓰기로 트리거돼도 변경 없으면 no-op. */
  scheduleAutoPush(): void {
    if (!this.settings.autoPushOnEdit) return;
    if (!this.auth.isAuthenticated()) return;
    if (this.autoPushTimer !== null) window.clearTimeout(this.autoPushTimer);
    this.autoPushTimer = window.setTimeout(() => {
      this.autoPushTimer = null;
      // 양방향(pushOnly=off)이면 pull도 함께 → 편집 직전 GCal 수정을 맹목적으로 덮어쓰지 않고 LWW 적용.
      // 단방향(pushOnly=on)이면 run() 내부에서 어차피 pull 안 함.
      this.runSync(true);
    }, 4000);
  }

  setupInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const m = this.settings.syncIntervalMinutes;
    if (m > 0) {
      this.intervalId = window.setInterval(
        () => this.runSync(true),
        m * 60_000
      );
      this.registerInterval(this.intervalId);
    }
  }

  async runSync(silent = false, opts: { pull?: boolean } = {}): Promise<void> {
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

  /** state.json 경로(플러그인 폴더 내). 설정(data.json)과 분리 — 기기-로컬, Sync 대상 아님. */
  private stateFilePath(): string {
    return normalizePath(`${this.manifest.dir}/state.json`);
  }

  private async loadState(): Promise<StateFile | null> {
    const path = this.stateFilePath();
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      return JSON.parse(await this.app.vault.adapter.read(path)) as StateFile;
    } catch (e) {
      console.error("[tasks-gcal-sync] state.json 로드 실패:", e);
      return null;
    }
  }

  private async loadAll(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };

    // records/syncTokens/자격증명은 기기-로컬 state.json이 진실원천.
    // 마이그레이션 2경로:
    //  (a) state.json 없음        → data.json 내장 state에서 1회 이관.
    //  (b) state.json에 자격증명 없음(구 state.json) + data.json엔 있음
    //                             → 자격증명을 state.json으로 옮기고 data.json에서 제거.
    let migrate = false;
    const sf = await this.loadState();
    if (sf) {
      this.state = { records: sf.records ?? {}, syncTokens: sf.syncTokens ?? {} };
      // state.json에 자격증명이 있으면 그게 기기-로컬 진실원천 → 설정에 덮어씀.
      if (typeof sf.clientId === "string") this.settings.clientId = sf.clientId;
      if (typeof sf.clientSecret === "string")
        this.settings.clientSecret = sf.clientSecret;
      if (sf.refreshToken !== undefined)
        this.settings.refreshToken = sf.refreshToken;
      const credsInState =
        typeof sf.clientId === "string" ||
        typeof sf.clientSecret === "string" ||
        sf.refreshToken !== undefined;
      const credsInSettings = !!(
        this.settings.clientId ||
        this.settings.clientSecret ||
        this.settings.refreshToken
      );
      if (!credsInState && credsInSettings) migrate = true; // (b)
    } else {
      this.state = data?.state ?? emptyState(); // (a)
      migrate = true;
    }
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
      await this.saveState(); // state.json 생성/갱신(records/tokens/자격증명)
      await this.saveSettings(); // data.json을 settings(비밀 제외)만으로 재기록
    }
  }

  /** 설정만 data.json에 저장 — 자격증명(clientId·clientSecret·refreshToken)은 제외해 Sync로 새어나가지 않게 한다. */
  async saveSettings(): Promise<void> {
    const safe: Partial<PluginSettings> = { ...this.settings };
    delete safe.clientId;
    delete safe.clientSecret;
    delete safe.refreshToken;
    await this.saveData({ settings: safe as PluginSettings });
  }

  /** sync 상태(records/syncTokens) + 자격증명을 기기-로컬 state.json에 저장. sync 루프는 이것만 호출(data.json 안 건드림). */
  async saveState(): Promise<void> {
    const sf: StateFile = {
      records: this.state.records,
      syncTokens: this.state.syncTokens,
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      refreshToken: this.settings.refreshToken,
    };
    await this.app.vault.adapter.write(
      this.stateFilePath(),
      JSON.stringify(sf, null, 2)
    );
  }

  /** 설정 UI 저장용: 설정(data.json) + 자격증명/state(state.json) 둘 다 기록. */
  async saveAll(): Promise<void> {
    await this.saveSettings();
    await this.saveState();
  }
}
