import { tmpdir } from "node:os";
import path from "node:path";
import { prepareJobObjectLauncher } from "./job-object.ts";

// Windows에서는 묶음 실행기 없이 프로그램을 띄우지 않는다(#262). 시험 파일마다 이 사용자의 임시 폴더에 둔 실행기를 준비한다.
// 실행기는 소스 해시로 한 번만 만들고, 그 뒤로는 시험 실행만 한다. 준비하지 못하면 시험을 시작하지 않고 그 이유로 실패한다.
if (process.platform === "win32") {
  const launcher = await prepareJobObjectLauncher(
    path.join(tmpdir(), "babojubot-test-launcher")
  );
  if (!launcher?.ok)
    throw new Error(
      `the job object launcher could not be prepared for the tests: ${launcher?.reason ?? "unknown"}`
    );
}
