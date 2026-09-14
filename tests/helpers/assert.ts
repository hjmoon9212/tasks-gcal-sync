/**
 * 테스트 공용 단언. 러너 의존성 없이 파일마다 node 로 돌리는 구조라(esbuild.test.mjs)
 * 합계를 세다가 마지막에 `done()` 이 출력하고 실패가 있으면 종료 코드 1로 끝낸다.
 *
 * 비교는 JSON 직렬화 동등 — 키 순서까지 같아야 통과한다(로그·patch 모양을 고정하려는 용도).
 */
let pass = 0;
let fail = 0;

export function eq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.error(
      `✗ ${msg}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`
    );
  }
}

export function ok(cond: boolean, msg: string): void {
  eq(cond, true, msg);
}

/** 파일 끝에서 한 번 부른다. `N passed, M failed` 형식은 CI 로그에서 합계를 셀 때 쓴다. */
export function done(): void {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
