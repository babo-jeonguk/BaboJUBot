import { leaveSettingsMidSave, test } from "./fixture.ts";

// 전역 설정을 바꾸고 화면의 저장을 붙잡은 채 통과로 끝난다. fixture 정리가 붙잡힌 저장을 끊고 시작 전 값으로 되돌리는지는
// 이 실행이 끝난 뒤 바깥 시험이 본다.
test("ends while a settings save is held", async ({
  page,
  request,
  sharedSettings,
}) => {
  await leaveSettingsMidSave(page, request, sharedSettings);
});
