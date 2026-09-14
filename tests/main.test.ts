/**
 * main.ts(TasksGcalSyncPlugin) 특성화 테스트 — 0.12.0 "안전망".
 *
 * 동작을 바꾸지 않는 리팩터링 전에 **지금 동작을 그대로** 고정한다. 기대값이 이상해 보여도
 * 코드가 실제로 그렇게 하면 그 값을 적는다(의심스러운 곳은 "ODDITY" 주석).
 *
 * 고정하는 것:
 *  - loadAll: 자격증명 우선순위(localStorage > state.json > data.json) · 이관 순서 · 옛 키 제거
 *  - saveSettings/saveState 가 쓰는 모양
 *  - onload 배선: 리본·명령 id·**어느 진입점이 manual:true 를 넘기는가** · 자동 트리거 인자
 *  - runSync: 재진입 · 인증 없음 · 후속 예약 · 피드 갱신 · 로그 · 상태바 · finally
 *  - 쿨다운/주기 · 종료 직전 플러시(5초 상한) · 리포트 문자열 · 기기 태그/로그 경로
 *
 * 스텁 우회: tests/obsidian-stub.ts 의 addStatusBarItem 은 `setAttr` 만 있고 main.ts 가
 * 부르는 `setAttribute` 가 없다 → 인스턴스에서 addStatusBarItem 을 덮어 보강한다.
 */
import TasksGcalSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings/Settings";
import { SyncResult } from "../src/sync/SyncEngine";
import { Plugin, TFile, noticeLog } from "./obsidian-stub";
import { eq, ok, done } from "./helpers/assert";
import { FIXED_NOW, advanceClock, installFakeEnv, resetClock } from "./helpers/fakeEnv";

installFakeEnv();

