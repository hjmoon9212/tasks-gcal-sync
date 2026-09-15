/**
 * GCal 에서 읽어 오는 쪽 — 증분 pull(syncToken) · 전수 스캔(records 재구성) · 보류 record 재조회.
 * SyncEngine 에서 그대로 옮겼다(0.12.6).
 *
 * ⛔ **"이벤트가 델타에 안 왔다" 는 원격 미확인의 근거가 아니다.** 증분 pull 은 바뀐 것만 준다.
 *    근거가 될 수 있는 것은 "그 캘린더를 못 읽었다"(pullFailedCals) 뿐이다.
 * ⛔ syncTokens 는 이 클래스만 만진다 — EventFeed(캘린더 뷰 피드)는 PersistedState 를 받지 않는다.
 */
import { CalendarClient, GCalEvent } from "../../gcal/CalendarClient";
import { PluginSettings } from "../../settings/Settings";
import { PersistedState, SyncRecord } from "../StateStore";
import { isoDaysAgo } from "../dates";
import { errMsg } from "../../util/errors";
import { CodecCtx } from "../codec/ctx";
import { isOurs, recordFromEventOnly } from "../codec/stamp";
import { calName } from "./logText";
import { SyncResult, addFailure } from "./result";

/** 캘린더 하나의 증분 pull 결과. */
export interface CalPull {
  byTaskId: Map<string, GCalEvent>;
  cancelledEventIds: Set<string>;
}

/** 이번 run 의 pull 전체. */
export interface PullAll {
  pullByCal: Map<string, CalPull>;
  /**
   * 이번 run 에 **읽지 못한** 캘린더. 그 캘린더의 record 는 run 에서 통째로 건너뛴다.
   *
   * ⛔ **"이벤트가 안 왔다"를 근거로 삼으면 안 된다** — 증분 pull 은 변경된 이벤트만
   * 주므로 안 바뀐 이벤트는 원래 응답에 없다. 근거가 될 수 있는 것은 오직
   * **"이 캘린더를 읽는 데 실패했다"** 뿐이다.
   */
  pullFailedCals: Set<string>;
  /** 한 캘린더도 빠짐없이 읽었나 — 콜드 스타트 잠금을 풀 조건이다. */
  pullOk: boolean;
}

export class CalendarPuller {
  constructor(
    private readonly client: CalendarClient,
    private readonly codec: CodecCtx,
    private readonly state: PersistedState,
    private readonly settings: PluginSettings
  ) {}

  /** 우리가 이벤트를 올리는 캘린더 전부(기본 + 라우팅 규칙 + 기존 record). */
  knownCalendarIds(): string[] {
    const ids = new Set<string>();
    if (this.settings.defaultCalendarId) ids.add(this.settings.defaultCalendarId);
    for (const r of this.settings.rules) if (r.calendarId) ids.add(r.calendarId);
    for (const rec of Object.values(this.state.records)) {
      if (rec.calendarId) ids.add(rec.calendarId);
    }
    return [...ids];
  }

  /**
   * records를 캘린더에서 재구성한다.
   *
   * records는 진실원천이 아니라 **캐시**다 — 매핑(tgsTaskId)도 스냅샷(tgsDue/tgsStart/
   * tgsDone/tgsTitle)도 이미 이벤트에 심겨 있다(privateProps). 그래서 캐시가 비었거나
   * 캘린더보다 좁아도 한 번 훑으면 그대로 복원된다. 이 스캔이 없으면 record를 잃은
   * 이벤트는 조정 루프(records만 순회)의 시야 밖으로 영구히 빠진다.
   *
   * @returns 이번에 새로 주운 id 집합. 호출부는 이 id들을 같은 run에서 삭제하지 않는다.
   */
  async rebuildRecords(
    lookbackDays = 730,
    lookaheadDays = 730
  ): Promise<Set<string>> {
    const adopted = new Set<string>();
    const timeMin = isoDaysAgo(lookbackDays);
    const timeMax = isoDaysAgo(-lookaheadDays);
    let complete = true;
    for (const cal of this.knownCalendarIds()) {
      let items: GCalEvent[];
      try {
        ({ items } = await this.client.listEvents(cal, {
          singleEvents: "true",
          showDeleted: "false",
          maxResults: "2500",
          timeMin,
          timeMax,
        }));
      } catch (e) {
        console.warn("[tasks-gcal-sync] 재구성 스캔 실패:", cal, e);
        complete = false; // 한 캘린더라도 못 읽었으면 "훑었다" 고 기록하지 않는다
        continue;
      }
      for (const ev of items) {
        const tid = ev.extendedProperties?.private?.tgsTaskId;
        if (!tid || ev.status === "cancelled") continue;
        if (!isOurs(this.codec, ev)) continue; // 다른 볼트의 이벤트 — 입양하면 지워버린다
        if (this.state.records[tid]) continue; // 이미 알고 있음
        const rec = recordFromEventOnly(this.codec, ev, cal);
        if (!rec) continue;
        this.state.records[tid] = rec;
        adopted.add(tid);
      }
    }
    if (complete) this.state.lastFullScanAt = Date.now();
    if (adopted.size) {
      console.log(`[tasks-gcal-sync] records 재구성: ${adopted.size}건 복원`);
    }
    return adopted;
  }

