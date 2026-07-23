import { requestUrl } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface GCalEvent {
  id?: string;
  summary?: string;
  description?: string;
  colorId?: string | null; // 1~11 (Google 이벤트 색). null=색 제거(기본색 복귀).
  transparency?: string; // "opaque"=busy(바쁨, 기본) | "transparent"=free(한가함)
  status?: string; // "confirmed" | "cancelled"
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY = 3;

export class CalendarClient {
  constructor(private auth: GoogleAuth) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** requestUrl + 일시 오류(429/5xx) 지수 백오프 재시도. */
  private async fetchWithRetry(opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<any> {
    let lastResp: any;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      lastResp = await requestUrl({ ...opts, throw: false });
      if (!TRANSIENT.has(lastResp.status)) return lastResp;
      if (attempt < MAX_RETRY) {
        const wait = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.warn(
          `[tasks-gcal-sync] GCal ${lastResp.status} 재시도 ${attempt + 1}/${MAX_RETRY} (${wait}ms)`
        );
        await this.sleep(wait);
      }
    }
    return lastResp;
  }

  private async req(url: string, method: string, body?: unknown): Promise<any> {
    const token = await this.auth.getAccessToken();
    const resp = await this.fetchWithRetry({
      url,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 204) return null;
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`GCal ${method} ${resp.status}: ${resp.text}`);
    }
    return resp.json;
  }

  async listCalendars(): Promise<CalendarListEntry[]> {
    const j = await this.req(`${BASE}/users/me/calendarList`, "GET");
    return (j.items ?? []).map((c: any) => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary,
      accessRole: c.accessRole,
    }));
  }

  getEvent(calendarId: string, eventId: string): Promise<GCalEvent> {
    return this.req(
      `${BASE}/calendars/${encodeURIComponent(
        calendarId
      )}/events/${encodeURIComponent(eventId)}`,
      "GET"
    );
  }

  insertEvent(calendarId: string, event: GCalEvent): Promise<GCalEvent> {
    return this.req(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      "POST",
      event
    );
  }

  patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<GCalEvent>
  ): Promise<GCalEvent> {
    return this.req(
      `${BASE}/calendars/${encodeURIComponent(
        calendarId
      )}/events/${encodeURIComponent(eventId)}`,
      "PATCH",
      patch
    );
  }

  /**
   * 이벤트 목록(증분 동기화 지원). params에 syncToken 또는 timeMin을 넣는다.
   * 페이지네이션 처리 후 {items, nextSyncToken} 반환.
   * syncToken 만료(410) 시 .gone=true 에러를 던진다.
   */
  async listEvents(
    calendarId: string,
    params: Record<string, string>
  ): Promise<{ items: GCalEvent[]; nextSyncToken?: string }> {
    const items: GCalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const q = new URLSearchParams(params);
      if (pageToken) q.set("pageToken", pageToken);
      const token = await this.auth.getAccessToken();
      const resp = await this.fetchWithRetry({
        url: `${BASE}/calendars/${encodeURIComponent(
          calendarId
        )}/events?${q.toString()}`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 410) {
        const e: any = new Error("sync token expired");
        e.gone = true;
        throw e;
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`GCal list ${resp.status}: ${resp.text}`);
      }
      const j = resp.json;
      if (j.items) items.push(...j.items);
      pageToken = j.nextPageToken;
      if (j.nextSyncToken) nextSyncToken = j.nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  /**
   * tgsTaskId(우리 plugin이 모든 이벤트에 심는 private 확장속성)로 이벤트 조회.
   * 같은 task의 (중복 포함) 살아있는 모든 이벤트를 반환 → 멀티기기 중복 감지/정리용.
   */
  async findByTaskId(calendarId: string, taskId: string): Promise<GCalEvent[]> {
    const { items } = await this.listEvents(calendarId, {
      privateExtendedProperty: `tgsTaskId=${taskId}`,
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "50",
    });
    return items.filter((e) => e.status !== "cancelled" && e.id);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.req(
      `${BASE}/calendars/${encodeURIComponent(
        calendarId
      )}/events/${encodeURIComponent(eventId)}`,
      "DELETE"
    );
  }
}
