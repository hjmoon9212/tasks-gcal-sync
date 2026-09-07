import { CalendarClient, GCalEvent } from "./CalendarClient";
import { FeedCalendar } from "../settings/Settings";
import { ExternalEvent, FeedCalendarInfo, GcalReadApi } from "../api/PublicApi";
import {
  eventsSignature,
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
/**
 * 기억할 창의 최대 개수. 시간이 아니라 **개수**로 끊는다 (v0.8.2).
 *
 * 예전엔 30분간 요청이 없던 창을 잊었다. 그런데 뷰는 **자기 캐시가 맞는 동안 우리를
 * 부르지 않는다** — 즉 "뷰가 안 물어봤다" 는 "뷰가 안 보고 있다" 의 근거가 못 된다.
 * 조용한 30분이 한 번 지나가면 창이 사라지고 → 창이 없으니 폴링이 멈추고 → 폴링이
 * 멈추니 달라질 일이 없고 → 달라진 게 없으니 뷰의 캐시도 영영 유효하다. 서로 물린 채
 * 영구 정지한다. 2026-09-07 에 GCal 에서 지운 일정이 **재시작 전까지** 화면에 남았다.
 *
 * 창을 잊는 진짜 근거는 **구독자가 0명인 것**이고(노트를 닫으면 그렇게 된다), 그건
 * refreshTracked 첫 줄이 이미 본다. 여기서는 "열어 둔 채 여러 달을 돌아다닌" 옛 창이
 * 무한히 쌓이는 것만 개수로 끊으면 된다.
 */
const MAX_WINDOWS = 4;

interface Bucket {
  events: ExternalEvent[];
  fetchedAt: number; // 0 = 한 번도 못 받아옴
  ttl: number;
  inFlight: Promise<void> | null;
}

/** 뷰가 실제로 그리고 있는 구간. 주기 갱신이 무엇을 다시 받을지의 근거다. */
interface TrackedWindow {
  from: string;
  to: string;
  at: number;
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
 *
 * ## 화면은 절대 비우지 않는다 (v0.7.3)
 *
 * 예전 `invalidateAll()` 은 버킷의 `fetchedAt` 을 0으로 만들었다. `peekEvents` 의 게이트가
 * 바로 그 `fetchedAt` 이라, 무효화는 `events` 를 **보존하면서 동시에 도달 불가능하게**
 * 만들었다 — 동기화 run 이 끝날 때마다 일정 막대가 전부 사라졌다가 재조회가 다 끝난 뒤에야
 * 돌아왔다. 지금은 버킷을 건드리는 무효화가 없다. 다시 받아야 할 때는 `force` 로 신선도
 * 검사만 건너뛰고, 새 데이터가 도착하는 순간 통째로 교체한다. `peek` 은 그 사이 내내 낡은
 * 사본을 준다(모든 경로에서 stale-while-revalidate).
 */
export class EventFeed implements GcalReadApi {
  readonly version = 1 as const;

  /**
   * 마지막 조회 묶음에서 난 실패. 없으면 null.
   *
   * 낡은 사본을 계속 내주는 설계라, 실패가 **화면에는 전혀 안 보인다.** 수동 새로
   * 고침이 이걸 읽어 사용자에게 말한다.
   */
  lastError: string | null = null;

  private buckets = new Map<string, Bucket>();
  private listeners = new Set<() => void>();
  private windows = new Map<string, TrackedWindow>();

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
   * 12-wide 버스트가 되어 쿼터를 때린다. 받는 동안에도 `peek` 은 낡은 사본을 계속 주므로
   * 화면이 비지 않는다(stale-while-revalidate).
   *
   * 부르는 것만으로 "뷰가 이 구간을 보고 있다" 는 뜻이 되어 주기 갱신 대상에 등록된다.
   */
  async requestEvents(
    fromISO: string,
    toISO: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    this.trackWindow(fromISO, toISO);
    await this.fetchWindow(fromISO, toISO, opts);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ─────────────────────────────── 갱신 ───────────────────────────────

  /**
   * 뷰가 보고 있는 구간을 **강제로** 다시 받아본다. 주기 타이머와 수동 새로 고침이 쓴다.
   *
   * 자체 `emit` 이 없다는 게 핵심이다 — 아직 아무것도 안 바뀐 시점에 알리면 뷰가 헛으로
   * DOM 을 통째 교체한다. 정말 달라졌을 때만 `fetchWindow` 안에서 알린다.
   */
  async refreshAll(): Promise<void> {
    // ⛔ **절대 무동작이 되면 안 된다** (v0.8.2). 예전엔 이게 refreshTracked 한 줄이었고,
    // 그건 구독자가 0명이면 창을 비우고 그냥 돌아온다. 그래서 캘린더 노트를 닫아 둔 채
    // 수동 동기화를 누르면 일정은 **하나도** 갱신되지 않았다 — 사람이 "지금 맞춰라" 라고
    // 누른 것인데 아무 일도 안 일어났다. 가진 것은 전부 다시 받는다.
    const keys = new Set<string>();
    for (const w of this.windows.values()) {
      for (const k of monthKeysFor(w.from, w.to)) keys.add(k);
    }
    for (const bk of this.buckets.keys()) {
      keys.add(bk.slice(bk.lastIndexOf(SEP) + 1));
    }
    await this.fetchKeys([...keys], { force: true });
  }

  /** 기억해 둔 창들을 순차로 다시 받는다. 보는 사람이 없으면 아무것도 하지 않는다. */
  async refreshTracked(opts?: { force?: boolean }): Promise<void> {
    if (this.listeners.size === 0) {
      // 열린 캘린더가 하나도 없다 — 폴링할 이유도, 창을 기억할 이유도 없다
      this.windows.clear();
      return;
    }
    for (const w of [...this.windows.values()]) {
      await this.fetchWindow(w.from, w.to, opts);
    }
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
    this.windows.clear();
  }

  // ─────────────────────────────── 내부 ───────────────────────────────

  private trackWindow(fromISO: string, toISO: string): void {
    const k = fromISO + "|" + toISO;
    // 지웠다 넣어 Map 삽입 순서를 최근순으로 만든다 → 넘칠 때 가장 오래된 것부터 나간다
    this.windows.delete(k);
    this.windows.set(k, { from: fromISO, to: toISO, at: Date.now() });
    while (this.windows.size > MAX_WINDOWS) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  private async fetchWindow(
    fromISO: string,
    toISO: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    await this.fetchKeys(monthKeysFor(fromISO, toISO), opts);
  }

  /** 월 키 목록을 채운다. 창이든 이미 들고 있는 버킷이든 여기로 모인다. */
  private async fetchKeys(
    keys: string[],
    opts?: { force?: boolean }
  ): Promise<void> {
    try {
      if (!this.isReady()) return;
      const cals = this.getCalendars();
      const now = Date.now();
      this.lastError = null;
      let changed = false;
      for (const cal of cals) {
        for (const k of keys) {
          const bk = bucketKey(cal.id, k);
          const b = this.buckets.get(bk);
          if (b?.inFlight) {
            await b.inFlight; // 같은 버킷을 두 위젯이 요청해도 호출은 한 번
            continue;
          }
          if (b && !opts?.force && !isStale(b.fetchedAt, now, b.ttl)) continue;
          if (await this.fillBucket(cal, k, bk)) changed = true;
        }
      }
      if (changed) this.emit();
    } catch (e) {
      console.debug("[tasks-gcal-sync] requestEvents 실패", e);
    }
  }

  /**
   * 받아온 내용이 **이전과 다르면** true. 실패해도 예외를 밖으로 내지 않는다.
   *
   * "받아왔다" 가 아니라 "달라졌다" 인 게 중요하다 — 주기 갱신 대부분은 같은 목록을
   * 받아오고, 그때마다 알리면 뷰가 공짜로 전체 재렌더를 한다.
   */
  private async fillBucket(
    cal: FeedCalendar,
    key: string,
    bk: string
  ): Promise<boolean> {
    const prev = this.buckets.get(bk);
    let changed = false;
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
      // 한 번도 못 받아온 버킷이면 목록이 비어 있어도 "달라졌다" — 그래야 첫 페인트가 온다
      changed =
        !prev?.fetchedAt ||
        eventsSignature(events) !== eventsSignature(prev.events);
      this.buckets.set(bk, {
        events,
        fetchedAt: Date.now(),
        ttl: TTL_MS,
        inFlight: null,
      });
    })().catch((e) => {
      // debug 가 아니라 warn 이다. 이게 조용히 반복되면 화면은 **낡은 채로 멀쩡해 보인다** —
      // 빈 화면보다 낡은 화면이 낫다는 판단의 대가이고, 그 대가는 눈에 보여야 값을 한다.
      this.lastError = `${cal.name} ${key}: ${(e as Error)?.message ?? String(e)}`;
      console.warn(`[tasks-gcal-sync] 일정 조회 실패: ${cal.name} ${key}`, e);
      // 있던 것을 지우지 않는다 — 빈 화면보다 낡은 화면이 낫다.
      // fetchedAt 은 **지금**으로 찍는다: FAIL_TTL 동안 죽은 캘린더를 다시 때리지 않기
      // 위한 백오프 기준이고, 동시에 peek 이 낡은 사본을 계속 내주는 근거이기도 하다.
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
    return changed;
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
