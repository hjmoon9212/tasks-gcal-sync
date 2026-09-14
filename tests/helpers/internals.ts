/**
 * SyncEngine 의 **private 메서드·필드에 닿는 유일한 통로**(0.12.0 안전망).
 *
 * 왜 이 파일이 따로 있나: 0.12.x 는 SyncEngine 을 여러 모듈(코덱·시각 매핑·로그 문구·가드)
 * 로 쪼개는 **동작 보존 리팩토링**이다. 특성화 테스트(tests/*.characterization.test.ts)가
 * `(engine as any).summary(...)` 를 직접 부르면, 메서드가 다른 모듈로 옮겨 가는 순간 테스트
 * 파일까지 고쳐야 하고 — 그러면 "테스트는 그대로인데 통과한다"는 증거가 사라진다.
 *
 * 그래서 private 접근은 **여기에만** 둔다. 리팩토링 릴리스는 이 파일의 래퍼만 새 모듈로
 * 다시 겨누고, 특성화 테스트 파일은 **바이트 단위로 그대로** 둔다.
 *
 * ⛔ 테스트 파일에서 `(engine as any)` 를 직접 쓰지 않는다. 필요한 것이 없으면 여기에 더한다.
 * ⛔ 래퍼 시그니처는 평범한 입력(엔진 인스턴스 + 값)으로 둔다 — 새 모듈이 엔진 없이 같은
 *    값을 받을 수 있게.
 */
import { SyncEngine } from "../../src/sync/SyncEngine";
import { GCalEvent } from "../../src/gcal/CalendarClient";
import { SyncRecord } from "../../src/sync/StateStore";
import { Field, LocalView, RemoteView, TaskState } from "../../src/sync/reconcile";

/** 테스트 픽스처는 VaultTask 의 일부만 채운다 — 여기서는 느슨하게 받는다. */
export type TaskLike = any;
/** fieldText·diffText·changedFields 가 받는 스냅샷 모양. */
export type SnapLike = {
  due: string;
  start?: string;
  time?: string;
  done: boolean;
  title: string;
};

const E = (engine: SyncEngine): any => engine as any;

// ── 표현(제목·설명·색) ────────────────────────────────────────────────────
export const titleBase = (engine: SyncEngine, t: TaskLike): string => E(engine).titleBase(t);
export const summary = (engine: SyncEngine, t: TaskLike): string => E(engine).summary(t);
export const doneColor = (engine: SyncEngine, t: TaskLike): string | null | undefined =>
  E(engine).doneColor(t);
export const gcalTitleBase = (engine: SyncEngine, ev: GCalEvent): string =>
  E(engine).gcalTitleBase(ev);
export const deepLink = (engine: SyncEngine, t: TaskLike): string | null => E(engine).deepLink(t);
export const noteBlock = (engine: SyncEngine, id: string, t?: TaskLike): string =>
  E(engine).noteBlock(id, t);
export const userDescription = (engine: SyncEngine, prev: string): string =>
  E(engine).userDescription(prev);
export const mergeDescription = (
  engine: SyncEngine,
  prev: string,
  id: string,
  t?: TaskLike
): string => E(engine).mergeDescription(prev, id, t);
export const presentationPatch = (
  engine: SyncEngine,
  id: string,
  t: TaskLike,
  ev?: GCalEvent
): Partial<GCalEvent> => E(engine).presentationPatch(id, t, ev);
export const buildEvent = (engine: SyncEngine, t: TaskLike, id: string): GCalEvent =>
  E(engine).buildEvent(t, id);

// ── 시각·날짜 매핑 ─────────────────────────────────────────────────────────
export const spanStart = (engine: SyncEngine, t: TaskLike): string => E(engine).spanStart(t);
export const eventStartDate = (engine: SyncEngine, ev: GCalEvent): string | undefined =>
  E(engine).eventStartDate(ev);
export const eventDueDate = (engine: SyncEngine, ev: GCalEvent): string | undefined =>
  E(engine).eventDueDate(ev);
export const eventTimeRange = (engine: SyncEngine, ev: GCalEvent): string | undefined =>
  E(engine).eventTimeRange(ev);
export const isMultiDay = (engine: SyncEngine, t: TaskLike): boolean => E(engine).isMultiDay(t);
export const taskTime = (engine: SyncEngine, t: TaskLike): string => E(engine).taskTime(t);
export const timedDates = (engine: SyncEngine, t: TaskLike): Partial<GCalEvent> | null =>
  E(engine).timedDates(t);
