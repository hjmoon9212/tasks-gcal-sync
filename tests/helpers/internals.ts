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
import { CodecCtx } from "../../src/sync/codec/ctx";
import * as P from "../../src/sync/codec/presentation";
import * as PL from "../../src/sync/codec/payload";
import * as ST from "../../src/sync/codec/stamp";
import * as TM from "../../src/sync/codec/timeMapping";
import * as LT from "../../src/sync/engine/logText";

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

// ── 코덱은 0.12.3 에서 src/sync/codec/* 로 옮겼다 — 엔진의 codec 컨텍스트로 모듈을 직접 부른다 ──
const ctx = (engine: SyncEngine): CodecCtx => E(engine).codec;

// ── 표현(제목·설명·색) ────────────────────────────────────────────────────
export const titleBase = (_engine: SyncEngine, t: TaskLike): string => P.titleBase(t);
export const summary = (engine: SyncEngine, t: TaskLike): string => P.summary(ctx(engine), t);
export const doneColor = (engine: SyncEngine, t: TaskLike): string | null | undefined =>
  P.doneColor(ctx(engine), t);
export const gcalTitleBase = (engine: SyncEngine, ev: GCalEvent): string =>
  P.gcalTitleBase(ctx(engine), ev);
export const deepLink = (engine: SyncEngine, t: TaskLike): string | null =>
  P.deepLink(ctx(engine), t);
export const noteBlock = (engine: SyncEngine, id: string, t?: TaskLike): string =>
  P.noteBlock(ctx(engine), id, t);
export const userDescription = (_engine: SyncEngine, prev: string): string =>
  P.userDescription(prev);
export const mergeDescription = (
  engine: SyncEngine,
  prev: string,
  id: string,
  t?: TaskLike
): string => P.mergeDescription(ctx(engine), prev, id, t);
export const presentationPatch = (
  engine: SyncEngine,
  id: string,
  t: TaskLike,
  ev?: GCalEvent
): Partial<GCalEvent> => PL.presentationPatch(ctx(engine), id, t, ev);
export const buildEvent = (engine: SyncEngine, t: TaskLike, id: string): GCalEvent =>
  PL.buildEvent(ctx(engine), t, id);

// ── 시각·날짜 매핑 ─────────────────────────────────────────────────────────
export const spanStart = (_engine: SyncEngine, t: TaskLike): string => TM.spanStart(t);
export const eventStartDate = (_engine: SyncEngine, ev: GCalEvent): string | undefined =>
  TM.eventStartDate(ev);
export const eventDueDate = (_engine: SyncEngine, ev: GCalEvent): string | undefined =>
  TM.eventDueDate(ev);
export const eventTimeRange = (_engine: SyncEngine, ev: GCalEvent): string | undefined =>
  TM.eventTimeRange(ev);
export const isMultiDay = (_engine: SyncEngine, t: TaskLike): boolean => TM.isMultiDay(t);
export const taskTime = (_engine: SyncEngine, t: TaskLike): string => TM.taskTime(t);
export const timedDates = (_engine: SyncEngine, t: TaskLike): Partial<GCalEvent> | null =>
  TM.timedDates(t);
export const exclusiveDates = (_engine: SyncEngine, d: Partial<GCalEvent>): Partial<GCalEvent> =>
  TM.exclusiveDates(d);

// ── 스탬프(tgs*) 코덱 · 판정 입력 ─────────────────────────────────────────
export const privateProps = (
  engine: SyncEngine,
  id: string,
  t: TaskLike
): Record<string, string> => ST.privateProps(ctx(engine), id, t);
export const isOurs = (engine: SyncEngine, ev: GCalEvent): boolean => ST.isOurs(ctx(engine), ev);
export const recordFromEvent = (
  _engine: SyncEngine,
  ev: GCalEvent,
  calendarId: string,
  t: TaskLike
): SyncRecord => ST.recordFromEvent(ev, calendarId, t);
export const recordFromEventOnly = (
  engine: SyncEngine,
  ev: GCalEvent,
  calendarId: string
): SyncRecord | null => ST.recordFromEventOnly(ctx(engine), ev, calendarId);
export const taskState = (_engine: SyncEngine, t?: TaskLike): TaskState => ST.taskState(t);
export const localView = (_engine: SyncEngine, t: TaskLike): LocalView => ST.localView(t);
export const remoteView = (engine: SyncEngine, ev?: GCalEvent): RemoteView | undefined =>
  ST.remoteView(ctx(engine), ev);
