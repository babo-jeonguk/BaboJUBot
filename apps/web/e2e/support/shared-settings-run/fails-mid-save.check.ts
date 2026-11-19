import { leaveSettingsMidSave, test } from "./fixture.ts";

// 전역 설정을 바꾸고 화면의 저장을 붙잡은 채 본문이 실패한다. 바깥 시험은 이 실행의 실패가 아래 오류 하나뿐인지(설정 변경이
// 앞서 실패하거나 fixture 정리가 실패하지 않았는지)와 정리 뒤 설정을 본다.
test("fails while a settings save is held", async ({
  page,
  request,
  sharedSettings,
}) => {
  await leaveSettingsMidSave(page, request, sharedSettings);
  throw new Error("mid-save body failed on purpose");
});