export const exclusiveDates = (engine: SyncEngine, d: Partial<GCalEvent>): Partial<GCalEvent> =>
  E(engine).exclusiveDates(d);

// ── 스탬프(tgs*) 코덱 · 판정 입력 ─────────────────────────────────────────
export const privateProps = (
  engine: SyncEngine,
  id: string,
  t: TaskLike
): Record<string, string> => E(engine).privateProps(id, t);
export const isOurs = (engine: SyncEngine, ev: GCalEvent): boolean => E(engine).isOurs(ev);
export const recordFromEvent = (
  engine: SyncEngine,
  ev: GCalEvent,
  calendarId: string,
  t: TaskLike
): SyncRecord => E(engine).recordFromEvent(ev, calendarId, t);
export const recordFromEventOnly = (
  engine: SyncEngine,
  ev: GCalEvent,
  calendarId: string
): SyncRecord | null => E(engine).recordFromEventOnly(ev, calendarId);
export const taskState = (engine: SyncEngine, t?: TaskLike): TaskState => E(engine).taskState(t);
export const localView = (engine: SyncEngine, t: TaskLike): LocalView => E(engine).localView(t);
export const remoteView = (engine: SyncEngine, ev?: GCalEvent): RemoteView | undefined =>
  E(engine).remoteView(ev);
export const eventStamp = (engine: SyncEngine, ev: GCalEvent): RemoteView["stamp"] =>
  E(engine).eventStamp(ev);
export const knownCalendarIds = (engine: SyncEngine): string[] => E(engine).knownCalendarIds();

// ── 로그 문구 ─────────────────────────────────────────────────────────────
export const fieldText = (engine: SyncEngine, s: SnapLike, f: Field): string =>
  E(engine).fieldText(s, f);
export const diffText = (
  engine: SyncEngine,
  before: SnapLike,
  after: SnapLike,
  fields: Field[]
): string => E(engine).diffText(before, after, fields);
export const changedFields = (
  engine: SyncEngine,
  before: SnapLike,
  after: SnapLike,
  fields?: readonly Field[]
): Field[] => E(engine).changedFields(before, after, fields);
export const lastLineText = (engine: SyncEngine, rec: SyncRecord): string =>
  E(engine).lastLineText(rec);
/** 병합 한 건의 로그. `c` 는 SyncEngine.logMerge 의 인자 모양 그대로다. */
export const logMerge = (engine: SyncEngine, c: any): void => E(engine).logMerge(c);

// ── 가드(볼트 뒤처짐 · 정착 · 콜드 스타트) ─────────────────────────────────
export const vaultBehind = (engine: SyncEngine): boolean => E(engine).vaultBehind();
export const behindBudgetExceeded = (engine: SyncEngine): boolean =>
  E(engine).behindBudgetExceeded();
export const resetBehindBudget = (engine: SyncEngine): void => E(engine).resetBehindBudget();
export const pushArmed = (engine: SyncEngine): boolean => E(engine).pushArmed();

/** 엔진이 쥔 TaskRepository — 호출 여부를 관찰하려고 메서드를 감쌀 때 쓴다. */
export const taskRepo = (engine: SyncEngine): { getTasks: () => Promise<any[]> } =>
  E(engine).repo;

// ── 가드 상태 필드 ────────────────────────────────────────────────────────
export const getLoadedAt = (engine: SyncEngine): number => E(engine).loadedAt;
export const setLoadedAt = (engine: SyncEngine, v: number): void => {
  E(engine).loadedAt = v;
};
export const getPullCycleDone = (engine: SyncEngine): boolean => E(engine).pullCycleDone;
export const setPullCycleDone = (engine: SyncEngine, v: boolean): void => {
  E(engine).pullCycleDone = v;
};
export const getBehindSince = (engine: SyncEngine): number | null => E(engine).behindSince;
export const setBehindSince = (engine: SyncEngine, v: number | null): void => {
  E(engine).behindSince = v;
};
export const getSettledSince = (engine: SyncEngine): number | null => E(engine).settledSince;
export const setSettledSince = (engine: SyncEngine, v: number | null): void => {
  E(engine).settledSince = v;
};
