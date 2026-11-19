import { tmpdir } from "node:os";
import path from "node:path";
import { prepareJobObjectLauncher } from "@babojubot/runtime";

// Windows에서는 묶음 실행기 없이 프로그램을 띄우지 않는다(#262). 조직 폴더 파일 읽기처럼 서버 코드가 띄우는 프로그램도 같다.
// 시험 파일마다 이 사용자의 임시 폴더에 둔 실행기를 준비한다. 준비하지 못하면 그 이유로 실패한다.
if (process.platform === "win32") {
  const launcher = await prepareJobObjectLauncher(
    path.join(tmpdir(), "babojubot-test-launcher")
  );
  if (!launcher?.ok)
    throw new Error(
      `the job object launcher could not be prepared for the tests: ${launcher?.reason ?? "unknown"}`
    );
}