export const eventStamp = (_engine: SyncEngine, ev: GCalEvent): RemoteView["stamp"] =>
  ST.eventStamp(ev);
// 0.12.6 에서 CalendarPuller(engine.puller)로 옮겼다
export const knownCalendarIds = (engine: SyncEngine): string[] =>
  E(engine).puller.knownCalendarIds();

// ── 로그 문구 — 0.12.4 에서 src/sync/engine/logText.ts 로 옮겼다 ────────────────
export const fieldText = (_engine: SyncEngine, s: SnapLike, f: Field): string =>
  LT.fieldText(s, f);
export const diffText = (
  _engine: SyncEngine,
  before: SnapLike,
  after: SnapLike,
  fields: Field[]
): string => LT.diffText(before, after, fields);
export const changedFields = (
  _engine: SyncEngine,
  before: SnapLike,
  after: SnapLike,
  fields?: readonly Field[]
): Field[] => LT.changedFields(before, after, fields);
export const lastLineText = (_engine: SyncEngine, rec: SyncRecord): string =>
  LT.lastLineText(rec);
/**
 * 병합 한 건의 로그. `c` 는 옛 SyncEngine.logMerge 의 인자 모양 그대로다(result 포함) —
 * 지금은 순수 함수 mergeEntry 가 항목을 돌려주고 applyMerge 가 result 에 넣는다.
 */
export const logMerge = (engine: SyncEngine, c: any): void => {
  const entry = LT.mergeEntry(E(engine).settings, c);
  if (entry) c.result.entries.push(entry);
};

// ── 가드(볼트 뒤처짐 · 정착 · 콜드 스타트) — 0.12.5 에서 VaultGuard(engine.guard)로 옮겼다 ──
export const vaultBehind = (engine: SyncEngine): boolean => E(engine).guard.vaultBehind();
export const behindBudgetExceeded = (engine: SyncEngine): boolean =>
  E(engine).guard.behindBudgetExceeded();
export const resetBehindBudget = (engine: SyncEngine): void =>
  E(engine).guard.resetBehindBudget();
export const pushArmed = (engine: SyncEngine): boolean => E(engine).guard.pushArmed();

/** 엔진이 쥔 TaskRepository — 호출 여부를 관찰하려고 메서드를 감쌀 때 쓴다. */
export const taskRepo = (engine: SyncEngine): { getTasks: () => Promise<any[]> } =>
  E(engine).repo;

// ── 가드 상태 필드 ────────────────────────────────────────────────────────
export const getLoadedAt = (engine: SyncEngine): number => E(engine).guard.loadedAt;
export const setLoadedAt = (engine: SyncEngine, v: number): void => {
  E(engine).guard.loadedAt = v;
};
export const getPullCycleDone = (engine: SyncEngine): boolean => E(engine).guard.pullCycleDone;
export const setPullCycleDone = (engine: SyncEngine, v: boolean): void => {
  E(engine).guard.pullCycleDone = v;
};
export const getBehindSince = (engine: SyncEngine): number | null => E(engine).guard.behindSince;
export const setBehindSince = (engine: SyncEngine, v: number | null): void => {
  E(engine).guard.behindSince = v;
};
export const getSettledSince = (engine: SyncEngine): number | null => E(engine).guard.settledSince;
export const setSettledSince = (engine: SyncEngine, v: number | null): void => {
  E(engine).guard.settledSince = v;
};
