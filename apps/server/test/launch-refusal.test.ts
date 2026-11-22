import { runSummaryListSchema } from "@babojubot/contracts";
import { TreeLaunchRefused } from "@babojubot/process";
import { afterEach, expect, it } from "vitest";
import { scriptedAgents, serverHelpers, idle } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 감독 실행기를 준비하지 못하면 프로그램을 띄우지 않는다(#262·#268 사용자 결정). 그 이유는 실행 시도의 실패 원인으로 남아 대시보드에
// 보인다. 실제 거절은 @babojubot/process의 launch 시험과 runtime의 Windows 시험이 보고, 여기서는 그 거절이 실행 시도까지 가는 길을 본다.
let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
});

it("fails the run with the reason when the program is refused for want of a supervisor, and the next run goes on", async () => {
  const agents = scriptedAgents();
  let refuse = false;
  const reason =
    "감독 실행기를 준비하지 못해 프로그램을 시작하지 않았습니다. 이유: the supervisor program was not found at /missing/babojubot-supervisor";
  t = await startTestServer({
    runtime: {
      ...agents.runtime,
      execute: (request, control) =>
        refuse
          ? Promise.reject(new TreeLaunchRefused(reason))
          : agents.runtime.execute(request, control),
    },
  });
  const { researching, say } = serverHelpers(() => t!);
  const latestRun = async (id: string) =>
    runSummaryListSchema.parse(
      (await t!.request("GET", `/api/organizations/${id}/runs`)).body
    )[0]!;
  const org = await researching(agents, "감독 실행기 없음");

  refuse = true;
  await say(org.id, "실행");
  await t.drain();
  const refused = await latestRun(org.id);
  expect(refused.status).toBe("failed");
  expect(refused.error).toBe(reason);

  refuse = false;
  agents.queue(org.lead.id, idle);
  await say(org.id, "다시 실행");
  await t.drain();
  expect((await latestRun(org.id)).status).toBe("completed");
});
