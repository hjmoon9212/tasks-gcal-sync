import { SkipKind, SyncResult } from "../sync/engine/result";
import { SKIP_LABEL } from "../sync/engine/skipText";

/** `HH:MM` (로컬). 상태바에 찍는 시각. */
export function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** skip 사유를 사람이 읽는 한 줄로. 숫자만 보여주면 원인을 못 찾는다. */
export function describeSkips(r: SyncResult): string {
  return (Object.keys(r.skips) as SkipKind[])
    .filter((k) => r.skips[k])
    .map((k) => `${SKIP_LABEL[k]} ${r.skips[k]}`)
    .join(" · ");
}

/** Notice · 로그 블록 제목에 쓰는 계수기 요약 `+1 ~0 ↔0 -0 ⬇0 (skip 2)`. */
export function summaryText(r: SyncResult): string {
  return (
    `+${r.created} ~${r.updated} ↔${r.moved} -${r.deleted} ⬇${r.pulled}` +
    (r.skipped ? ` (skip ${r.skipped})` : "")
  );
}

export interface ReportInput {
  now: Date;
  lastSyncAt: number;
  lastFatal: string | null;
  lastResult: SyncResult | null;
  authenticated: boolean;
  lastFullScanAt?: number;
}

/**
 * 상태바 tooltip · `동기화 리포트` 명령이 함께 쓰는 요약.
 * **항목별 실패가 있으면 보이게 한다** — 2026-07-21 에 전부 catch 로 삼키고 ✓ 를 찍어 며칠을 끌었다.
 * main.ts 에서 옮겼다(0.12.8).
 */
export function reportText(x: ReportInput): string {
  const lines: string[] = [];
  const r = x.lastResult;
  const nowMs = x.now.getTime();
  lines.push(
    x.lastSyncAt
      ? `마지막 동기화: ${hm(x.now)} 기준 ${Math.round((nowMs - x.lastSyncAt) / 1000)}초 전`
      : "아직 동기화한 적 없음"
  );
  if (x.lastFatal) lines.push(`⚠ 동기화 실패: ${x.lastFatal}`);
  if (r) {
    lines.push(
      `결과: 생성 ${r.created} · 수정 ${r.updated} · 이동 ${r.moved} · 삭제 ${r.deleted} · 노트반영 ${r.pulled}`
    );
    const skips = describeSkips(r);
    if (skips) lines.push(`건너뜀 ${r.skipped}건 — ${skips}`);
    for (const f of r.failures.slice(0, 5)) {
      lines.push(`⚠ ${f.where}: ${f.message}`);
    }
    if (r.failures.length > 5) {
      lines.push(`… 외 ${r.failures.length - 5}건 (콘솔 참고)`);
    }
  }
  if (!x.authenticated) lines.push("⚠ Google 미인증");
  const scan = x.lastFullScanAt;
  lines.push(
    scan
      ? `전수 스캔: ${Math.round((nowMs - scan) / 3600_000)}시간 전`
      : "전수 스캔: 아직 안 함"
  );
  return lines.join("\n");
}