// ───────────────────────────── 콘솔 캡처 ─────────────────────────────
const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
const consoleLines: string[] = [];
const fmt = (a: unknown[]) =>
  a.map((x) => (x instanceof Error ? `Error(${x.message})` : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
console.log = (...a: unknown[]) => void consoleLines.push(fmt(a));
console.warn = (...a: unknown[]) => void consoleLines.push(fmt(a));
console.error = (...a: unknown[]) => {
  const s = fmt(a);
  if (s.startsWith("✗")) realError(...a); // 단언 실패는 그대로 보여 준다
  else consoleLines.push(s);
};

// ───────────────────────────── 가짜 타이머(window) ─────────────────────────────
interface FakeTimer {
  id: number;
  kind: "timeout" | "interval";
  delay: number;
  cb: () => void;
}
const timers = new Map<number, FakeTimer>();
let nextTimerId = 1;
const fakeWindow = {
  setTimeout(cb: () => void, delay = 0): number {
    const id = nextTimerId++;
    timers.set(id, { id, kind: "timeout", delay, cb });
    return id;
  },
  setInterval(cb: () => void, delay = 0): number {
    const id = nextTimerId++;
    timers.set(id, { id, kind: "interval", delay, cb });
    return id;
  },
  clearTimeout(id: number): void {
    timers.delete(id);
  },
  clearInterval(id: number): void {
    timers.delete(id);
  },
};
(globalThis as any).window = fakeWindow;

const pending = (kind?: "timeout" | "interval"): FakeTimer[] =>
  [...timers.values()].filter((t) => !kind || t.kind === kind);
const shape = (kind?: "timeout" | "interval") =>
  pending(kind).map((t) => `${t.kind}:${t.delay}`);
function fire(t: FakeTimer | undefined): void {
  if (!t) throw new Error("fire: 타이머 없음");
  if (t.kind === "timeout") timers.delete(t.id);
  t.cb();
}
const tick = () => new Promise<void>((r) => setImmediate(r));

// ───────────────────────────── 하네스 ─────────────────────────────
const LS_KEY = "tasks-gcal-sync:state";
const PLUGIN_DIR = ".obsidian/plugins/tasks-gcal-sync";
const STATE_JSON = `${PLUGIN_DIR}/state.json`;
const MANIFEST = { id: "tasks-gcal-sync", version: "0.12.0-test", dir: PLUGIN_DIR };

interface HarnessOpts {
  data?: any;
  /** localStorage 값(문자열이면 그대로, 객체면 그대로 — 로더가 둘 다 받는다) */
  local?: any;
  /** state.json 원문 */
  legacy?: string;
  /** Obsidian Sync 기기 이름. undefined = internalPlugins 없음 */
  deviceName?: unknown;
  /** adapter.exists 가 true 를 돌려줄 추가 경로 */
  existing?: string[];
  /** vault 인덱스에 있는 TFile 경로 */
  indexed?: string[];
}

interface Harness {
  plugin: any;
  app: any;
  ls: Map<string, any>;
  files: Map<string, string>;
  calls: string[];
  vaultOn: Record<string, (...a: any[]) => any>;
  wsOn: Record<string, (...a: any[]) => any>;
  layoutReady: (() => void)[];
  opened: any[];
}

function makeHarness(o: HarnessOpts = {}): Harness {
  const ls = new Map<string, any>();
  if (o.local !== undefined) ls.set(LS_KEY, o.local);
  const files = new Map<string, string>();
  if (o.legacy !== undefined) files.set(STATE_JSON, o.legacy);
  for (const p of o.existing ?? []) files.set(p, "");
  const calls: string[] = [];
  const vaultOn: Record<string, (...a: any[]) => any> = {};
  const wsOn: Record<string, (...a: any[]) => any> = {};
  const layoutReady: (() => void)[] = [];
  const opened: any[] = [];
  const indexed = new Set(o.indexed ?? []);
  const app: any = {
    vault: {
      getName: () => "TestVault",
      on(name: string, cb: (...a: any[]) => any) {
        vaultOn[name] = cb;
        return { src: "vault", name };
      },
      getAbstractFileByPath(p: string) {
        if (!indexed.has(p)) return null;
        const f = new TFile();
        f.path = p;
        return f;
      },
      getMarkdownFiles: () => [],
      adapter: {
        exists: async (p: string) => files.has(p),
        read: async (p: string) => {
          if (!files.has(p)) throw new Error("ENOENT " + p);
          return files.get(p)!;
        },
        remove: async (p: string) => {
          calls.push("remove:" + p);
          files.delete(p);
        },
      },
    },
    workspace: {
      on(name: string, cb: (...a: any[]) => any) {
        wsOn[name] = cb;
        return { src: "workspace", name };
      },
      onLayoutReady(cb: () => void) {
        layoutReady.push(cb);
      },
      getLeaf(newLeaf: boolean) {
        return { openFile: async (f: any) => void opened.push([newLeaf, f.path]) };
      },
    },
    metadataCache: { on: () => ({}), getFileCache: () => null },
    loadLocalStorage: (k: string) => (ls.has(k) ? ls.get(k) : null),
    saveLocalStorage: (k: string, v: any) => {
      calls.push("saveLocalStorage");
      ls.set(k, v);
    },
  };
  if (o.deviceName !== undefined) {
    app.internalPlugins = { plugins: { sync: { instance: { deviceName: o.deviceName } } } };
  }

  const plugin: any = new TasksGcalSyncPlugin(app, MANIFEST as any);
  plugin.__data = o.data ?? null;
  const origSaveData = plugin.saveData.bind(plugin);
  plugin.saveData = async (d: any) => {
    calls.push("saveData");
    await origSaveData(d);
  };
  // 스텁 우회: setAttribute 가 없다
  plugin.addStatusBarItem = () => {
    const item: any = Plugin.prototype.addStatusBarItem.call(plugin);
    item.attrs = {};
    item.setAttribute = (k: string, v: string) => void (item.attrs[k] = v);
    return item;
  };
  return { plugin, app, ls, files, calls, vaultOn, wsOn, layoutReady, opened };
}

function reset(): void {
  timers.clear();
  noticeLog.length = 0;
  consoleLines.length = 0;
  resetClock();
}

const result = (p: Partial<SyncResult> = {}): SyncResult => ({
  created: 0,
  updated: 0,
  moved: 0,
  deleted: 0,
  pulled: 0,
  skipped: 0,
  skips: {},
  failures: [],
  entries: [],
  ...p,
});

/** 인증 + 기기 태그가 이미 있는 평범한 기기(이관 없음). */
const AUTHED_LOCAL = () =>
  JSON.stringify({ records: {}, syncTokens: {}, refreshToken: "tok", logDeviceTag: "PC1" });
const LOG_PC1 = "Logs/GCal 동기화 로그 (PC1).md";

interface Stubs {
  engineCalls: any[];
  appendCalls: any[];
  feedCalls: any[];
  flushCount: () => number;
  setRun: (fn: (o: any) => Promise<SyncResult>) => void;
  setAuthed: (v: boolean) => void;
}
function stubDeps(plugin: any): Stubs {
  const engineCalls: any[] = [];
  const appendCalls: any[] = [];
  const feedCalls: any[] = [];
  let flushes = 0;
  let authed = true;
  let runImpl: (o: any) => Promise<SyncResult> = async () => result();
  plugin.engine = {
    run: (o: any) => {
      engineCalls.push(o);
      return runImpl(o);
    },
  };
  plugin.feed = {
    lastError: null,
    refreshAll: async () => void feedCalls.push("refreshAll"),
    refreshTracked: async (o: any) => void feedCalls.push(["refreshTracked", o]),
    unload: () => void feedCalls.push("unload"),
  };
  plugin.log = {
    append: async (s: string, e: any[], t: string) => void appendCalls.push([s, e, t]),
    flush: async () => void flushes++,
  };
  plugin.auth = { isAuthenticated: () => authed };
  return {
    engineCalls,
    appendCalls,
    feedCalls,
    flushCount: () => flushes,
    setRun: (fn) => (runImpl = fn),
    setAuthed: (v) => (authed = v),
  };
}

function spyRunSync(plugin: any): any[][] {
  const runCalls: any[][] = [];
  plugin.runSync = (...a: any[]) => {
    runCalls.push(a);
    return Promise.resolve();
  };
  return runCalls;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mdFile = (path: string, ext = "md") => {
  const f = new TFile();
  f.path = path;
  f.extension = ext;
  return f;
};

// ════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // ───────────── loadAll: 자격증명 우선순위 + 이관 순서 ─────────────
  {
    reset();
    const h = makeHarness({
      data: {
        settings: {
          clientId: "D-id",
          clientSecret: "D-sec",
          refreshToken: "D-tok",
          defaultCalendarId: "cal-D",
        },
        state: { records: { dataRec: { eventId: "eX", calendarId: "c" } }, syncTokens: {} },
      },
      local: JSON.stringify({
        records: { r1: { eventId: "e1", calendarId: "", due: "2026-08-01", done: false, title: "t" } },
        syncTokens: { c: "stok" },
        lastFullScanAt: 111,
        clientId: "L-id",
        clientSecret: "",
        logDeviceTag: "Dev",
      }),
      legacy: JSON.stringify({ clientId: "S-id", clientSecret: "S-sec", refreshToken: "S-tok" }),
    });
    await h.plugin.loadAll();
    const s = h.plugin.settings;
    eq(s.clientId, "L-id", "clientId: localStorage 가 이긴다");
    eq(s.clientSecret, "S-sec", "clientSecret: local 이 빈 문자열이면 state.json 으로 넘어간다(firstStr)");
    eq(s.refreshToken, "S-tok", "refreshToken: local 에 키가 없으면(undefined) state.json");
    eq(
      h.plugin.state,
      {
        records: { r1: { eventId: "e1", calendarId: "cal-D", due: "2026-08-01", done: false, title: "t" } },
        syncTokens: { c: "stok" },
        lastFullScanAt: 111,
        logDeviceTag: "Dev",
      },
      "state 는 local 에서 — data.json 내장 state 는 무시, calendarId 빈 record 는 기본 캘린더로 채움"
    );
    eq(h.calls, ["saveLocalStorage", "saveData", "remove:" + STATE_JSON], "이관 순서: 로컬 저장 → data.json → state.json 삭제");
    eq(h.files.has(STATE_JSON), false, "state.json 삭제됨");
    eq(
      h.ls.get(LS_KEY),
      JSON.stringify({
        records: { r1: { eventId: "e1", calendarId: "cal-D", due: "2026-08-01", done: false, title: "t" } },
        syncTokens: { c: "stok" },
        lastFullScanAt: 111,
        clientId: "L-id",
        clientSecret: "S-sec",
        refreshToken: "S-tok",
        logDeviceTag: "Dev",
      }),
      "localStorage 에 StateFile 모양으로 정규화해 다시 적는다"
    );
    const saved = h.plugin.__data;
    eq(Object.keys(saved), ["settings"], "data.json 에는 settings 만(내장 state 제거)");
    eq(
      ["clientId", "clientSecret", "refreshToken"].map((k) => k in saved.settings),
      [false, false, false],
      "data.json 에서 비밀 3종 제거"
    );
    eq(saved.settings.defaultCalendarId, "cal-D", "나머지 설정은 그대로");
    ok(consoleLines.includes("[tasks-gcal-sync] 구 state.json 이관 완료 → 삭제"), "삭제 로그");
  }

  {
    reset();
    const h = makeHarness({
      local: JSON.stringify({ records: {}, syncTokens: {}, refreshToken: null }),
      legacy: JSON.stringify({ refreshToken: "S-tok" }),
      data: { settings: { refreshToken: "D-tok" } },
    });
    await h.plugin.loadAll();
    // ODDITY(main.ts:731-736): firstDef 는 undefined 만 건너뛴다 — local 의 null 이 옛 토큰을 이긴다.
    eq(h.plugin.settings.refreshToken, null, "refreshToken: local 의 null 이 state.json 토큰을 이긴다");
  }

  {
    reset();
    // local 없음 · legacy 없음 → data.json(가장 낮은 우선순위)
    const h = makeHarness({
      data: {
        settings: { clientId: "D-id", clientSecret: "D-sec", refreshToken: "D-tok" },
        state: { records: { a: { eventId: "ea" } }, syncTokens: { x: "1" }, lastFullScanAt: 5 },
      },
    });
    await h.plugin.loadAll();
    eq(
      [h.plugin.settings.clientId, h.plugin.settings.clientSecret, h.plugin.settings.refreshToken],
      ["D-id", "D-sec", "D-tok"],
      "local·legacy 없으면 data.json 자격증명"
    );
    eq(
      h.plugin.state,
      { records: { a: { eventId: "ea", calendarId: "" } }, syncTokens: { x: "1" }, lastFullScanAt: 5 },
      "아주 옛 버전: data.json 내장 state 사용(기본 캘린더가 없으면 calendarId 는 \"\")"
    );
    eq(h.calls, ["saveLocalStorage", "saveData"], "local 이 비었으면 이관(삭제 없음)");
    eq(Object.keys(h.plugin.__data), ["settings"], "재기록된 data.json 은 state 없음");
  }

  {
    reset();
    const h = makeHarness(); // data.json 없음
    await h.plugin.loadAll();
    eq(
      h.ls.get(LS_KEY),
      '{"records":{},"syncTokens":{},"clientId":"","clientSecret":"","refreshToken":null}',
      "새 설치: 빈 StateFile(undefined 키는 JSON 에서 빠짐)"
    );
    eq(h.calls, ["saveLocalStorage", "saveData"], "새 설치도 이관 경로");
    const expected: any = { ...DEFAULT_SETTINGS };
    delete expected.clientId;
    delete expected.clientSecret;
    delete expected.refreshToken;
    eq(h.plugin.__data, { settings: expected }, "새 설치 data.json = 기본 설정 - 비밀");
    // ODDITY(main.ts:702): 얕은 복사 — 배열 설정이 DEFAULT_SETTINGS 와 같은 참조다.
    ok(h.plugin.settings.rules === DEFAULT_SETTINGS.rules, "settings.rules 는 DEFAULT_SETTINGS.rules 와 같은 참조(얕은 복사)");
    ok(h.plugin.settings.feedCalendars === DEFAULT_SETTINGS.feedCalendars, "feedCalendars 도 같은 참조");
  }

  {
    reset();
    // local 있음 · legacy 없음 → 저장 없음. local 이 빈 clientId 면 data.json 으로 떨어진다.
    const h = makeHarness({
      local: JSON.stringify({ records: {}, syncTokens: {}, clientId: "", clientSecret: "L-sec", refreshToken: "L-tok" }),
      data: { settings: { clientId: "D-id", clientSecret: "D-sec", refreshToken: "D-tok" } },
    });
    await h.plugin.loadAll();
    eq(h.calls, [], "local 만 있으면 아무것도 다시 쓰지 않는다");
    eq(
      [h.plugin.settings.clientId, h.plugin.settings.clientSecret, h.plugin.settings.refreshToken],
      ["D-id", "L-sec", "L-tok"],
      "빈 local clientId → data.json 값"
    );
  }

  {
    reset();
    // loadLocalStorage 가 객체를 돌려줘도 받는다 · records/syncTokens 없으면 {}
    const h = makeHarness({ local: { clientId: "obj-id", refreshToken: "t" } });
    await h.plugin.loadAll();
    eq(h.plugin.settings.clientId, "obj-id", "객체 local 도 파싱 없이 사용");
    eq(h.plugin.state, { records: {}, syncTokens: {} }, "records/syncTokens 기본 {} (lastFullScanAt·logDeviceTag 는 undefined)");
    eq(Object.keys(h.plugin.state), ["records", "syncTokens", "lastFullScanAt", "logDeviceTag"], "state 키 순서(undefined 키 포함)");
    eq(h.calls, [], "객체 local 도 local 로 간주(이관 없음)");
  }

  {
    reset();
    const h = makeHarness({ local: "{bad json", data: { settings: { clientId: "D-id" } } });
    await h.plugin.loadAll();
    eq(h.plugin.settings.clientId, "D-id", "깨진 local JSON → 없는 것으로 취급");
    eq(h.calls, ["saveLocalStorage", "saveData"], "깨진 local → 정규화해 다시 적는다");
    ok(consoleLines.some((l) => l.startsWith("[tasks-gcal-sync] 로컬 state 로드 실패:")), "로드 실패 로그");
    reset();
    const h2 = makeHarness({ local: "" });
    await h2.plugin.loadAll();
    eq(h2.calls, ["saveLocalStorage", "saveData"], "빈 문자열 local → 없음");
  }

  {
    reset();
    // 깨진 state.json: null 로 읽고 **지우지 않는다**
    const h = makeHarness({ local: AUTHED_LOCAL(), legacy: "{not json" });
    await h.plugin.loadAll();
    eq(h.calls, [], "깨진 state.json → legacy 없음 취급, 이관·삭제 없음");
    // ODDITY(main.ts:676-685,758): 파싱 못 한 state.json 은 영영 남는다.
    eq(h.files.has(STATE_JSON), true, "깨진 state.json 은 삭제되지 않고 남는다");
    ok(consoleLines.some((l) => l.startsWith("[tasks-gcal-sync] state.json 로드 실패:")), "state.json 로드 실패 로그");
  }

  {
    reset();
    // local 없음 + legacy 있음: state 는 data.json/빈 state — legacy 의 records 는 쓰지 않는다
    const h = makeHarness({
      legacy: JSON.stringify({ records: { z: { eventId: "ez" } }, syncTokens: { q: "1" }, clientId: "S-id" }),
    });
    await h.plugin.loadAll();
    eq(h.plugin.state, { records: {}, syncTokens: {} }, "legacy 의 캐시(records/syncTokens)는 이관하지 않는다");
    eq(h.plugin.settings.clientId, "S-id", "legacy 자격증명은 회수");
    eq(h.calls, ["saveLocalStorage", "saveData", "remove:" + STATE_JSON], "순서");
  }

  {
    reset();
    // 로컬 저장이 실패하면 state.json 을 지우지 않는다(자격증명 유실 방지)
    const h = makeHarness({ legacy: JSON.stringify({ clientId: "S-id" }) });
    h.app.saveLocalStorage = () => {
      h.calls.push("saveLocalStorage!throw");
      throw new Error("quota");
    };
    let threw = "";
    try {
      await h.plugin.loadAll();
    } catch (e: any) {
      threw = e.message;
    }
    eq(threw, "quota", "로컬 저장 예외는 loadAll 밖으로 전파");
    eq(h.calls, ["saveLocalStorage!throw"], "data.json 저장·state.json 삭제 모두 안 함");
    eq(h.files.has(STATE_JSON), true, "state.json 보존");
  }

  {
    reset();
    // 옛 설정 키 제거 · targetCalendarId 이관 · 피드 폴백 색
    const dead = {
      doneOnFree: true,
      skipPullOnEdit: true,
      syncOnBlur: true,
      syncOnFocus: true,
      syncOnWindowSwitch: true,
      syncPreset: "fast",
      pushOnly: true,
      routingTagPrefix: "#cal/",
      doneTag: "#done",
    };
    const h = makeHarness({
      data: {
        settings: {
          ...dead,
          targetCalendarId: "old-cal",
          targetCalendarName: "Old",
          feedCalendars: [
            { id: "a", name: "A", color: "#7f8c8d" },
            { id: "b", name: "B", color: "#123456" },
          ],
        },
        state: { records: { r: { eventId: "e" }, r2: { eventId: "e2", calendarId: "keep" } }, syncTokens: {} },
      },
    });
    await h.plugin.loadAll();
    const s = h.plugin.settings;
    eq(Object.keys(dead).filter((k) => k in s), [], "옛 설정 키 9종 제거(메모리)");
    eq(Object.keys(dead).filter((k) => k in h.plugin.__data.settings), [], "옛 설정 키 9종 제거(data.json)");
    eq([s.defaultCalendarId, s.defaultCalendarName], ["old-cal", "Old"], "targetCalendarId → defaultCalendarId");
    eq(s.targetCalendarId, "old-cal", "targetCalendarId 자체는 남는다(지우지 않음)");
    eq(h.plugin.__data.settings.targetCalendarName, "Old", "data.json 에도 target* 남음");
    eq(
      [h.plugin.state.records.r.calendarId, h.plugin.state.records.r2.calendarId],
      ["old-cal", "keep"],
      "calendarId 없는 record 만 (이관된) 기본 캘린더로"
    );
    eq(s.feedCalendars.map((f: any) => f.color), ["", "#123456"], "폴백 회색 → \"\"");

    reset();
    const h2 = makeHarness({ data: { settings: { targetCalendarId: "old" } } });
    await h2.plugin.loadAll();
    eq(h2.plugin.settings.defaultCalendarName, "", "targetCalendarName 없으면 \"\"");
    reset();
    const h3 = makeHarness({ data: { settings: { targetCalendarId: "old", defaultCalendarId: "new", defaultCalendarName: "N" } } });
    await h3.plugin.loadAll();
    eq([h3.plugin.settings.defaultCalendarId, h3.plugin.settings.defaultCalendarName], ["new", "N"], "기본 캘린더가 있으면 이관 안 함");
  }

  // ───────────── saveSettings / saveState / saveAll ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.loadAll();
    h.plugin.settings.clientId = "cid";
    h.plugin.settings.clientSecret = "csec";
    h.plugin.settings.refreshToken = "rt";
    h.plugin.settings.globalFilter = "#todo";
    await h.plugin.saveSettings();
    const safe: any = { ...h.plugin.settings };
    delete safe.clientId;
    delete safe.clientSecret;
    delete safe.refreshToken;
    eq(h.plugin.__data, { settings: safe }, "saveSettings: 비밀 3종만 뺀 settings");
    eq(h.plugin.settings.clientId, "cid", "saveSettings 는 메모리 settings 를 건드리지 않는다");

    h.plugin.state.lastFullScanAt = 42;
    h.plugin.state.records = { k: { eventId: "e" } };
    h.plugin.state.syncTokens = { c: "t" };
    await h.plugin.saveState();
    eq(
      h.ls.get(LS_KEY),
      '{"records":{"k":{"eventId":"e"}},"syncTokens":{"c":"t"},"lastFullScanAt":42,"clientId":"cid","clientSecret":"csec","refreshToken":"rt","logDeviceTag":"PC1"}',
      "saveState: StateFile 모양 · 키 순서"
    );

    h.calls.length = 0;
    await h.plugin.saveAll();
    eq(h.calls, ["saveData", "saveLocalStorage"], "saveAll: data.json → localStorage 순서");
  }

  // ───────────── onload 배선 ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    await tick();
    const p = h.plugin;
    ok(consoleLines.includes("[tasks-gcal-sync] v0.12.0-test 로드 (TestVault)"), "버전 로그");
    eq(h.calls, [], "태그·자격증명 있는 기기: onload 가 아무것도 저장하지 않는다");
    eq(p.__ribbon.map((r: any) => [r.icon, r.title]), [["calendar-clock", "Tasks → Google Calendar 동기화"]], "리본 1개");
    eq(
      p.__commands.map((c: any) => [c.id, c.name]),
      [
        ["sync-now", "지금 동기화 (Tasks → Google Calendar)"],
        ["backfill-ids", "기존 이벤트 설명에 🆔 백필"],
        ["sync-report", "동기화 리포트 (마지막 결과 · 건너뛴 이유 · 실패)"],
        ["rebuild-records", "캘린더 전수 스캔 (매핑 재구성 · 고아 이벤트 회수)"],
        ["cleanup-duplicates", "중복 이벤트 정리 (같은 task의 GCal 중복 삭제)"],
        ["open-sync-log", "동기화 로그 열기 (건별 상세 기록)"],
        ["refresh-events", "캘린더 뷰 일정 새로 고침"],
      ],
      "명령 id·이름·순서"
    );
    eq(p.__settingTabs.length, 1, "설정 탭 1개");
    eq(p.statusBar.text, "GCal —", "초기 상태바");
    eq(p.__events.map((e: any) => `${e.src}:${e.name}`), ["vault:modify", "workspace:quit"], "등록 이벤트");
    ok(p.api === p.feed, "api 는 feed 그 자체");
    eq(h.layoutReady.length, 1, "onLayoutReady 콜백 1개");
    eq(shape(), [], "레이아웃 준비 전에는 타이머 없음");

    // ★ 진입점별 runSync 인자
    const runCalls = spyRunSync(p);
    const other: string[] = [];
    p.backfillIds = () => void other.push("backfillIds");
    p.showReport = () => void other.push("showReport");
    p.cleanupDuplicates = () => void other.push("cleanupDuplicates");
    p.openSyncLog = () => void other.push("openSyncLog");
    const cmd = (id: string) => p.__commands.find((c: any) => c.id === id);

    p.__ribbon[0].cb();
    eq(runCalls.pop(), [false, { force: true, manual: true, trigger: "수동(리본)" }], "리본 → manual:true");
    cmd("sync-now").callback();
    eq(runCalls.pop(), [false, { force: true, manual: true, trigger: "수동(명령)" }], "sync-now → manual:true");
    cmd("rebuild-records").callback();
    eq(
      runCalls.pop(),
      [false, { fullScan: true, force: true, manual: true, trigger: "수동(전수 스캔)" }],
      "rebuild-records → fullScan + manual:true"
    );
    for (const id of ["backfill-ids", "sync-report", "cleanup-duplicates", "open-sync-log"]) cmd(id).callback();
    eq(other, ["backfillIds", "showReport", "cleanupDuplicates", "openSyncLog"], "나머지 명령의 대상 메서드");
    eq(runCalls.length, 0, "나머지 명령은 runSync 를 부르지 않는다");

    const s = stubDeps(p);
    p.runSync = (...a: any[]) => (runCalls.push(a), Promise.resolve());
    cmd("refresh-events").callback();
    await tick();
    eq(s.feedCalls, ["refreshAll"], "refresh-events → feed.refreshAll");
    eq(noticeLog, ["캘린더 뷰 일정을 다시 받아왔습니다."], "refresh-events 성공 Notice");
    p.feed.lastError = "403 forbidden";
    noticeLog.length = 0;
    cmd("refresh-events").callback();
    await tick();
    eq(noticeLog, ["일정 조회 실패 — 403 forbidden"], "refresh-events 실패 Notice");
    eq(runCalls.length, 0, "refresh-events 는 runSync 를 부르지 않는다");
  }

  // ───────────── 자동 트리거: 시작 · 주기 · 피드 주기 ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const s = stubDeps(p);
    const runCalls = spyRunSync(p);
    h.layoutReady[0]();
    eq(shape(), ["interval:300000", "interval:900000", "timeout:3000"], "레이아웃 준비: 동기화 주기 5분 · 피드 15분 · 시작 3초");
    eq(p.__intervals, pending("interval").map((t) => t.id), "두 주기 모두 registerInterval");
    eq(runCalls.length, 0, "시작 run 은 3초 뒤");
    fire(pending("timeout")[0]);
    eq(runCalls.pop(), [true, { trigger: "시작 시" }], "시작 run 인자(manual 없음)");

    const syncTick = pending("interval").find((t) => t.delay === 300000)!;
    fire(syncTick);
    eq(runCalls.pop(), [true, { trigger: "주기(5분)" }], "주기 run 인자(lastSyncAt=0 → 쿨다운 없음)");
    p.lastSyncAt = Date.now();
    fire(syncTick);
    eq(runCalls.length, 0, "쿨다운(60초) 중 주기 틱은 건너뜀");
    advanceClock(59_999);
    fire(syncTick);
    eq(runCalls.length, 0, "59.999초 — 여전히 건너뜀");
    advanceClock(1);
    fire(syncTick);
    eq(runCalls.pop(), [true, { trigger: "주기(5분)" }], "정확히 60초 → 실행");

    fire(pending("interval").find((t) => t.delay === 900000));
    eq(s.feedCalls, [["refreshTracked", { force: true }]], "피드 주기 → refreshTracked({force:true})");
    eq(runCalls.length, 0, "피드 주기는 runSync 를 부르지 않는다");

    // onunload: 모든 타이머 해제 + feed.unload + log.flush
    h.vaultOn.modify(mdFile("n.md")); // autoPush 타이머
    p.scheduleFollowUp(1000);
    eq(pending().length, 4, "unload 전: 주기2 + autoPush + 후속");
    p.onunload();
    eq(shape(), [], "onunload 가 네 타이머 모두 해제");
    eq(s.feedCalls.slice(-1), ["unload"], "feed.unload");
    await tick();
    eq(s.flushCount(), 1, "log.flush");
  }

  {
    reset();
    const h = makeHarness({ local: JSON.stringify({ records: {}, syncTokens: {}, refreshToken: "tok", logDeviceTag: "PC1" }) });
    await h.plugin.onload();
    h.plugin.settings.syncOnStartup = false;
    h.layoutReady[0]();
    eq(shape(), ["interval:300000", "interval:900000"], "syncOnStartup=false → 시작 타이머 없음");

    reset();
    const h2 = makeHarness({ local: JSON.stringify({ records: {}, syncTokens: {}, logDeviceTag: "PC1" }) });
    await h2.plugin.onload();
    h2.layoutReady[0]();
    eq(shape(), ["interval:300000", "interval:900000"], "미인증 → 시작 타이머 없음(주기는 등록)");
  }

  // ───────────── setupInterval / setupFeedInterval / cooldownRemaining ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const runCalls = spyRunSync(p);
    p.setupInterval();
    const first = pending("interval")[0];
    p.settings.syncIntervalMinutes = 2;
    p.setupInterval();
    eq(shape(), ["interval:120000"], "재설정은 이전 주기를 지우고 새로 건다");
    ok(!timers.has(first.id), "이전 id 해제");
    eq(p.__intervals.length, 2, "registerInterval 은 매번 호출(옛 id 도 목록에 남음)");
    p.settings.syncIntervalMinutes = 7; // 이미 건 주기의 트리거 문구는 설정 시점 값
    fire(pending("interval")[0]);
    eq(runCalls.pop(), [true, { trigger: "주기(2분)" }], "트리거 문구는 setupInterval 시점의 m");
    p.settings.syncIntervalMinutes = 0;
    p.setupInterval();
    eq(shape(), [], "syncIntervalMinutes=0 → 주기 없음(기존 해제)");

    p.setupFeedInterval();
    eq(shape(), ["interval:900000"], "feedRefreshMinutes 15 → 15분");
    p.settings.feedRefreshMinutes = 0;
    p.setupFeedInterval();
    eq(shape(), [], "feedRefreshMinutes=0 → 피드 주기 없음(기존 해제)");

    p.lastSyncAt = 0;
    eq(p.cooldownRemaining(), 0, "lastSyncAt=0 → 0");
    p.lastSyncAt = Date.now();
    eq(p.cooldownRemaining(), 60_000, "방금 완료 → 60000");
    p.lastSyncAt = Date.now() - 10_000;
    eq(p.cooldownRemaining(), 50_000, "10초 전 완료 → 50000");
    p.settings.minSyncIntervalSeconds = -5;
    eq(p.cooldownRemaining(), 0, "음수 최소 간격 → 0");
    p.settings.minSyncIntervalSeconds = 0;
    eq(p.cooldownRemaining(), 0, "0 → 0");
  }

  // ───────────── vault modify 필터 → scheduleAutoPush ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const modify = h.vaultOn.modify;
    const wrote: any[] = [];
    let recent = false;
    p.writer.wroteRecently = (path: string, ms: number) => (wrote.push([path, ms]), recent);

    modify({ path: "x.md", extension: "md" });
    eq(shape(), [], "TFile 이 아니면 무시");
    modify(mdFile("x.canvas", "canvas"));
    eq(shape(), [], "md 가 아니면 무시");
    modify(mdFile(LOG_PC1));
    eq(shape(), [], "이 기기 로그 파일은 무시");
    eq(wrote, [], "위 셋은 wroteRecently 까지 가지 않는다");
    recent = true;
    modify(mdFile("notes/a.md"));
    eq(wrote, [["notes/a.md", 10000]], "wroteRecently(path, 10000)");
    eq(shape(), [], "방금 우리가 쓴 파일은 무시");
    recent = false;
    // 기기 태그 없는 옛 공용 로그 경로는 걸러지지 않는다
    modify(mdFile("Logs/GCal 동기화 로그.md"));
    eq(shape(), ["timeout:3000"], "옛 공용 로그 경로는 편집으로 취급(디바운스 3000ms)");
    const t1 = pending("timeout")[0];
    modify(mdFile("notes/b.md"));
    eq(shape(), ["timeout:3000"], "연속 편집 → 타이머 하나만");
    ok(!timers.has(t1.id), "이전 디바운스 타이머 해제");
    const runCalls = spyRunSync(p);
    fire(pending("timeout")[0]);
    eq(runCalls.pop(), [true, { trigger: "편집 자동" }], "편집 자동 run 인자(manual 없음)");
    eq(p.autoPushTimer, null, "발화 후 autoPushTimer=null");

    p.settings.autoPushDebounceSeconds = 1.5;
    modify(mdFile("notes/c.md"));
    eq(shape(), ["timeout:1500"], "디바운스 = 초*1000");
    timers.clear();
    p.autoPushTimer = null;
    p.settings.autoPushDebounceSeconds = -3;
    p.scheduleAutoPush();
    eq(shape(), ["timeout:0"], "음수 디바운스 → 0");
    timers.clear();
    p.autoPushTimer = null;

    p.settings.autoPushOnEdit = false;
    modify(mdFile("notes/d.md"));
    eq(shape(), [], "autoPushOnEdit=false → 아무것도 안 함");
    p.settings.autoPushOnEdit = true;
    p.settings.refreshToken = null;
    modify(mdFile("notes/e.md"));
    eq(shape(), [], "미인증 → 아무것도 안 함");
  }

  // ───────────── 종료 직전 플러시 ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const s = stubDeps(p);
    const quit = h.wsOn.quit;

    const added: (() => any)[] = [];
    const tasks = { add: (fn: () => any) => void added.push(fn) };
    quit(tasks);
    eq(added.length, 1, "밀린 편집 없음 → 로그 플러시 태스크만");
    await added[0]();
    eq(s.flushCount(), 1, "첫 태스크 = log.flush");

    p.scheduleAutoPush();
    eq(shape(), ["timeout:3000"], "밀린 편집 1건");
    const hang = deferred<void>();
    const runCalls: any[][] = [];
    p.runSync = (...a: any[]) => (runCalls.push(a), hang.promise);
    added.length = 0;
    quit(tasks);
    eq(added.length, 2, "밀린 편집 있음 → 플러시 + run");
    eq(shape(), [], "디바운스 타이머는 해제");
    eq(p.autoPushTimer, null, "autoPushTimer=null");
    eq(runCalls.length, 0, "run 은 태스크가 실행될 때 시작");
    let settled = false;
    const raced = Promise.resolve(added[1]()).then(() => (settled = true));
    eq(runCalls, [[true, { trigger: "종료 직전" }]], "종료 직전 run 인자(force·manual 없음)");
    eq(shape(), ["timeout:5000"], "상한 타이머 5000ms");
    await tick();
    eq(settled, false, "run 이 멎어 있으면 상한 전엔 안 끝난다");
    fire(pending("timeout")[0]);
    await raced;
    eq(settled, true, "상한 타이머가 울리면 태스크 promise 가 끝난다");

    // run 이 먼저 끝나도 상한 타이머는 해제되지 않고 남는다
    p.scheduleAutoPush();
    p.runSync = async () => undefined;
    added.length = 0;
    quit(tasks);
    await added[1]();
    eq(shape(), ["timeout:5000"], "run 이 먼저 끝나도 5초 타이머는 남는다(해제 안 함)");
  }

  // ───────────── runSync ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const s = stubDeps(p);

    // 미인증
    s.setAuthed(false);
    await p.runSync(false);
    eq(noticeLog, ["먼저 설정에서 Google 인증을 하세요."], "미인증 + 비-silent → Notice");
    await p.runSync(true);
    eq(noticeLog.length, 1, "미인증 + silent → Notice 없음");
    eq([s.engineCalls.length, p.statusBar.text, p.lastSyncAt], [0, "GCal —", 0], "미인증: 엔진·상태바·lastSyncAt 그대로(finally 밖)");
    s.setAuthed(true);

    // 재진입
    noticeLog.length = 0;
    const d = deferred<SyncResult>();
    s.setRun(() => d.promise);
    const opts = { force: true, manual: true, trigger: "수동(명령)" };
    const first = p.runSync(false, opts);
    eq([p.syncing, p.statusBar.text, s.engineCalls.length], [true, "GCal ⟳", 1], "run 시작: syncing · ⟳ · 엔진 1회");
    ok(s.engineCalls[0] === opts, "엔진은 opts 객체를 그대로 받는다(manual·trigger 포함)");
    await p.runSync(true, { trigger: "주기(5분)" });
    eq(shape(), ["timeout:5000"], "진행 중 비-force 호출 → 5초 뒤 후속 예약");
    const fu1 = pending("timeout")[0];
    await p.runSync(false, { force: true, manual: true, trigger: "수동(리본)" });
    eq(shape(), ["timeout:5000"], "진행 중 force 호출 → 버림(예약 없음)");
    ok(timers.has(fu1.id), "force 호출은 기존 후속 예약을 건드리지 않는다");
    await p.runSync(false, { manual: true });
    eq(shape(), ["timeout:5000"], "진행 중 비-force(수동이어도) → 후속 재예약, 하나만 남음");
    ok(!timers.has(fu1.id), "겹치면 마지막 예약만");
    await p.runSync(true, { trigger: "편집 자동" });
    eq(s.engineCalls.length, 1, "진행 중 호출은 엔진을 부르지 않는다");
    d.resolve(result());
    await first;
    eq([p.syncing, p.lastSyncAt, p.statusBar.text], [false, FIXED_NOW, "GCal ✓ 12:00"], "완료: syncing 해제 · lastSyncAt · ✓");
    eq(s.feedCalls, ["refreshAll"], "manual → feed.refreshAll");
    eq(noticeLog, ["GCal 동기화: +0 ~0 ↔0 -0 ⬇0"], "비-silent 는 변화가 없어도 Notice");
    eq(s.appendCalls, [["+0 ~0 ↔0 -0 ⬇0", [], "수동(명령)"]], "log.append(summary, entries, trigger)");
    const runCalls = spyRunSync(p);
    fire(pending("timeout")[0]);
    eq(runCalls, [[true, { trigger: "보류 해제 후속" }]], "후속 run 인자(manual 없음)");
  }

  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    const s = stubDeps(p);

    // silent 자동 · 변화 없음
    await p.runSync(true, { trigger: "주기(5분)" });
    eq(noticeLog, [], "silent + 변화 없음 → Notice 없음");
    eq(s.feedCalls, [], "자동 run → 피드 갱신 안 함");
    eq(s.appendCalls.pop(), ["+0 ~0 ↔0 -0 ⬇0", [], "주기(5분)"], "자동 run 로그 trigger");
    eq(p.statusBar.text, "GCal ✓ 12:00", "✓");
    eq(
      p.statusBar.attrs["aria-label"],
      // ODDITY(main.ts:461,475): aria-label 은 finally(lastSyncAt 갱신) 전에 계산된다 → 직전 run 기준
      "아직 동기화한 적 없음\n결과: 생성 0 · 수정 0 · 이동 0 · 삭제 0 · 노트반영 0\n전수 스캔: 아직 안 함",
      "aria-label = reportText — lastSyncAt 갱신 전 값(첫 run 이면 \"아직 동기화한 적 없음\")"
    );
    eq(shape(), [], "retryAfterMs 없음 → 후속 없음");

    // 비-silent · trigger 없음 · 카운트 · skip
    s.setRun(async () =>
      result({
        created: 1,
        updated: 2,
        moved: 3,
        deleted: 4,
        pulled: 5,
        skipped: 6,
        skips: { "vault-behind": 6 },
        entries: [{ action: "CREATE", id: "a1" } as any],
      })
    );
    consoleLines.length = 0;
    await p.runSync();
    eq(noticeLog.pop(), "GCal 동기화: +1 ~2 ↔3 -4 ⬇5 (skip 6)", "요약 Notice");
    eq(s.appendCalls.pop(), ["+1 ~2 ↔3 -4 ⬇5 (skip 6)", [{ action: "CREATE", id: "a1" }], "수동"], "trigger 없으면 \"수동\"");
    eq(
      consoleLines,
      ["[tasks-gcal-sync] 건너뜀: 볼트 동기화 중 6", "[tasks-gcal-sync] GCal 동기화: +1 ~2 ↔3 -4 ⬇5 (skip 6)"],
      "콘솔: 건너뜀 → 요약"
    );

    // silent 인데 변화 있음 → Notice
    s.setRun(async () => result({ pulled: 1 }));
    noticeLog.length = 0;
    await p.runSync(true, { trigger: "편집 자동" });
    eq(noticeLog, ["GCal 동기화: +0 ~0 ↔0 -0 ⬇1"], "silent 라도 변화가 있으면 Notice");

    // retryAfterMs → 후속
    s.setRun(async () => result({ retryAfterMs: 12_345 }));
    await p.runSync(true, { trigger: "편집 자동" });
    eq(shape(), ["timeout:12345"], "retryAfterMs → 그 지연으로 후속 예약");
    timers.clear();
    p.followUpTimer = null;

    // 실패 항목
    const fails = [
      { where: "a1", message: "m1" },
      { where: "b2", message: "m2" },
    ];
    s.setRun(async () => result({ failures: fails }));
    noticeLog.length = 0;
    consoleLines.length = 0;
    await p.runSync(false, { trigger: "x" });
    eq(p.statusBar.text, "GCal ⚠ 12:00", "실패 있으면 ⚠");
    eq(noticeLog, ["GCal 동기화: +0 ~0 ↔0 -0 ⬇0", "동기화 중 2건 실패 — m1"], "비-silent 실패 Notice(첫 메시지)");
    eq(consoleLines, ["[tasks-gcal-sync] 실패 a1: m1", "[tasks-gcal-sync] 실패 b2: m2", "[tasks-gcal-sync] GCal 동기화: +0 ~0 ↔0 -0 ⬇0"], "실패 콘솔 순서");
    noticeLog.length = 0;
    await p.runSync(true, { trigger: "x" });
    eq([noticeLog, p.statusBar.text], [[], "GCal ⚠ 12:00"], "silent 실패 → Notice 없음, ⚠ 만");

    // 성공은 lastFatal 을 지운다 / 예외
    const prevResult = p.lastResult;
    s.setRun(async () => {
      throw new Error("boom");
    });
    advanceClock(7_000);
    noticeLog.length = 0;
    await p.runSync(false, { manual: true, trigger: "편집 자동" });
    eq(p.lastFatal, "boom", "예외 → lastFatal");
    ok(p.lastResult === prevResult, "예외는 lastResult 를 지우지 않는다");
    eq(s.appendCalls.pop(), ["동기화 중단", [{ action: "FAIL", detail: "run 전체 실패: boom" }], "편집 자동"], "예외 로그");
    eq(noticeLog, ["동기화 실패: boom"], "예외 Notice");
    eq([p.statusBar.text, p.syncing, p.lastSyncAt], ["GCal ⚠ 12:00", false, FIXED_NOW + 7_000], "예외: ⚠ · finally 에서 lastSyncAt");
    eq(s.feedCalls, [], "예외면 manual 이어도 피드 갱신 안 함");
    ok(String(p.statusBar.attrs["aria-label"]).includes("\n⚠ 동기화 실패: boom\n"), "aria-label 에 치명 실패");
    await p.runSync(true, { trigger: "t" }); // 여전히 throw
    s.setRun(async () => result());
    await p.runSync(true, { trigger: "t" });
    eq(p.lastFatal, null, "성공 run 이 lastFatal 을 지운다");

    // ODDITY(main.ts:470): 문자열을 던지면 e.message 가 undefined
    s.setRun(() => Promise.reject("plain"));
    noticeLog.length = 0;
    await p.runSync(false, { trigger: "t" });
    eq([p.lastFatal, noticeLog], ["plain", ["동기화 실패: undefined"]], "문자열 예외 → Notice 는 \"undefined\"");

    // ODDITY(main.ts:465-472): catch 안의 log.append 도 던지면 상태바가 ⟳ 로 남고 runSync 가 reject
    s.setRun(async () => result());
    p.log.append = async () => {
      throw new Error("disk");
    };
    advanceClock(1_000);
    let rejected = "";
    await p.runSync(true, { trigger: "t" }).catch((e: any) => (rejected = e.message));
    eq(rejected, "disk", "로그 쓰기 실패 → runSync reject");
    eq([p.syncing, p.lastSyncAt, p.statusBar.text], [false, FIXED_NOW + 8_000, "GCal ⟳"], "finally 는 돌지만 상태바는 ⟳ 로 남는다");
    eq(p.lastFatal, "disk", "try 안 append 예외가 치명 실패로 기록");
  }

  // ───────────── describeSkips / reportText ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL() });
    await h.plugin.onload();
    const p = h.plugin;
    stubDeps(p);
    const all = [
      "vault-behind",
      "duplicate-id",
      "hold-task-gone",
      "hold-due-invalid",
      "hold-unschedule",
      "hold-conflict",
      "cold-start-create",
      "unsettled-create",
      "ensure-id-failed",
      "create-failed",
      "pull-failed",
      "mobile-readonly",
      "push-precondition",
      "reconcile-error",
    ];
    const skips: any = {};
    all.forEach((k, i) => (skips[k] = i + 1));
    eq(
      p.describeSkips(result({ skips })),
      "볼트 동기화 중 1 · 🆔 중복 2 · task 없음(보류) 3 · 📅 없음(보류) 4 · 이벤트 삭제됨(보류) 5 · " +
        "충돌 해결 보류(볼트 정착 대기) 6 · 콜드 스타트(생성 보류) 7 · 볼트 정착 대기(생성 보류) 8 · " +
        "🆔 쓰기 실패 9 · 이벤트 생성 실패 10 · 캘린더를 읽지 못함(쓰기 보류) 11 · " +
        "모바일 읽기 전용(GCal 쓰기 없음) 12 · GCal이 그 사이 또 바뀜(push 포기) 13 · 조정 실패 14",
      "SKIP_LABEL 14종 · 키 삽입 순서"
    );
    eq(
      p.describeSkips(result({ skips: { "cold-start-create": 2, "duplicate-id": 0, "vault-behind": 1 } })),
      "콜드 스타트(생성 보류) 2 · 볼트 동기화 중 1",
      "0 건은 빠지고 순서는 객체 키 순서"
    );
    eq(p.describeSkips(result()), "", "skip 없음 → 빈 문자열");
    // ODDITY(main.ts:491): 모르는 kind 는 "undefined N"
    eq(p.describeSkips(result({ skips: { weird: 3 } as any })), "undefined 3", "모르는 kind → undefined 라벨");

    eq(p.reportText(), "아직 동기화한 적 없음\n전수 스캔: 아직 안 함", "빈 리포트(인증됨)");

    p.lastSyncAt = Date.now() - 42_400;
    p.lastFatal = "fatal-x";
    p.lastResult = result({
      created: 1,
      updated: 2,
      moved: 3,
      deleted: 4,
      pulled: 5,
      skipped: 3,
      skips: { "duplicate-id": 1, "cold-start-create": 2 },
      failures: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ where: `w${i}`, message: `m${i}` })),
    });
    p.auth = { isAuthenticated: () => false };
    p.state.lastFullScanAt = Date.now() - 5.5 * 3600_000;
    eq(
      p.reportText(),
      [
        "마지막 동기화: 12:00 기준 42초 전",
        "⚠ 동기화 실패: fatal-x",
        "결과: 생성 1 · 수정 2 · 이동 3 · 삭제 4 · 노트반영 5",
        "건너뜀 3건 — 🆔 중복 1 · 콜드 스타트(생성 보류) 2",
        "⚠ w1: m1",
        "⚠ w2: m2",
        "⚠ w3: m3",
        "⚠ w4: m4",
        "⚠ w5: m5",
        "… 외 2건 (콘솔 참고)",
        "⚠ Google 미인증",
        "전수 스캔: 6시간 전",
      ].join("\n"),
      "전체 리포트(실패 5개까지 + 나머지 개수)"
    );
    // skipped 가 있어도 skips 가 비면 건너뜀 줄이 없다
    p.lastFatal = null;
    p.lastResult = result({ skipped: 4 });
    p.auth = { isAuthenticated: () => true };
    p.state.lastFullScanAt = undefined;
    p.lastSyncAt = Date.now() - 1_499;
    eq(
      p.reportText(),
      "마지막 동기화: 12:00 기준 1초 전\n결과: 생성 0 · 수정 0 · 이동 0 · 삭제 0 · 노트반영 0\n전수 스캔: 아직 안 함",
      "skips 가 비면 건너뜀 줄 없음"
    );

    // sync-report 명령 → Notice = reportText
    noticeLog.length = 0;
    p.__commands.find((c: any) => c.id === "sync-report").callback();
    eq(noticeLog, [p.reportText()], "sync-report Notice = reportText");
    ok(consoleLines.includes("[tasks-gcal-sync] 리포트\n" + p.reportText()), "sync-report 콘솔");
  }

  // ───────────── deviceTag / logPath ─────────────
  {
    reset();
    const bare: any = new TasksGcalSyncPlugin({} as any, MANIFEST as any);
    eq(bare.deviceTag(), "", "loadAll 전(state 없음) → \"\"");

    const h = makeHarness({ local: JSON.stringify({ records: {}, syncTokens: {} }), deviceName: "  My/PC  " });
    await h.plugin.loadAll();
    eq(h.calls, [], "loadAll 은 태그를 정하지 않는다");
    eq(h.plugin.deviceTag(), "My/PC", "Sync 기기 이름(trim)");
    eq(h.calls, ["saveLocalStorage"], "처음 정할 때 1회 저장");
    eq(JSON.parse(h.ls.get(LS_KEY)).logDeviceTag, "My/PC", "localStorage 에 굳힘");
    h.app.internalPlugins.plugins.sync.instance.deviceName = "Other";
    eq(h.plugin.deviceTag(), "My/PC", "굳힌 뒤엔 기기 이름이 바뀌어도 그대로");
    eq(h.calls.length, 1, "두 번째 호출은 저장 안 함");
    eq(h.plugin.logBasePath(), "Logs/GCal 동기화 로그.md", "기본 경로");
    eq(h.plugin.logPath(), "Logs/GCal 동기화 로그 (My-PC).md", "태그 붙은 경로(파일명 금지 문자 치환)");
    h.plugin.settings.syncLogPath = "   ";
    eq(h.plugin.logBasePath(), "Logs/GCal 동기화 로그.md", "공백 경로 → 기본값");
    h.plugin.settings.syncLogPath = " My\\Logs/sync ";
    eq([h.plugin.logBasePath(), h.plugin.logPath()], ["My/Logs/sync", "My/Logs/sync (My-PC)"], "normalizePath · 확장자 없음");

    await h.plugin.setDeviceTag("  New  ");
    eq([h.plugin.state.logDeviceTag, h.calls.length], ["New", 2], "setDeviceTag trim + 저장");
    await h.plugin.setDeviceTag("New");
    await h.plugin.setDeviceTag("   ");
    eq(h.calls.length, 2, "같은 값·빈 값 → 저장 안 함");

    // 기기 이름 없음 → 난수
    const realRandom = Math.random;
    for (const dn of [undefined, "   ", 5]) {
      reset();
      const hx = makeHarness({ local: JSON.stringify({ records: {}, syncTokens: {} }), deviceName: dn });
      await hx.plugin.loadAll();
      Math.random = () => 0.5;
      try {
        eq(hx.plugin.deviceTag(), "기기-i", `기기 이름 ${JSON.stringify(dn)} → 기기-<base36 4자 이하> (0.5 → "i")`);
      } finally {
        Math.random = realRandom;
      }
    }
    reset();
    const hr = makeHarness({ local: JSON.stringify({ records: {}, syncTokens: {} }) });
    await hr.plugin.loadAll();
    ok(/^기기-[0-9a-z]{1,4}$/.test(hr.plugin.deviceTag()), "실제 난수 태그 모양");

    // onload 중 noteLegacyLogFile 이 태그를 정하며 저장 1회 + 옛 공용 로그 안내
    reset();
    const ho = makeHarness({
      local: JSON.stringify({ records: {}, syncTokens: {}, refreshToken: "t" }),
      deviceName: "Desk",
      existing: ["Logs/GCal 동기화 로그.md"],
    });
    await ho.plugin.onload();
    await tick();
    eq(ho.calls, ["saveLocalStorage"], "onload: 태그 확정 저장 1회");
    ok(
      consoleLines.includes(
        '[tasks-gcal-sync] 이 기기의 로그는 이제 "Logs/GCal 동기화 로그 (Desk).md" 에 쌓입니다. ' +
          '이전 통합 로그 "Logs/GCal 동기화 로그.md" 는 그대로 두었습니다(필요 없으면 직접 삭제).'
      ),
      "옛 공용 로그 안내"
    );
  }

  // ───────────── openSyncLog / backfillIds / cleanupDuplicates ─────────────
  {
    reset();
    const h = makeHarness({ local: AUTHED_LOCAL(), indexed: [LOG_PC1] });
    await h.plugin.onload();
    await h.plugin.openSyncLog();
    eq(h.opened, [[true, LOG_PC1]], "인덱스에 있으면 새 탭으로 열기");
    eq(noticeLog, [], "Notice 없음");

    reset();
    const h2 = makeHarness({ local: AUTHED_LOCAL(), existing: [LOG_PC1] });
    await h2.plugin.onload();
    await h2.plugin.openSyncLog();
    eq(
      noticeLog,
      [`로그가 볼트 인덱스 밖에 있어 열 수 없습니다:\n${LOG_PC1}\n설정에서 볼트 안 경로(예: Logs/…)로 바꾸세요.`],
      "인덱스 밖 Notice"
    );
    noticeLog.length = 0;
    h2.files.delete(LOG_PC1);
    await h2.plugin.openSyncLog();
    eq(noticeLog, ["아직 기록된 동기화 로그가 없습니다."], "파일 없음 Notice");

    const p = h2.plugin;
    stubDeps(p);
    noticeLog.length = 0;
    p.auth = { isAuthenticated: () => false };
    await p.backfillIds();
    await p.cleanupDuplicates();
    eq(noticeLog, ["먼저 Google 인증을 하세요.", "먼저 Google 인증을 하세요."], "미인증 Notice");
    p.auth = { isAuthenticated: () => true };
    noticeLog.length = 0;
    p.engine.backfillDescriptions = async () => ({ ok: 3, fail: 0 });
    p.engine.cleanupDuplicates = async () => ({ removed: 2, checked: 9 });
    await p.backfillIds();
    await p.cleanupDuplicates();
    p.engine.backfillDescriptions = async () => ({ ok: 3, fail: 1 });
    await p.backfillIds();
    p.engine.backfillDescriptions = async () => {
      throw new Error("bf");
    };
    p.engine.cleanupDuplicates = async () => {
      throw new Error("cd");
    };
    await p.backfillIds();
    await p.cleanupDuplicates();
    eq(
      noticeLog,
      [
        "기존 이벤트에 🆔 백필 시작…",
        "백필 완료: 3개 성공",
        "중복 이벤트 정리 시작…",
        "중복 정리 완료: 2개 삭제 (9개 task 확인)",
        "기존 이벤트에 🆔 백필 시작…",
        "백필 완료: 3개 성공, 1 실패",
        "기존 이벤트에 🆔 백필 시작…",
        "백필 실패: bf",
        "중복 이벤트 정리 시작…",
        "중복 정리 실패: cd",
      ],
      "백필·중복 정리 Notice"
    );
  }
}

main()
  .catch((e) => {
    realError("테스트 하네스 예외:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    timers.clear();
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
    done();
  });
