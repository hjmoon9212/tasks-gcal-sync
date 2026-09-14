/**
 * 골든 테스트용 결정적 환경 — 시계 · 난수 · 타임존.
 *
 * 엔진은 `Date.now()`/`new Date()`(오늘 날짜, 보류 시계) · `crypto.getRandomValues`(genId) ·
 * `Intl` 타임존(timedDates)을 직접 읽는다. 기록 시점과 CI(ubuntu, UTC)에서 같은 출력을
 * 내려면 셋 다 고정해야 한다. 타임존은 바꿀 수 없으므로 출력에서 `<TZ>` 로 치환한다(golden.ts).
 */
const RealDate = Date;

/** 로컬 벽시계 기준 고정 시각. 로컬 생성자라 어느 TZ 에서도 "오늘"이 같은 날짜로 읽힌다. */
export const FIXED_NOW = new RealDate(2026, 7, 6, 12, 0, 0).getTime(); // 2026-08-06 12:00 local

let now = FIXED_NOW;

export function installFakeEnv(): void {
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(now);
      else super(...(args as [any]));
    }
    static now(): number {
      return now;
    }
  }
  (globalThis as any).Date = FakeDate;

  // genId 는 6바이트씩 뽑는다. 호출마다 다른, 그러나 매번 같은 수열.
  let seed = 1;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView>(a: T): T {
        const u = a as unknown as Uint8Array;
        for (let i = 0; i < u.length; i++) {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          u[i] = seed & 0xff;
        }
        return a;
      },
    },
  });
}

/** 시계를 고정 시각으로 되돌린다(시나리오마다 호출). */
export function resetClock(): void {
  now = FIXED_NOW;
}

export function advanceClock(ms: number): void {
  now += ms;
}
