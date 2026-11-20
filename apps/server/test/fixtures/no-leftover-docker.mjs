#!/usr/bin/env node
// 서버 시험의 가짜 docker(BABOJUBOT_DOCKER_COMMAND). 시작 정리의 목록(`ps -aq --filter label=…`)에 남은 컨테이너가 없다고 답한다.
// 서버를 띄우는 시험이 이 컴퓨터의 Docker 유무·권한과 상관없이 같은 결과를 내게 한다. 실제 Docker는 runtime의 실제 Docker 묶음
// (container.docker.test.ts, CI 필수)만 쓴다. 서버 시험이 부르지 않는 그 밖의 명령은 무엇을 불렀는지와 함께 실패한다.
const args = process.argv.slice(2);
if (args[0] === "ps") process.exit(0);
process.stderr.write(
  `fake docker: "${args.join(" ")}" is not expected in server tests\n`
);
process.exit(1);
