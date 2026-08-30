/**
 * 다른 플러그인이 쓰는 **공개 계약**. 지금 소비자는 `gcal-calendar-view` 하나다.
 *
 * 한 번 나간 모양은 없애지 않는다 — 뷰 플러그인은 BRAT 로 따로 갱신되므로 두 버전이
 * 섞여 도는 구간이 반드시 생긴다. 모양을 바꿔야 하면 `version` 을 올리고, 뷰는 계속
 * 덕 타이핑으로 호출한다.
 *
 * 설계의 핵심은 **동기 `peekEvents` + 던지고 잊는 `requestEvents` + `onChange`** 셋으로
 * 쪼갠 것이다. 뷰의 `renderNow()` 는 동기 함수라 await 할 수 없고, 기다리게 만들면
 * task 막대가 네트워크 뒤에 갇힌다(fail-closed). 이 형태라야 **task 는 언제나 즉시**
 * 그려지고 일정은 도착하는 대로 얹힌다.
 */

export interface ExternalEvent {
  /** `${calendarId}\u0000${eventId}` — 안정 식별자. 뷰의 레인 메모 키로도 쓴다 */
  readonly uid: string;
  readonly calendarId: string;
  readonly calendarName: string;
  /** "#rrggbb" — 플러그인 설정의 로컬 값. Google 의 colorId 가 아니다 */
  readonly color: string;
  readonly title: string;
  /** YYYY-MM-DD, 로컬 */
  readonly startISO: string;
  /** YYYY-MM-DD, 로컬, **포함(inclusive)**. GCal 의 배타적 end.date 를 변환한 값 */
  readonly endISO: string;
  /** 자정부터의 분. null = 종일 */
  readonly tStart: number | null;
  readonly tEnd: number | null;
  readonly allDay: boolean;
  readonly multiDay: boolean;
  /** 반복 일정의 한 회차인가. 뷰가 🔁 아이콘을 붙이는 근거 */
  readonly recurring: boolean;
  readonly location?: string;
  readonly htmlLink?: string;
}

export interface FeedCalendarInfo {
  id: string;
  name: string;
  color: string;
}

export interface GcalReadApi {
  readonly version: 1;

  /** 지금 일정을 줄 수 있는가(인증됨 + 고른 캘린더 1개 이상). **절대 throw 하지 않는다** */
  isReady(): boolean;

  /** 설정에서 고른 캘린더들. 뷰가 색·이름을 쓰거나 필터 칩을 그릴 때 */
  listSelectedCalendars(): FeedCalendarInfo[];

  /**
   * 캐시만 읽는 **동기** 조회. 네트워크를 타지 않고, 없으면 빈 배열이다.
   * 렌더 루프에서 매번 불려도 공짜여야 하므로 절대 throw 하지 않는다.
   */
  peekEvents(fromISO: string, toISO: string): ExternalEvent[];

  /**
   * 비었거나 낡은 구간을 배경에서 채운다. **실패해도 resolve 한다**(reject 안 함) —
   * 호출부가 catch 를 잊어도 unhandled rejection 이 나면 안 된다.
   */
  requestEvents(fromISO: string, toISO: string): Promise<void>;

  /** 캐시가 바뀌면 알린다. 반환값은 구독 해제 함수 */
  onChange(cb: () => void): () => void;
}
