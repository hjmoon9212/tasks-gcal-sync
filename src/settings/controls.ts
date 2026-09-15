import type TasksGcalSyncPlugin from "../main";

/**
 * 설정 탭 섹션이 받는 것.
 *
 * ⛔ `rerender()` 는 **모양이 바뀌는 조작**(목록 불러오기 · 규칙 추가/삭제 · 피드 토글 · 인증 ·
 *    자격증명 붙여넣기)에만 부른다. 값 입력칸의 onChange 에서 부르면 텍스트 입력 중 포커스가 날아간다.
 */
export interface SectionCtx {
  containerEl: HTMLElement;
  plugin: TasksGcalSyncPlugin;
  /** 설정 탭 전체를 다시 그린다. */
  rerender: () => void;
  /** 로그 섹션이 만든 "실제 파일" 줄을 탭이 기억하게 한다(그 줄만 따로 갈아끼운다). */
  setLogPathEl: (el: HTMLElement) => void;
  /** "실제 파일" 줄만 다시 쓴다 — 경로·기기 이름 입력 중에도 포커스를 잃지 않는다. */
  renderLogPath: () => void;
}

/** 숫자 입력칸: 음수·숫자 아님은 0 으로 본다. */
export function nonNegInt(v: string): number {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
