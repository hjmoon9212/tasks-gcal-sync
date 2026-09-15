import { Notice } from "obsidian";
import type TasksGcalSyncPlugin from "../main";

/**
 * 사람이 누른 실행에 붙이는 옵션.
 *
 * - `force` — 사용자가 명시적으로 요청한 것이므로 콜드 스타트/뒤처짐 보류를 우회한다(자동 트리거만 보류 대상).
 * - `manual` — 캘린더 뷰의 일정도 같이 다시 받아온다. ⛔ **자동 트리거(주기·편집·시작·후속·종료)에는
 *   절대 붙이지 않는다** — v0.7.0~0.7.2 가 그렇게 해서 5분마다 일정 막대가 깜빡였다.
 *   수동 진입점은 넷뿐이다: 리본 · `지금 동기화` · `캘린더 전수 스캔` · 설정 탭의 「지금 동기화」.
 */
export const MANUAL = { force: true, manual: true } as const;

/**
 * 리본 아이콘과 명령. **등록 순서가 곧 명령 팔레트 순서**다(테스트가 고정한다).
 * main.ts onload 에서 옮겼다(0.12.8).
 */
export function registerCommands(plugin: TasksGcalSyncPlugin): void {
  plugin.addRibbonIcon("calendar-clock", "Tasks → Google Calendar 동기화", () =>
    plugin.runSync(false, { ...MANUAL, trigger: "수동(리본)" })
  );
  plugin.addCommand({
    id: "sync-now",
    name: "지금 동기화 (Tasks → Google Calendar)",
    callback: () => plugin.runSync(false, { ...MANUAL, trigger: "수동(명령)" }),
  });
  plugin.addCommand({
    id: "backfill-ids",
    name: "기존 이벤트 설명에 🆔 백필",
    callback: () => plugin.backfillIds(),
  });
  plugin.addCommand({
    id: "sync-report",
    name: "동기화 리포트 (마지막 결과 · 건너뛴 이유 · 실패)",
    callback: () => plugin.showReport(),
  });
  plugin.addCommand({
    id: "rebuild-records",
    name: "캘린더 전수 스캔 (매핑 재구성 · 고아 이벤트 회수)",
    callback: () =>
      plugin.runSync(false, { fullScan: true, ...MANUAL, trigger: "수동(전수 스캔)" }),
  });
  plugin.addCommand({
    id: "cleanup-duplicates",
    name: "중복 이벤트 정리 (같은 task의 GCal 중복 삭제)",
    callback: () => plugin.cleanupDuplicates(),
  });
  plugin.addCommand({
    id: "open-sync-log",
    name: "동기화 로그 열기 (건별 상세 기록)",
    callback: () => plugin.openSyncLog(),
  });
  plugin.addCommand({
    id: "refresh-events",
    name: "캘린더 뷰 일정 새로 고침",
    callback: () => {
      void (async () => {
        await plugin.feed.refreshAll();
        // 결과를 말한다. "받아옵니다" 만 띄우고 조용히 실패하면, 화면에 남은 낡은
        // 일정이 **성공한 결과처럼** 보인다.
        new Notice(
          plugin.feed.lastError
            ? `일정 조회 실패 — ${plugin.feed.lastError}`
            : "캘린더 뷰 일정을 다시 받아왔습니다."
        );
      })();
    },
  });
}

/**
 * 유지보수 명령의 공통 뼈대 — 인증 확인 → 시작 알림 → 실행 → 결과/실패 알림.
 * backfillIds 와 cleanupDuplicates 가 똑같이 적고 있던 것을 합쳤다(0.12.8). 문구는 그대로다.
 */
export async function runMaintenance<T>(
  plugin: TasksGcalSyncPlugin,
  startMsg: string,
  run: () => Promise<T>,
  done: (r: T) => string,
  failLabel: string
): Promise<void> {
  if (!plugin.auth.isAuthenticated()) {
    new Notice("먼저 Google 인증을 하세요.");
    return;
  }
  new Notice(startMsg);
  try {
    const r = await run();
    const msg = done(r);
    console.log("[tasks-gcal-sync]", msg);
    new Notice(msg, 10000);
  } catch (e: any) {
    new Notice(`${failLabel}: ` + e.message);
    console.error(e);
  }
}
