/**
 * 골든 스냅샷 비교. 리팩토링 릴리스(0.12.x)의 판정 기준이다 —
 * **이 파일들이 바뀌면 동작이 바뀐 것이다.** 의도한 동작 변경일 때만 `GOLDEN=update npm test`.
 *
 * 저장 형식은 사람이 diff 로 읽을 수 있게 들여쓴 JSON(키 순서 보존 — 순서도 동작이다).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { eq } from "./assert";
import { FIXED_NOW } from "./fakeEnv";

const DIR = path.resolve("tests/golden");

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const YEAR_MS = 366 * 86_400_000;
const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * 기기마다 달라지는 값만 치환한다.
 * - `timeZone` 값 → `<TZ>` (기기의 IANA 타임존)
 * - 고정 시각 ±1년 안의 epoch 밀리초 → `<now±Δms>`. 고정 시각이 로컬 벽시계라 절대값은 TZ 마다 다르다
 * - `toISOString()` 결과(UTC) → 로컬 벽시계 `YYYY-MM-DDTHH:MM:SS~local`. 고정 시계가 로컬 기준이라
 *   UTC 로 찍으면 KST 에서는 03:00Z, CI(UTC)에서는 12:00Z 가 된다 — 벽시계로 되돌리면 같다.
 */
export function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === "timeZone" && typeof v === "string") return "<TZ>";
      if (typeof v === "number" && Math.abs(v - FIXED_NOW) < YEAR_MS) {
        const d = v - FIXED_NOW;
        return `<now${d >= 0 ? "+" : ""}${d}>`;
      }
      if (typeof v === "string" && ISO_Z.test(v)) {
        const d = new Date(v);
        return (
          `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
          `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}~local`
        );
      }
      return v;
    })
  );
}

export function golden(name: string, actual: unknown): void {
  const file = path.join(DIR, `${name}.json`);
  const text = JSON.stringify(normalize(actual), null, 2) + "\n";
  if (process.env.GOLDEN === "update") {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text, "utf8");
    eq(true, true, `golden ${name} (기록)`);
    return;
  }
  if (!existsSync(file)) {
    eq(false, true, `golden ${name} 없음 — GOLDEN=update 로 기록할 것`);
    return;
  }
  const expected = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  eq(text === expected, true, `golden ${name} — 달라졌다면 tests/golden/${name}.json 과 diff 해 볼 것`);
  if (text !== expected) writeFileSync(file + ".actual", text, "utf8");
}
