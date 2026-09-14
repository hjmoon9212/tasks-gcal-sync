/**
 * 특성화 테스트 — 볼트 뒤처짐 · 정착 시계 · 콜드 스타트 가드(0.12.0 안전망).
 *
 * "옳은 동작"이 아니라 **현재 동작**을 고정한다. 문서(README·주석)와 어긋나는 것도 여기서는
 * 코드 그대로 박아 둔다 — 특히:
 *  - `run({ force: true })` 는 콜드 스타트 잠금을 **우회한다**(SyncEngine.run 의 coldHold).
 *  - 뒤처진 볼트에서 강행하면 early return 은 없지만 pull 은 꺼진다(holdWrites).
 * 리팩토링이 이걸 바꾸면 그건 리팩토링이 아니라 동작 변경이다.
 *
 * private 접근은 전부 helpers/internals.ts 를 거친다(이 파일은 바이트 단위로 그대로 둔다).
 */
import { installFakeEnv, resetClock, advanceClock } from "./helpers/fakeEnv";
installFakeEnv();

import { eq, ok, done } from "./helpers/assert";
import { doneEvent, harness, rec, task } from "./helpers/engineHarness";
import * as I from "./helpers/internals";

type H = ReturnType<typeof harness>;
const FUT = "2026-08-09";

const blank = () => harness({ tasks: [], events: [], records: {} });
const withSync = (h: H, instance: unknown) => {
  (h.app as any).internalPlugins = { plugins: { sync: { instance } } };
};
const behindOf = (instance: unknown): boolean => {
  const h = blank();
  withSync(h, instance);
  return I.vaultBehind(h.engine);
};
const status = (s: unknown) => behindOf({ getStatus: () => s });

