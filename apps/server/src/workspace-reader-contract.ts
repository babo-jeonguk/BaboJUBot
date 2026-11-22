// 서버(workspace.ts)와 고정한 폴더에서 읽는 별도 프로세스(workspace-reader.ts)가 함께 쓰는 값. 읽는 프로세스는 이 파일과
// @babojubot/files만 가져온다(서버의 DB·실행 모듈을 싣지 않는다).
import { fileURLToPath } from "node:url";

/** 조직 폴더가 자기 조직 ID를 적어 두는 표식 파일과 그 크기 한도. */
export const identityFile = "workspace-identity.json";
export const identityMaxBytes = 4096;

/** 고정한 폴더에서 읽는 프로세스가 거부를 알리는 종료 코드. */
export const readerExit = {
  changed: 3,
  notFile: 4,
  tooLarge: 5,
  hardLink: 6,
  identity: 7,
  notFound: 8,
  unreadable: 9,
  linkLoop: 10,
  failed: 11,
  outside: 12,
} as const;

/** 고정한 폴더에서 파일 하나를 읽는 별도 프로세스의 파일. 서버가 `node <이 파일> <인수 JSON>`으로 띄운다. */
export const pinnedReaderFile = fileURLToPath(
  new URL("./workspace-reader.ts", import.meta.url)
);
