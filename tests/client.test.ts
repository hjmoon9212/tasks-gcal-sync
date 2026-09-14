/**
 * GCal HTTP 계층의 재시도 판정.
 *
 * 상태코드만으로는 못 가른다 — Google 은 **사용량 초과를 403 으로도** 준다. 권한 오류와
 * 같은 코드라, 재시도 대상을 잘못 잡으면 둘 중 하나가 망가진다: 사용량 초과를 안 재시도하면
 * 그 항목이 조용히 빠지고, 권한 오류를 재시도하면 매번 헛되이 늦어진다.
 */
import {
  backoffMs,
  isRetryable,
  CalendarClient,
  PreconditionFailedError,
} from "../src/gcal/CalendarClient";
import { GoogleAuth } from "../src/auth/GoogleAuth";
// 번들에선 "obsidian" 이 이 스텁으로 별칭된다(같은 모듈 인스턴스). tsc 는 실제 obsidian 타입을 보므로 경로로 직접 가져온다.
import { __setRequestUrl } from "./obsidian-stub";
import { eq, done } from "./helpers/assert";

const reason = (r: string) => `{"error":{"code":403,"errors":[{"reason":"${r}"}]}}`;

// ── 재시도 대상 ──
{
  for (const s of [429, 500, 502, 503, 504]) {
    eq(isRetryable(s, ""), true, `${s} 는 일시 오류`);
  }
  for (const s of [200, 400, 401, 404, 410, 412]) {
    eq(isRetryable(s, ""), false, `${s} 는 재시도 대상 아님`);
  }
}

// ── 403 은 본문의 reason 으로 가른다 ──
{
  for (const r of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
    eq(isRetryable(403, reason(r)), true, `403 ${r} → 재시도`);
  }
  for (const r of ["forbidden", "insufficientPermissions", "dailyLimitExceededUnreg"]) {
    eq(isRetryable(403, reason(r)), false, `403 ${r} → 재시도 안 함(권한 문제)`);
  }
  eq(isRetryable(403, ""), false, "본문을 못 읽으면 재시도하지 않는다");
  eq(
    isRetryable(403, '{"error":{"errors":[{"reason": "rateLimitExceeded"}]}}'),
    true,
    "공백이 있어도 매칭"
  );
}

// ── 백오프: 지수 + ±50% 지터 ──
{
  eq(backoffMs(0, undefined, 0), 500, "attempt 0 최소");
  eq(backoffMs(0, undefined, 1), 1500, "attempt 0 최대");
  eq(backoffMs(1, undefined, 0.5), 2000, "attempt 1 중앙값");
  eq(backoffMs(2, undefined, 0.5), 4000, "attempt 2 중앙값");
  // 지터가 실제로 값을 흩는가 — 없으면 재시도가 한꺼번에 깨어나 또 몰려간다
  eq(backoffMs(1, undefined, 0) !== backoffMs(1, undefined, 1), true, "지터가 값을 흩는다");
}

// ── Retry-After 가 오면 그걸 따른다 ──
{
  eq(backoffMs(0, "5"), 5000, "헤더 우선(초 단위)");
  eq(backoffMs(2, 3), 3000, "숫자로 와도 동작");
  eq(backoffMs(0, "3600"), 60_000, "상한 60초");
  eq(backoffMs(1, "0", 0.5), 2000, "0 이면 무시하고 백오프");
  eq(backoffMs(0, "not-a-number", 0.5), 1000, "숫자가 아니면 무시");
}

// ─────────────────────── CalendarClient — requestUrl 주입 (특성 고정) ───────────────────────
//
// 실제 네트워크는 없다. obsidian 스텁의 requestUrl 을 가짜로 바꾸고, 보낸 요청 모양과
// 응답 처리(204/412/4xx/410/404/페이지네이션/재시도)를 **지금 동작 그대로** 고정한다.

type Resp = { status: number; text?: string; json?: any; headers?: Record<string, string> };

const BASE = "https://www.googleapis.com/calendar/v3";

/** 응답 큐를 차례로 돌려주고, 받은 요청을 모두 기록한다. 큐가 비면 마지막 응답을 반복. */
function fakeHttp(responses: Resp[]) {
  const calls: any[] = [];
  let i = 0;
  __setRequestUrl(async (opts: any) => {
    calls.push(opts);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  });
  return calls;
}

