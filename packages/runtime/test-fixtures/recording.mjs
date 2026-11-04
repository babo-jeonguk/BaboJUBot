// 시뮬레이터가 --recording <파일>을 받으면 실제 출력의 정제본(*-recorded.json)을 그대로 내보낸다. 동작은 시뮬레이터가 연기한다.
import { readFile } from "node:fs/promises";

const at = process.argv.indexOf("--recording");
export const recording =
  at < 0 ? null : JSON.parse(await readFile(process.argv[at + 1], "utf8"));
export const bind = (frame, session, turn = "turn-one") =>
  JSON.parse(
    JSON.stringify(frame)
      .replaceAll("<session>", session)
      .replaceAll("<turn>", turn)
  );
