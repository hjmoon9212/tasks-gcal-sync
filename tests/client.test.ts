/**
 * GCal HTTP 계층의 재시도 판정.
 *
 * 상태코드만으로는 못 가른다 — Google 은 **사용량 초과를 403 으로도** 준다. 권한 오류와
 * 같은 코드라, 재시도 대상을 잘못 잡으면 둘 중 하나가 망가진다: 사용량 초과를 안 재시도하면
 * 그 항목이 조용히 빠지고, 권한 오류를 재시도하면 매번 헛되이 늦어진다.
 */
import { backoffMs, isRetryable } from "../src/gcal/CalendarClient";

let pass = 0;
let fail = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.error(
      `✗ ${msg}   expected: ${JSON.stringify(expected)}  actual: ${JSON.stringify(actual)}`
    );
  }
}

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

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
