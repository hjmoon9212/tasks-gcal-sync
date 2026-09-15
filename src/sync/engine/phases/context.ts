/**
 * run 한 번 동안 단계들이 함께 보는 것. 필드 이름은 옛 run() 의 지역 변수 이름 그대로다 —
 * 단계 본문을 옮길 때 한 글자도 바꾸지 않으려고.
 */
import { CalendarClient } from "../../../gcal/CalendarClient";
import { VaultTask } from "../../../data/TaskRepository";
import { PluginSettings } from "../../../settings/Settings";
import { TaskWriter } from "../../../write/TaskWriter";
import { SyncRecord } from "../../StateStore";
import { CodecCtx } from "../../codec/ctx";
import { MergeDeps } from "../applyMerge";
import { CalendarPuller } from "../puller";
import { SyncResult } from "../result";

export interface RunContext {
  settings: PluginSettings;
  codec: CodecCtx;
  client: CalendarClient;
  writer: TaskWriter;
  puller: CalendarPuller;
  mergeDeps: MergeDeps;

  records: Record<string, SyncRecord>;
  result: SyncResult;
  /** 오늘(YYYY-MM-DD). 생성 창(overdue 포함 여부) 판정에 쓴다. */
  today: string;

  tasks: VaultTask[];
  tasksById: Map<string, VaultTask>;
  existingIds: Set<string>;
  dupIds: Set<string>;
  dupWhere: Map<string, string>;

  /** 사람이 누른 실행(리본·명령) — 충돌 해결 · 생성 · 🆔 중복 정리를 연다. 삭제는 열지 않는다. */
  force: boolean;
  /** 콜드 스타트 잠금 — 이번 run 은 원격에 쓰지 않는다. */
  coldHold: boolean;
  /** 이 기기는 GCal 에 쓰지 않는다(모바일 읽기 전용). */
  remoteReadOnly: boolean;
  /** ★ 볼트 정착 전 — 되돌리기 힘든 동작(삭제·충돌 해결·새 🆔)이 이 값을 본다. */
  vaultUnsettled: boolean;
}
