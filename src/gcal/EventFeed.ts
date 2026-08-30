import { CalendarClient, GCalEvent } from "./CalendarClient";
import { FeedCalendar } from "../settings/Settings";
import { ExternalEvent, FeedCalendarInfo, GcalReadApi } from "../api/PublicApi";
import {
  isStale,
  mergeBuckets,
  monthKeysFor,
  toExternalEvent,
  windowForMonthKey,
} from "./externalEvent";

/** 신선한 버킷은 다시 받지 않는다. */
const TTL_MS = 5 * 60 * 1000;
/** 실패한 버킷은 짧게만 기억한다 — 죽은 캘린더를 페이지 넘길 때마다 때리지 않으려고. */
const FAIL_TTL_MS = 60 * 1000;

interface Bucket {
  events: ExternalEvent[];
  fetchedAt: number; // 0 = 없음/무효
  ttl: number;
  inFlight: Promise<void> | null;
}

/**
 * 캘린더 뷰에 그릴 **외부 일정**을 받아와 메모리에 캐시한다.
 *
 * ⛔ **`PersistedState` 를 일부러 받지 않는다.** `syncTokens` 는 동기화 엔진의 증분
 * 커서이고, 표시용 소비자가 그걸 공유하거나 무효화하면 그 자리에서 동기화가 망가진다.
 * 주석이 아니라 **생성자에 인자가 없다는 사실**이 그 제약의 집행 수단이다.
 *
 * 캐시를 디스크에 남기지 않는 이유가 둘 있다. (a) `data.json` 은 기기 간에 오가며 파일
 * 단위 LWW 대상이다. (b) localStorage 는 기기-로컬이라 합법이지만 남의 회의 제목·장소가
 * 평문으로 남고, 재시작 후 첫 페치 전까지 **이미 삭제된 회의**를 그린다. 얻는 건 재시작
 * 직후 한 번의 즉시 페인트뿐이라 맞바꿈이 안 맞는다.
 */
export class EventFeed implements GcalReadApi {
  readonly version = 1 as const;

  private buckets = new Map<string, Bucket>();
  private listeners = new Set<() => void>();

  constructor(
    private client: CalendarClient,
    private getCalendars: () => FeedCalendar[],
    private isAuthed: () => boolean
  ) {}

  // ─────────────────────────────── 공개 API ───────────────────────────────

  isReady(): boolean {
    try {
      return this.isAuthed() && this.getCalendars().length > 0;
    } catch {
      return false;
    }
  }

  listSelectedCalendars(): FeedCalendarInfo[] {
    try {
      return this.getCalendars().map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
      }));
    } catch {
      return [];
    }
  }

  peekEvents(fromISO: string, toISO: string): ExternalEvent[] {
    try {
      if (!this.isReady()) return [];
      const cals = this.getCalendars();
      const keys = monthKeysFor(fromISO, toISO);
      const lists: ExternalEvent[][] = [];
      for (const cal of cals) {
        for (const k of keys) {
          const b = this.buckets.get(bucketKey(cal.id, k));
          if (b && b.fetchedAt) lists.push(b.events);
        }
      }
      return mergeBuckets(lists, fromISO, toISO);
    } catch (e) {
      console.debug("[tasks-gcal-sync] peekEvents 실패 → 빈 목록", e);
      return [];
    }
  }

  /**
   * 부족하거나 낡은 버킷을 채운다. **reject 하지 않는다.**
   *
   * 버킷을 순차로 받는다 — `Promise.all` 로 묶으면 캘린더 4개 × 월 3개가 한꺼번에
   * 12-wide 버스트가 되어 쿼터를 때린다. 보류 중에도 `peek` 은 낡은 사본을 계속 주므로
   * 화면이 비지 않는다(stale-while-revalidate).
   */
  async requestEvents(fromISO: string, toISO: string): Promise<void> {
    try {
      if (!this.isReady()) return;
      const cals = this.getCalendars();
      const keys = monthKeysFor(fromISO, toISO);
      const now = Date.now();
      let changed = false;
      for (const cal of cals) {
        for (const k of keys) {
          const bk = bucketKey(cal.id, k);
          const b = this.buckets.get(bk);
          if (b?.inFlight) {
            await b.inFlight; // 같은 버킷을 두 위젯이 요청해도 호출은 한 번
            continue;
          }
          if (b && !isStale(b.fetchedAt, now, b.ttl)) continue;
          if (await this.fillBucket(cal, k, bk)) changed = true;
        }
      }
      if (changed) this.emit();
    } catch (e) {
      console.debug("[tasks-gcal-sync] requestEvents 실패", e);
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ─────────────────────────────── 내부 ───────────────────────────────

  /** 받아온 게 있으면 true. 실패해도 예외를 밖으로 내지 않는다. */
  private async fillBucket(
    cal: FeedCalendar,
    key: string,
    bk: string
  ): Promise<boolean> {
    const prev = this.buckets.get(bk);
    let ok = false;
    const p = (async () => {
      const { timeMin, timeMax } = windowForMonthKey(key);
      // syncToken 은 절대 넣지 않는다 (위 클래스 주석 참고)
      const { items } = await this.client.listEvents(cal.id, {
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "2500",
        timeMin,
        timeMax,
      });
      const events: ExternalEvent[] = [];
      for (const ev of items as GCalEvent[]) {
        const e = toExternalEvent(ev, cal);
        if (e) events.push(e);
      }
      this.buckets.set(bk, {
        events,
        fetchedAt: Date.now(),
        ttl: TTL_MS,
        inFlight: null,
      });
      ok = true;
    })().catch((e) => {
      console.debug(`[tasks-gcal-sync] 일정 조회 실패: ${cal.name} ${key}`, e);
      // 있던 것을 지우지 않는다 — 빈 화면보다 낡은 화면이 낫다
      this.buckets.set(bk, {
        events: prev?.events ?? [],
        fetchedAt: Date.now(),
        ttl: FAIL_TTL_MS,
        inFlight: null,
      });
    });

    this.buckets.set(bk, {
      events: prev?.events ?? [],
      fetchedAt: prev?.fetchedAt ?? 0,
      ttl: prev?.ttl ?? TTL_MS,
      inFlight: p,
    });
    await p;
    return ok;
  }

  /**
   * 전 버킷을 무효화한다(네트워크 0). 동기화 run 이 끝난 직후에 부른다 — 방금 Google 과
   * 이야기했으니 뭔가 바뀌었을 수 있다.
   */
  invalidateAll(): void {
    for (const [k, b] of this.buckets) {
      this.buckets.set(k, { ...b, fetchedAt: 0 });
    }
    this.emit();
  }

  /** 설정에서 캘린더를 껐다 켰을 때. 그 캘린더 버킷만 버린다. */
  dropUnselected(): void {
    const live = new Set(this.getCalendars().map((c) => c.id));
    for (const k of [...this.buckets.keys()]) {
      if (!live.has(k.slice(0, k.lastIndexOf(SEP)))) this.buckets.delete(k);
    }
    this.emit();
  }

  unload(): void {
    this.buckets.clear();
    this.listeners.clear();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        console.debug("[tasks-gcal-sync] onChange 구독자 오류", e);
      }
    }
  }
}

/** 캘린더 id 는 이메일 주소라 무엇이든 들어갈 수 있다. 눈에 안 보이는 구분자를 쓴다. */
const SEP = String.fromCharCode(0);

function bucketKey(calendarId: string, monthKey: string): string {
  return calendarId + SEP + monthKey;
}
