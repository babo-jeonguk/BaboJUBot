// 가짜 컨테이너(fake-docker.mjs) 안에서 도는 시험 프로그램이 부르는 붙인 자리 훑기. 실행 시도의 임시 자리(로그인 자리 표시 등)는
// 실행이 끝나면 지워지므로, 붙인 자리에 무엇이 들었는지는 실행 중에만 볼 수 있다. 가짜 docker가 준 붙인 자리(FAKE_DOCKER_MOUNTS)를
// 모두 훑어, 붙인 자리와 `needle`을 담은 보통 파일을 `record`에 한 줄(JSON)로 남긴다. 조회 실패는 접지 않는다: 훑지 못하면 던지고
// 기록이 남지 않아, 기록을 기대한 시험이 실패한다.
// 사용: 프로그램으로 `node mount-scan.ts <기록 파일> <찾을 글자>`, 또는 다른 시험 프로그램이 불러 `scanMounts(record, needle)`.
import { appendFileSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function scanMounts(record: string, needle: string) {
  const mounts = JSON.parse(process.env.FAKE_DOCKER_MOUNTS ?? "") as {
    source: string;
  }[];
  const sources = mounts.map((mount) => mount.source);
  const holding: string[] = [];
  const look = (at: string) => {
    const info = lstatSync(at);
    if (info.isDirectory())
      for (const name of readdirSync(at)) look(path.join(at, name));
    else if (info.isFile() && readFileSync(at, "utf8").includes(needle))
      holding.push(at);
  };
  for (const source of sources) look(source);
  appendFileSync(record, JSON.stringify({ sources, holding }) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [record, needle] = process.argv.slice(2);
  if (record === undefined || needle === undefined)
    throw new Error("usage: mount-scan.ts <record file> <needle>");
  scanMounts(record, needle);
}