/** pull(증분) 호출만 센다 — 전수 스캔(timeMax)은 calls.fullScan 이 따로 센다. */
function countPulls(h: H): { n: number } {
  const c = { n: 0 };
  const real = h.client.listEvents;
  h.client.listEvents = async (cal: string, params: any) => {
    if (params?.timeMax === undefined) c.n++;
    return real(cal, params);
  };
  return c;
}

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  // 1) vaultBehind() — 분기마다
  // ════════════════════════════════════════════════════════════════════════
  resetClock();
  {
    const h = blank();
    eq(I.vaultBehind(h.engine), false, "internalPlugins 가 {} → false");
    (h.app as any).internalPlugins = undefined;
    eq(I.vaultBehind(h.engine), false, "internalPlugins 없음 → false");
    (h.app as any).internalPlugins = { plugins: { sync: {} } };
    eq(I.vaultBehind(h.engine), false, "sync 인스턴스 없음 → false");
    Object.defineProperty(h.app, "internalPlugins", {
      configurable: true,
      get() {
        throw new Error("boom");
      },
    });
    eq(I.vaultBehind(h.engine), false, "internalPlugins 접근이 던짐 → false");
  }
  eq(behindOf({}), false, "빈 인스턴스 → false");
  eq(behindOf({ pause: true }), true, "pause === true → true");
  eq(behindOf({ pause: "true" }), false, "pause 가 문자열 → 불리언 신호 아님");
  eq(behindOf({ pause: false, getStatus: () => "synced" }), false, "pause false + synced → false");
  eq(behindOf({ syncing: true }), true, "syncing === true → true");
  eq(behindOf({ syncing: 1 }), false, "syncing 이 truthy 숫자 → 신호 아님");
  eq(behindOf({ pause: true, getStatus: () => "synced" }), true, "pause 가 상태 문자열보다 먼저");
  eq(behindOf({ syncing: true, getStatus: () => "synced" }), true, "syncing 이 상태 문자열보다 먼저");

  eq(status("Syncing"), true, "getStatus: Syncing");
  eq(status("synced"), false, "getStatus: synced");
  eq(status("Fully synced"), false, "getStatus: Fully synced");
  eq(status("unsynced"), false, "getStatus: unsynced (syncing 이 아님)");
  eq(status("resyncing"), true, "getStatus: 부분 문자열 resyncing 도 true");
  eq(status("SYNCHRONIZING"), true, "getStatus: synchronizing(대소문자 무시)");
  eq(status("Uploading 3 files"), true, "getStatus: uploading");
  eq(status("downloading"), true, "getStatus: downloading");
  eq(status("pending"), true, "getStatus: pending");
  eq(status("queued"), true, "getStatus: queued");
  eq(status("동기화 중"), true, "getStatus: 동기화 중");
  eq(status("동기화중"), true, "getStatus: 동기화중(공백 없음)");
  eq(status("동기화   중"), true, "getStatus: 동기화   중(여러 공백)");
  eq(status("동기화 완료"), false, "getStatus: 동기화 완료");
  eq(status("업로드"), true, "getStatus: 업로드");
  eq(status("다운로드 대기"), true, "getStatus: 다운로드");
  eq(status("error"), false, "getStatus: error → fail-open");
  eq(status("paused"), false, "getStatus: paused 문자열은 신호 아님");
  eq(status(""), false, "getStatus: 빈 문자열");
  eq(status(undefined), false, "getStatus: undefined");
  eq(status(null), false, "getStatus: null");
  eq(status(0), false, "getStatus: 숫자");
  eq(status({ state: "syncing" }), false, "getStatus: 객체 → [object object]");
  eq(behindOf({ syncStatus: "Syncing" }), true, "getStatus 없음 → syncStatus 를 읽는다");
  eq(behindOf({ getStatus: "Syncing", syncStatus: "synced" }), false, "getStatus 가 함수가 아니면 syncStatus");
  eq(
    behindOf({ getStatus: () => undefined, syncStatus: "Syncing" }),
    false,
    "getStatus 가 함수면 syncStatus 는 안 본다"
  );
  eq(
    behindOf({
      getStatus: () => {
        throw new Error("x");
      },
    }),
    false,
    "getStatus 가 던짐 → false"
  );
  eq(
    behindOf({
      pause: true,
      getStatus: () => {
        throw new Error("x");
      },
    }),
    false,
    "getStatus 가 던지면 pause true 여도 false(상태를 먼저 읽기 때문 — 현재 동작)"
  );

  // ════════════════════════════════════════════════════════════════════════
  // 2) fail-open 상한: behindBudgetExceeded · resetBehindBudget
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = blank();
    eq(I.getBehindSince(h.engine), null, "처음엔 behindSince null");
    eq(I.behindBudgetExceeded(h.engine), false, "첫 호출 → false");
    const t0 = Date.now();
    eq(I.getBehindSince(h.engine), t0, "첫 호출이 시계를 시작한다");
    advanceClock(10 * 60_000);
    eq(I.behindBudgetExceeded(h.engine), false, "정확히 10분 → 아직 false(초과만 true)");
    eq(I.getBehindSince(h.engine), t0, "이어지는 호출은 시작 시각을 안 바꾼다");
    advanceClock(1);
    eq(I.behindBudgetExceeded(h.engine), true, "10분 + 1ms → true");
    eq(I.behindBudgetExceeded(h.engine), true, "초과 뒤에도 계속 true");
    I.resetBehindBudget(h.engine);
    eq(I.getBehindSince(h.engine), null, "reset → null");
    eq(I.behindBudgetExceeded(h.engine), false, "reset 뒤 첫 호출 → 다시 false");
    eq(I.getBehindSince(h.engine), Date.now(), "reset 뒤 시계를 지금부터");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3) pushArmed — 60초 + pullCycleDone
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = blank();
    I.setLoadedAt(h.engine, Date.now());
    I.setPullCycleDone(h.engine, true);
    eq(I.pushArmed(h.engine), false, "방금 로드 → false");
    I.setLoadedAt(h.engine, Date.now() - 59_999);
    eq(I.pushArmed(h.engine), false, "59.999초 → false");
    I.setLoadedAt(h.engine, Date.now() - 60_000);
    eq(I.pushArmed(h.engine), true, "정확히 60초 + pull 완주 → true");
    I.setPullCycleDone(h.engine, false);
    eq(I.pushArmed(h.engine), false, "60초 지났어도 pull 미완주 → false");
  }
  {
    resetClock();
    const h = blank();
    // harness 가 덮어쓰기 전의 생성 시 기본값은 볼 수 없으므로, 새 엔진의 필드를 직접 읽는 대신
    // harness 기본(콜드 스타트 지남·정착)을 확인해 둔다.
    eq(I.getLoadedAt(h.engine), Date.now() - 10 * 60_000, "harness: loadedAt 10분 전");
    eq(I.getPullCycleDone(h.engine), true, "harness: pullCycleDone");
    eq(I.getSettledSince(h.engine), Date.now() - 10 * 60_000, "harness: settledSince 10분 전");
    eq(I.pushArmed(h.engine), true, "harness: push 가능");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4) run() 의 뒤처짐 early return · 정착 시계
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const tasks = [task("A1", false, FUT)];
    const h = harness({ tasks, events: [doneEvent("A1", false, "100")], records: { A1: rec() } });
    let got = 0;
    const repo = I.taskRepo(h.engine); // 관찰: getTasks 호출 수
    const realGet = repo.getTasks;
    repo.getTasks = async () => {
      got++;
      return realGet();
    };
    withSync(h, { getStatus: () => "Syncing" });
    const pulls = countPulls(h);
    const r = await h.engine.run();
    eq(
      r,
      {
        created: 0,
        updated: 0,
        moved: 0,
        deleted: 0,
        pulled: 0,
        skipped: 1,
        skips: { "vault-behind": 1 },
        failures: [],
        entries: [
          {
            action: "SKIP",
            detail: "볼트가 Obsidian Sync로 아직 따라잡는 중 → run 전체 보류(15초 뒤 재확인)",
          },
        ],
        retryAfterMs: 15_000,
      },
      "뒤처짐: early return 결과 전체"
    );
    eq(got, 0, "뒤처짐 early return: task 를 읽지도 않는다");
    eq([pulls.n, h.calls.fullScan, h.calls.patch.length], [0, 0, 0], "뒤처짐 early return: 네트워크 없음");
    eq(I.getSettledSince(h.engine), null, "뒤처짐 early return 도 정착 시계를 리셋한다");
    eq(I.getBehindSince(h.engine), Date.now(), "뒤처짐 early return 이 상한 시계를 시작한다");

    advanceClock(5_000);
    withSync(h, { getStatus: () => "synced" });
    const r2 = await h.engine.run();
    eq(I.getSettledSince(h.engine), Date.now(), "뒤처짐 해소 → 정착 시계를 지금부터");
    eq(I.getBehindSince(h.engine), null, "뒤처짐 해소 → 상한 시계 리셋");
    eq(r2.retryAfterMs, 32_000, "정착 전 → SETTLE_MS - 0 + 2초 뒤 재시도");
    eq(h.calls.patch.length, 1, "정착 전이어도 충돌 아닌 push 는 나간다");

    advanceClock(29_999);
    const r3 = await h.engine.run();
    eq(r3.retryAfterMs, 2_001, "29.999초 정착 → 아직 정착 전(0.001초 + 2초)");
    advanceClock(1);
    const r4 = await h.engine.run();
    eq(r4.retryAfterMs, undefined, "정확히 30초 → 정착");
    eq(I.getSettledSince(h.engine), Date.now() - 30_000, "정착 중에는 시계를 안 옮긴다");
  }
  {
    // 정착 시계는 이미 null 이 아니면 뒤처짐이 없어도 **옮기지 않는다**.
    resetClock();
    const h = blank();
    I.setSettledSince(h.engine, Date.now() - 3_000);
    const r = await h.engine.run();
    eq(I.getSettledSince(h.engine), Date.now() - 3_000, "정착 시계 유지");
    eq(r.retryAfterMs, 29_000, "정착 3초째 → 27초 + 2초");
  }
  {
    // 상한 초과 → 평소대로 돈다(pull 포함). 그러나 정착 시계는 null 이라 파괴적 동작은 막힌다.
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() } });
    withSync(h, { pause: true });
    I.setBehindSince(h.engine, Date.now() - 10 * 60_000 - 1);
    const pulls = countPulls(h);
    const r = await h.engine.run();
    eq(pulls.n, 1, "상한 초과: pull 을 한다");
    eq(h.calls.del, [], "상한 초과: 그래도 삭제는 안 한다(정착 전)");
    eq(r.skips, { "hold-task-gone": 1 }, "상한 초과: hold-task-gone 으로 보류");
    eq(r.retryAfterMs, 32_000, "상한 초과: 정착 재시도 예약");
    eq(I.getSettledSince(h.engine), null, "상한 초과여도 뒤처짐이라 정착 시계는 null");
    eq(I.getBehindSince(h.engine), Date.now() - 10 * 60_000 - 1, "상한 초과: 상한 시계는 그대로(리셋 안 함)");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5) 콜드 스타트 재시도 값 — COLD_START_MS - 경과 + 2초
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = blank();
    I.setLoadedAt(h.engine, Date.now() - 20_000);
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run();
    eq(r.retryAfterMs, 42_000, "콜드 20초째 + 이번 run 이 pull 완주 → 42초");
    eq(I.getPullCycleDone(h.engine), true, "pull 완주 → pullCycleDone");
  }
  {
    resetClock();
    const h = blank();
    I.setLoadedAt(h.engine, Date.now() - 70_000);
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run();
    eq(r.retryAfterMs, 2_000, "시간은 지났고 pull 만 미완주였음 → max(0, …) + 2초");
    eq(I.pushArmed(h.engine), true, "이 run 뒤로는 push 가능");
  }
  {
    resetClock();
    const h = blank();
    I.setLoadedAt(h.engine, Date.now() - 20_000);
    I.setSettledSince(h.engine, Date.now() - 25_000);
    const r = await h.engine.run();
    eq(r.retryAfterMs, 7_000, "콜드 42초 vs 정착 7초 → 이른 쪽");
  }
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() }, pullFails: true });
    I.setLoadedAt(h.engine, Date.now() - 20_000);
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run();
    eq(r.retryAfterMs, undefined, "pull 실패 → 콜드 재시도를 예약하지 않는다");
    eq(I.getPullCycleDone(h.engine), false, "pull 실패 → pullCycleDone 그대로 false");
  }
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    I.setLoadedAt(h.engine, Date.now());
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run();
    eq(h.calls.insert.length, 0, "콜드: 생성 없음");
    eq(r.skips, { "cold-start-create": 1 }, "콜드: cold-start-create");
    eq(r.retryAfterMs, 62_000, "콜드 0초째 → 62초");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6) ★ 수동 실행(force)은 콜드 스타트를 우회한다 — 현재 동작(문서와 다름)
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    I.setLoadedAt(h.engine, Date.now());
    I.setPullCycleDone(h.engine, false);
    const r = await h.engine.run({ force: true });
    eq(h.calls.insert.length, 1, "force: 방금 로드됐어도 이벤트를 만든다(coldHold=false) ★");
    eq(r.skips, {}, "force: cold-start-create 없음");
    eq(r.retryAfterMs, undefined, "force: 콜드 재시도 예약 없음");
    eq(r.entries.map((e) => e.action), ["CREATE"], "force: CREATE");
  }
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, FUT)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    I.setLoadedAt(h.engine, Date.now());
    I.setPullCycleDone(h.engine, false);
    await h.engine.run({ force: true });
    eq(h.calls.patch.length, 1, "force: 방금 로드됐어도 기존 이벤트 push ★");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7) ★ 뒤처진 채 강행(force) — early return 없음, pull 은 꺼짐(holdWrites)
  // ════════════════════════════════════════════════════════════════════════
  {
    resetClock();
    const h = harness({
      tasks: [task("A1", false, FUT)],
      events: [doneEvent("A1", false, "100")],
      records: { A1: rec() },
    });
    withSync(h, { getStatus: () => "Syncing" });
    I.setPullCycleDone(h.engine, false);
    const pulls = countPulls(h);
    const r = await h.engine.run({ force: true });
    eq(pulls.n, 0, "뒤처짐 + force: 증분 pull 을 하지 않는다 ★");
    eq(h.calls.fullScan, 1, "뒤처짐 + force: 전수 스캔은 그대로 돈다(scanDue)");
    eq(r.skips["vault-behind"], undefined, "뒤처짐 + force: early return 하지 않는다 ★");
    eq(h.calls.patch.length, 1, "뒤처짐 + force: 원격을 안 읽은 채 노트 변경을 push 한다(현재 동작) ★");
    eq(r.entries.map((e) => e.action), ["UPDATE"], "뒤처짐 + force: UPDATE");
    eq(r.retryAfterMs, 32_000, "뒤처짐 + force: 정착 전 재시도");
    eq(I.getSettledSince(h.engine), null, "뒤처짐 + force: 정착 시계 리셋");
    eq(I.getBehindSince(h.engine), Date.now(), "뒤처짐 + force: 상한 시계 시작");
    eq(I.getPullCycleDone(h.engine), false, "뒤처짐 + force: pull 을 안 했으니 pullCycleDone 그대로");
  }
  {
    resetClock();
    const h = harness({ tasks: [], events: [], records: { A1: rec() } });
    withSync(h, { syncing: true });
    const r = await h.engine.run({ force: true });
    eq(h.calls.del, [], "뒤처짐 + force: 삭제는 안 한다");
    eq(r.skips, { "hold-task-gone": 1 }, "뒤처짐 + force: hold-task-gone");
  }
  {
    resetClock();
    const h = harness({ tasks: [task("N1", false, FUT)], events: [], records: {} });
    withSync(h, { pause: true });
    const r = await h.engine.run({ force: true });
    eq(h.calls.insert.length, 1, "뒤처짐 + force: 생성은 연다(정착 전이어도)");
    ok(r.entries.some((e) => e.action === "CREATE"), "뒤처짐 + force: CREATE 기록");
  }

  done();
})();