  /** 캘린더의 변경분/삭제를 syncToken 증분으로 가져옴. */
  async pullCalendar(cal: string): Promise<CalPull> {
    const tokens = this.state.syncTokens;
    const base: Record<string, string> = {
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    };
    let res;
    try {
      const params = tokens[cal]
        ? { ...base, syncToken: tokens[cal] }
        : { ...base, timeMin: isoDaysAgo(30) };
      res = await this.client.listEvents(cal, params);
    } catch (e: any) {
      if (e?.gone) {
        delete tokens[cal];
        res = await this.client.listEvents(cal, { ...base, timeMin: isoDaysAgo(30) });
      } else throw e;
    }
    if (res.nextSyncToken) tokens[cal] = res.nextSyncToken;

    const byTaskId = new Map<string, GCalEvent>();
    const cancelledEventIds = new Set<string>();
    for (const ev of res.items) {
      if (ev.status === "cancelled") {
        if (ev.id) cancelledEventIds.add(ev.id);
        continue;
      }
      const tid = ev.extendedProperties?.private?.tgsTaskId;
      if (tid && isOurs(this.codec, ev)) byTaskId.set(tid, ev);
    }
    return { byTaskId, cancelledEventIds };
  }

  /** record 가 있는 캘린더를 전부 증분 pull 한다. 실패한 캘린더는 FAIL 항목과 함께 따로 모은다. */
  async pullAll(records: Record<string, SyncRecord>, result: SyncResult): Promise<PullAll> {
    const pullByCal = new Map<string, CalPull>();
    const pullFailedCals = new Set<string>();
    let pullOk = true;
    const calIds = new Set<string>();
    for (const id of Object.keys(records)) calIds.add(records[id].calendarId);
    for (const cal of calIds) {
      try {
        pullByCal.set(cal, await this.pullCalendar(cal));
      } catch (e) {
        console.error("[tasks-gcal-sync] pull 실패:", cal, e);
        addFailure(result, `pull ${cal}`, e);
        result.entries.push({
          action: "FAIL",
          calendar: calName(this.settings, cal),
          detail: `캘린더를 읽지 못함 → 이 캘린더의 record 는 이번 run 에서 손대지 않는다: ${errMsg(e)}`,
        });
        pullFailedCals.add(cal);
        pullOk = false; // 한 캘린더라도 못 읽었으면 콜드 스타트 잠금을 풀지 않는다
      }
    }
    return { pullByCal, pullFailedCals, pullOk };
  }

  /**
   * ★★ **보류한 원격 관측을 되살린다**(0.9.4). 델타에 없는 보류 record 의 이벤트를 직접 조회한다.
   * 404/410 도 관측이다(이미 지워짐 → 미일정화 경로가 받는다). 그 밖의 실패는 관측 없음으로 둔다.
   */
  async recheckRemote(
    rec: SyncRecord,
    id: string
  ): Promise<{ ev?: GCalEvent; cancelled: boolean }> {
    try {
      const fetched = await this.client.getEvent(rec.calendarId, rec.eventId);
      if (fetched?.status === "cancelled") return { cancelled: true };
      if (fetched) return { ev: fetched, cancelled: false };
    } catch (e) {
      // 404/410 = 이미 지워졌다. 그것도 관측이다(미일정화 경로가 받는다).
      if (/\b(404|410)\b/.test(errMsg(e))) {
        return { cancelled: true };
      }
      console.warn("[tasks-gcal-sync] 보류 record 재조회 실패:", id, e);
    }
    return { cancelled: false };
  }
}