function makeClient(token = "TOK") {
  let tokenCalls = 0;
  const auth = {
    async getAccessToken() {
      tokenCalls++;
      return token;
    },
  };
  return {
    client: new CalendarClient(auth as unknown as GoogleAuth),
    tokenCalls: () => tokenCalls,
  };
}

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

/** setTimeout 을 즉시 실행으로 바꾸고 요청된 지연을 기록한다. 콘솔 경고도 모은다. */
async function withFakeTimers<T>(
  fn: (delays: number[], warns: string[], errors: any[][]) => Promise<T>,
  rand = 0.5
): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  const realWarn = console.warn;
  const realError = console.error;
  const delays: number[] = [];
  const warns: string[] = [];
  const errors: any[][] = [];
  (globalThis as any).setTimeout = (cb: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    cb();
    return 0;
  };
  Math.random = () => rand;
  console.warn = (...a: any[]) => warns.push(a.map(String).join(" "));
  console.error = (...a: any[]) => errors.push(a);
  try {
    return await fn(delays, warns, errors);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    Math.random = realRandom;
    console.warn = realWarn;
    console.error = realError;
  }
}

(async () => {
  // ── listCalendars: URL · 헤더 · 매핑 ──
  {
    const calls = fakeHttp([
      {
        status: 200,
        json: {
          items: [
            {
              id: "a@x.com",
              summary: "A",
              primary: true,
              accessRole: "owner",
              backgroundColor: "#112233",
              extra: "dropped",
            },
            { id: "b@x.com", summary: "B" },
          ],
        },
      },
    ]);
    const { client, tokenCalls } = makeClient("TOK1");
    const cals = await client.listCalendars();
    eq(calls.length, 1, "listCalendars: 요청 1회");
    eq(
      calls[0],
      {
        url: `${BASE}/users/me/calendarList`,
        method: "GET",
        headers: { Authorization: "Bearer TOK1", "Content-Type": "application/json" },
        throw: false,
      },
      "listCalendars: 요청 모양(body 없음, throw:false)"
    );
    eq("body" in calls[0], true, "listCalendars: body 키는 있고 값이 undefined");
    eq(calls[0].body, undefined, "listCalendars: body 는 undefined");
    eq(tokenCalls(), 1, "listCalendars: 토큰은 요청마다 한 번");
    eq(
      cals,
      [
        { id: "a@x.com", summary: "A", primary: true, accessRole: "owner", backgroundColor: "#112233" },
        { id: "b@x.com", summary: "B" },
      ],
      "listCalendars: 5개 필드만 옮긴다(undefined 는 JSON 에서 빠짐)"
    );
    eq(Object.keys(cals[1]), ["id", "summary", "primary", "accessRole", "backgroundColor"], "listCalendars: 키는 항상 5개");
  }
  {
    fakeHttp([{ status: 200, json: {} }]);
    const { client } = makeClient();
    eq(await client.listCalendars(), [], "listCalendars: items 없으면 빈 배열");
  }

  // ── getEvent: id 인코딩 ──
  {
    const calls = fakeHttp([{ status: 200, json: { id: "e1", summary: "S" } }]);
    const { client } = makeClient();
    const got = await client.getEvent("me@x.com", "ev/1 a");
    eq(
      calls[0].url,
      `${BASE}/calendars/me%40x.com/events/ev%2F1%20a`,
      "getEvent: calendarId·eventId 모두 encodeURIComponent"
    );
    eq(calls[0].method, "GET", "getEvent: GET");
    eq(calls[0].headers, { Authorization: "Bearer TOK", "Content-Type": "application/json" }, "getEvent: If-Match 없음");
    eq(got, { id: "e1", summary: "S" }, "getEvent: resp.json 그대로");
  }

  // ── insertEvent: POST + JSON 본문 ──
  {
    const calls = fakeHttp([{ status: 200, json: { id: "new1" } }]);
    const { client } = makeClient();
    const body = { summary: "T", start: { date: "2026-08-06" }, end: { date: "2026-08-07" } };
    const got = await client.insertEvent("primary", body);
    eq(
      calls[0],
      {
        url: `${BASE}/calendars/primary/events`,
        method: "POST",
        headers: { Authorization: "Bearer TOK", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        throw: false,
      },
      "insertEvent: 요청 모양"
    );
    eq(typeof calls[0].body, "string", "insertEvent: body 는 문자열(JSON)");
    eq("contentType" in calls[0], false, "insertEvent: contentType 옵션은 안 쓰고 헤더로 보낸다");
    eq(got, { id: "new1" }, "insertEvent: resp.json 반환");
  }

  // ── patchEvent: If-Match ──
  {
    const calls = fakeHttp([{ status: 200, json: { id: "e1" } }]);
    const { client } = makeClient();
    await client.patchEvent("c@x.com", "e1", { summary: "X", colorId: null }, '"etag-123"');
    eq(
      calls[0],
      {
        url: `${BASE}/calendars/c%40x.com/events/e1`,
        method: "PATCH",
        headers: {
          Authorization: "Bearer TOK",
          "Content-Type": "application/json",
          "If-Match": '"etag-123"',
        },
        body: '{"summary":"X","colorId":null}',
        throw: false,
      },
      "patchEvent: etag 가 있으면 If-Match 헤더, null 은 본문에 보존"
    );
  }
  {
    const calls = fakeHttp([{ status: 200, json: { id: "e1" } }]);
    const { client } = makeClient();
    await client.patchEvent("c", "e1", { summary: "X" });
    eq("If-Match" in calls[0].headers, false, "patchEvent: etag 없으면 If-Match 없음");
    await client.patchEvent("c", "e1", { summary: "X" }, "");
    eq("If-Match" in calls[1].headers, false, "patchEvent: 빈 문자열 etag 도 If-Match 없음(falsy)");
  }

  // ── 204 / 빈 본문 ──
  {
    fakeHttp([{ status: 204, text: "" }]);
    const { client } = makeClient();
    eq(await client.patchEvent("c", "e", {}), null, "204 → null");
  }
  {
    fakeHttp([{ status: 200, text: "" }]);
    const { client } = makeClient();
    eq(await client.getEvent("c", "e"), undefined, "200 인데 json 없음 → undefined(resp.json 그대로)");
  }

  // ── 412 → PreconditionFailedError ──
  {
    const calls = fakeHttp([{ status: 412, text: "Precondition Failed" }]);
    const { client } = makeClient();
    const err = await withFakeTimers(async () =>
      rejection(client.patchEvent("c@x.com", "e1", { summary: "X" }, "E"))
    );
    eq(err instanceof PreconditionFailedError, true, "412 → PreconditionFailedError");
    eq(err instanceof Error, true, "412 에러도 Error");
    eq(err.name, "PreconditionFailedError", "412 name");
    eq(err.precondition, true, "412 precondition 플래그");
    eq(
      err.message,
      `GCal 412 (pull 이후 원격이 또 바뀜): ${BASE}/calendars/c%40x.com/events/e1`,
      "412 메시지 형식(URL 포함)"
    );
    eq(calls.length, 1, "412 는 재시도하지 않는다");
  }

  // ── 4xx/5xx 에러 메시지 ──
  {
    fakeHttp([{ status: 400, text: '{"error":"bad"}' }]);
    const { client } = makeClient();
    const { err, errors } = await withFakeTimers(async (_d, _w, errors) => ({
      err: await rejection(client.insertEvent("c", { summary: "B" })),
      errors,
    }));
    eq(err.message, 'GCal POST 400: {"error":"bad"}', "4xx 메시지: `GCal <METHOD> <status>: <text>`");
    eq(errors.length, 1, "4xx + 본문 있음 → console.error 한 번");
    eq(errors[0], ["[tasks-gcal-sync] GCal POST 400 요청 본문:", '{"summary":"B"}'], "4xx 진단 로그 모양");
  }
  {
    fakeHttp([{ status: 404, text: "Not Found" }]);
    const { client } = makeClient();
    const { err, errors } = await withFakeTimers(async (_d, _w, errors) => ({
      err: await rejection(client.getEvent("c", "e")),
      errors,
    }));
    eq(err.message, "GCal GET 404: Not Found", "GET 404 메시지");
    eq(errors.length, 0, "본문 없는 요청(GET)은 진단 로그 없음");
  }
  {
    fakeHttp([{ status: 404 }]);
    const { client } = makeClient();
    const err = await rejection(client.getEvent("c", "e"));
    eq(err.message, "GCal GET 404: undefined", "text 가 없으면 메시지에 'undefined' 가 박힌다");
  }
  {
    fakeHttp([{ status: 301, text: "moved" }]);
    const { client } = makeClient();
    const err = await rejection(client.getEvent("c", "e"));
    eq(err.message, "GCal GET 301: moved", "3xx 도 같은 에러 경로");
  }
  {
    fakeHttp([{ status: 403, text: '{"reason":"forbidden"}' }]);
    const { client } = makeClient();
    const err = await withFakeTimers(async () => rejection(client.patchEvent("c", "e", { a: 1 } as any)));
    eq(err.message, 'GCal PATCH 403: {"reason":"forbidden"}', "403 권한 오류는 즉시 던진다");
  }

  // ── listEvents: 쿼리 · 페이지네이션 ──
  {
    const calls = fakeHttp([
      { status: 200, json: { items: [{ id: "1" }, { id: "2" }], nextPageToken: "P2" } },
      { status: 200, json: { nextPageToken: "P3" } },
      { status: 200, json: { items: [{ id: "3" }], nextSyncToken: "SYNC" } },
    ]);
    const { client, tokenCalls } = makeClient();
    const r = await client.listEvents("me@x.com", { timeMin: "2026-01-01T00:00:00Z", singleEvents: "true" });
    eq(calls.length, 3, "listEvents: nextPageToken 이 없어질 때까지 반복");
    eq(
      calls[0],
      {
        url: `${BASE}/calendars/me%40x.com/events?timeMin=2026-01-01T00%3A00%3A00Z&singleEvents=true`,
        method: "GET",
        headers: { Authorization: "Bearer TOK" },
        throw: false,
      },
      "listEvents: 첫 요청 — Content-Type 없음, body 키 없음"
    );
    eq("body" in calls[0], false, "listEvents: body 키 자체가 없다");
    eq(
      calls[1].url,
      `${BASE}/calendars/me%40x.com/events?timeMin=2026-01-01T00%3A00%3A00Z&singleEvents=true&pageToken=P2`,
      "listEvents: pageToken 은 뒤에 붙는다"
    );
    eq(calls[2].url.endsWith("&pageToken=P3"), true, "listEvents: 세 번째 페이지 토큰");
    eq(tokenCalls(), 3, "listEvents: 페이지마다 토큰을 다시 얻는다");
    eq(r, { items: [{ id: "1" }, { id: "2" }, { id: "3" }], nextSyncToken: "SYNC" }, "listEvents: items 이어붙이고 nextSyncToken 반환");
  }
  {
    fakeHttp([
      { status: 200, json: { items: [], nextSyncToken: "S1", nextPageToken: "P" } },
      { status: 200, json: { items: [] } },
    ]);
    const { client } = makeClient();
    const r = await client.listEvents("c", {});
    eq(r.nextSyncToken, "S1", "listEvents: 뒤 페이지에 없으면 앞에서 본 nextSyncToken 유지");
  }
  {
    const calls = fakeHttp([{ status: 200, json: {} }]);
    const { client } = makeClient();
    const r = await client.listEvents("c", { syncToken: "a b&c" });
    eq(calls[0].url, `${BASE}/calendars/c/events?syncToken=a+b%26c`, "listEvents: URLSearchParams 인코딩(공백=+)");
    eq(r, { items: [] }, "listEvents: nextSyncToken 없으면 undefined(JSON 에서 빠짐)");
    eq("nextSyncToken" in r, true, "listEvents: nextSyncToken 키는 존재");
  }
  {
    fakeHttp([{ status: 410, text: "Gone" }]);
    const { client } = makeClient();
    const err = await rejection(client.listEvents("c", { syncToken: "old" }));
    eq(err.gone, true, "listEvents 410 → .gone = true");
    eq(err.message, "sync token expired", "listEvents 410 메시지");
  }
  {
    const calls = fakeHttp([
      { status: 200, json: { items: [{ id: "1" }], nextPageToken: "P2" } },
      { status: 410, text: "Gone" },
    ]);
    const { client } = makeClient();
    const err = await rejection(client.listEvents("c", {}));
    eq([calls.length, err.gone], [2, true], "listEvents: 두 번째 페이지 410 도 gone 으로 던짐(모은 items 버림)");
  }
  {
    fakeHttp([{ status: 404, text: "nope" }]);
    const { client } = makeClient();
    const err = await rejection(client.listEvents("c", {}));
    eq(err.message, "GCal list 404: nope", "listEvents 비-2xx 메시지: `GCal list <status>: <text>`");
    eq(err.gone, undefined, "listEvents 404 는 gone 아님");
  }
  {
    fakeHttp([{ status: 204 }]);
    const { client } = makeClient();
    const err = await rejection(client.listEvents("c", {}));
    eq(err instanceof TypeError, true, "listEvents 204(json 없음) → resp.json.items 접근에서 TypeError (특성 고정)");
  }

  // ── findByTaskId ──
  {
    const calls = fakeHttp([
      {
        status: 200,
        json: {
          items: [
            { id: "a" },
            { id: "b", status: "cancelled" },
            { status: "confirmed" },
            { id: "", status: "confirmed" },
            { id: "c", status: "confirmed" },
            { id: "d", status: "tentative" },
          ],
        },
      },
    ]);
    const { client } = makeClient();
    const got = await client.findByTaskId("me@x.com", "abc123");
    eq(
      calls[0].url,
      `${BASE}/calendars/me%40x.com/events?privateExtendedProperty=tgsTaskId%3Dabc123&singleEvents=true&showDeleted=false&maxResults=50`,
      "findByTaskId: 쿼리 모양"
    );
    eq(
      got.map((e) => e.id),
      ["a", "c", "d"],
      "findByTaskId: cancelled 와 id 없는(빈 문자열 포함) 이벤트 제외"
    );
  }

  // ── deleteEvent: 멱등 ──
  {
    const calls = fakeHttp([{ status: 204 }]);
    const { client } = makeClient();
    eq(await client.deleteEvent("me@x.com", "e 1"), undefined, "deleteEvent 204 → undefined");
    eq(
      calls[0],
      {
        url: `${BASE}/calendars/me%40x.com/events/e%201`,
        method: "DELETE",
        headers: { Authorization: "Bearer TOK", "Content-Type": "application/json" },
        throw: false,
      },
      "deleteEvent: 요청 모양"
    );
  }
  {
    fakeHttp([{ status: 200, json: { whatever: 1 } }]);
    const { client } = makeClient();
    eq(await client.deleteEvent("c", "e"), undefined, "deleteEvent 200 → undefined(본문 무시)");
  }
  for (const s of [404, 410]) {
    fakeHttp([{ status: s, text: "gone" }]);
    const { client } = makeClient();
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err, undefined, `deleteEvent ${s} → 성공으로 간주`);
  }
  {
    fakeHttp([{ status: 404 }]);
    const { client } = makeClient();
    eq(await rejection(client.deleteEvent("c", "e")), undefined, "deleteEvent 404 text 없음도 성공");
  }
  for (const s of [400, 401, 403, 412]) {
    fakeHttp([{ status: s, text: "no" }]);
    const { client } = makeClient();
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err instanceof Error, true, `deleteEvent ${s} → 던진다`);
  }
  {
    fakeHttp([{ status: 401, text: "unauth" }]);
    const { client } = makeClient();
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err.message, "GCal DELETE 401: unauth", "deleteEvent 401 메시지");
  }
  {
    fakeHttp([{ status: 412, text: "x" }]);
    const { client } = makeClient();
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err instanceof PreconditionFailedError, true, "deleteEvent 412 → PreconditionFailedError 그대로");
  }
  {
    const { client } = makeClient();
    (client as any).auth = {
      async getAccessToken() {
        throw new Error("GCal DELETE 404: 토큰 오류인데 메시지가 우연히 맞음");
      },
    };
    __setRequestUrl(null);
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err, undefined, "deleteEvent: 메시지 정규식만 보므로 토큰 오류 메시지가 패턴에 맞으면 삼킨다(특성 고정)");
  }
  {
    const { client } = makeClient();
    (client as any).auth = {
      async getAccessToken() {
        throw new Error("Google 인증이 필요합니다.");
      },
    };
    __setRequestUrl(null);
    const err = await rejection(client.deleteEvent("c", "e"));
    eq(err?.message, "Google 인증이 필요합니다.", "deleteEvent: 토큰 오류는 그대로 던진다");
    const err2 = await rejection(client.getEvent("c", "e"));
    eq(err2?.message, "Google 인증이 필요합니다.", "req: 토큰 오류는 요청 전에 던진다");
  }

  // ── 재시도: 429/5xx/403 사용량 초과 ──
  {
    const calls = fakeHttp([
      { status: 503, text: "busy" },
      { status: 429, text: "slow" },
      { status: 200, json: { id: "ok" } },
    ]);
    const { client, tokenCalls } = makeClient();
    const { got, delays, warns } = await withFakeTimers(async (delays, warns) => ({
      got: await client.getEvent("c", "e"),
      delays,
      warns,
    }));
    eq(got, { id: "ok" }, "재시도 후 성공 → 결과 반환");
    eq(calls.length, 3, "재시도: 3번 요청");
    eq(delays, [1000, 2000], "재시도 지연: 1s·2s (rand=0.5)");
    eq(tokenCalls(), 1, "재시도는 토큰을 다시 얻지 않는다");
    eq(JSON.stringify(calls[0]) === JSON.stringify(calls[2]), true, "재시도는 같은 요청을 다시 보낸다");
    eq(
      warns,
      [
        "[tasks-gcal-sync] GCal 503 재시도 1/3 (1000ms)",
        "[tasks-gcal-sync] GCal 429 재시도 2/3 (2000ms)",
      ],
      "재시도 경고 로그 형식"
    );
  }
  {
    const calls = fakeHttp([{ status: 500, text: "boom" }]);
    const { client } = makeClient();
    const { err, delays, warns } = await withFakeTimers(async (delays, warns) => ({
      err: await rejection(client.getEvent("c", "e")),
      delays,
      warns,
    }));
    eq(calls.length, 4, "재시도 상한: 최초 1 + 재시도 3 = 4번");
    eq(delays, [1000, 2000, 4000], "마지막 시도 뒤에는 기다리지 않는다");
    eq(warns.length, 3, "경고도 3번");
    eq(err.message, "GCal GET 500: boom", "재시도 소진 → 마지막 응답으로 에러");
  }
  {
    const calls = fakeHttp([{ status: 502, text: "x" }]);
    const { client } = makeClient();
    const delays = await withFakeTimers(async (delays) => {
      await rejection(client.getEvent("c", "e"));
      return delays;
    }, 0);
    eq([calls.length, delays], [4, [500, 1000, 2000]], "지터 rand=0 → 0.5배");
  }
  {
    fakeHttp([
      { status: 429, headers: { "retry-after": "7" } },
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 503, headers: { "retry-after": "0" } },
      { status: 200, json: { id: "ok" } },
    ]);
    const { client } = makeClient();
    const delays = await withFakeTimers(async (delays) => {
      await client.getEvent("c", "e");
      return delays;
    });
    eq(delays, [7000, 2000, 4000], "Retry-After 소문자·대문자 모두 존중, 0 이면 백오프(attempt 2)");
  }
  {
    fakeHttp([
      { status: 429, headers: { "retry-after": "120", "Retry-After": "1" } },
      { status: 200, json: {} },
    ]);
    const { client } = makeClient();
    const delays = await withFakeTimers(async (delays) => {
      await client.getEvent("c", "e");
      return delays;
    });
    eq(delays, [60000], "두 헤더가 다 있으면 소문자 우선, 상한 60초");
  }
  {
    const calls = fakeHttp([
      { status: 403, text: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' },
      { status: 200, json: { id: "ok" } },
    ]);
    const { client } = makeClient();
    const got = await withFakeTimers(async () => client.getEvent("c", "e"));
    eq([calls.length, got], [2, { id: "ok" }], "403 사용량 초과 → 재시도");
  }
  {
    const calls = fakeHttp([
      { status: 503, text: "x" },
      { status: 200, json: { items: [{ id: "1" }] } },
    ]);
    const { client } = makeClient();
    const r = await withFakeTimers(async () => client.listEvents("c", {}));
    eq([calls.length, r.items.length], [2, 1], "listEvents 도 같은 재시도 경로");
  }
  {
    const calls = fakeHttp([
      { status: 503, text: "x" },
      { status: 404, text: "gone" },
    ]);
    const { client } = makeClient();
    const err = await withFakeTimers(async () => rejection(client.deleteEvent("c", "e")));
    eq([calls.length, err], [2, undefined], "deleteEvent: 재시도 뒤 404 → 성공");
  }
  {
    fakeHttp([{ status: 503, text: "x" }]);
    const { client } = makeClient();
    const err = await withFakeTimers(async () => rejection(client.deleteEvent("c", "e")));
    eq(err.message, "GCal DELETE 503: x", "deleteEvent: 재시도 소진 503 → 던진다");
  }

  __setRequestUrl(null);
  done();
})();
