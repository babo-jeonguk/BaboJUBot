#!/usr/bin/env node
// 서버 시험의 가짜 docker(BABOJUBOT_DOCKER_COMMAND). 서버 시작의 남은 컨테이너 정리가 이 제품 폴더의 컨테이너만 고르는 목록 명령
// (`ps -aq --filter label=babojubot.owner=<주인>`) 하나만 받고, 남은 컨테이너가 없다고 답한다. 서버를 띄우는 시험이 이 컴퓨터의
// Docker 유무·권한과 상관없이 같은 결과를 내게 한다. 실제 Docker는 runtime의 실제 Docker 묶음(container.docker.test.ts, CI 필수)만 쓴다.
//
// 서버는 docker 클라이언트에 자기 환경을 넘기지 않고 Docker 설정 폴더(DOCKER_CONFIG)만 넘긴다(container.ts `dockerClientEnv`).
// 시험(main.test.ts `startMain`)이 서버마다 그 폴더를 따로 만들어 기대하는 주인을 적어 두고(`fake-docker.json`), 이 가짜는 받은 인수를
// 그 폴더의 `calls.jsonl`에 한 줄씩(JSON) 남긴다. 기대와 다른 명령은 무엇을 받았는지와 함께 실패한다. 기대를 적은 파일이 없으면
// (시험이 만든 폴더가 아니면) 아무것도 남기지 않고 실패한다.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const folder = process.env.DOCKER_CONFIG;
if (folder === undefined) {
  process.stderr.write("fake docker: DOCKER_CONFIG is not set\n");
  process.exitCode = 2;
} else {
  const expected: unknown = JSON.parse(
    readFileSync(path.join(folder, "fake-docker.json"), "utf8")
  );
  const owner =
    typeof expected === "object" && expected !== null && "owner" in expected
      ? expected.owner
      : undefined;
  if (typeof owner !== "string" || owner === "")
    throw new Error(
      `fake docker: fake-docker.json gives no owner: ${JSON.stringify(expected)}`
    );
  appendFileSync(path.join(folder, "calls.jsonl"), `${JSON.stringify(args)}\n`);
  const listing = ["ps", "-aq", "--filter", `label=babojubot.owner=${owner}`];
  // 남은 컨테이너 없음: 출력 없이 성공한다. 그 밖의 명령은 서버 시험이 부르지 않는다.
  if (JSON.stringify(args) !== JSON.stringify(listing)) {
    process.stderr.write(
      `fake docker: ${JSON.stringify(args)} is not expected in server tests (expected ${JSON.stringify(listing)})\n`
    );
    process.exitCode = 1;
  }
}
