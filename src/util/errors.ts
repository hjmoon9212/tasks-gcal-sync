/**
 * 예외를 로그·결과에 실을 한 줄로. Error 면 message, 아니면 문자열화.
 *
 * ⚠️ main.ts 의 `e?.message ?? String(e)` 와는 **다르게 동작한다**(Error 가 아닌 객체에
 * message 필드가 있으면 그쪽은 그걸 쓴다). 같은 뜻으로 보여도 합치지 말 것 — 사용자에게
 * 보이는 문구가 바뀐다.
 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
