import { existsSync } from "node:fs";
import { folderCleanup } from "@babojubot/process/test-cleanup";
import { ownHome } from "./product-home.ts";
import { closeDatabase, ownStart } from "./support.ts";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { organizationDetailSchema } from "@babojubot/contracts";
import { createTestDatabase } from "@babojubot/db/testing";
import { expect, it, onTestFinished } from "vitest";
import { startServer } from "../src/index.ts";
import { goal } from "./scenarios.ts";

// 데이터 폴더를 따로 넘기지 않은 서버와 그 자식 서버도 테스트 파일마다 임시 제품 폴더를 쓴다.
// 저장소 안에 쌓이면 다음 실행의 서버 시작이 느려지고, 저장소 루트의 실제 제품 폴더를 건드리게 된다.
it("keeps the product folder of a server started without one outside the repository", async () => {
  const home = process.env.BABOJUBOT_HOME;
  expect(home).toBeDefined();
  const relative = path.relative(
    await realpath(tmpdir()),
    await realpath(home!)
  );
  expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);

  // DB는 그것을 쓰는 서버가 끝난 뒤에만 닫는다. 그 서버는 데이터 폴더를 넘기지 않아 파일의 제품 폴더를 쓴다(`ownHome`).
  const database = await createTestDatabase();
  const users = folderCleanup(() => closeDatabase(database));
  onTestFinished(users.cleanUp);
  ownHome(users.cleanUp);
  const server = await ownStart(
    users.own,
    startServer({ db: database.db, port: 0 }),
    "the server"
  ).started;
  const res = await fetch(`${server.url}/api/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "임시 폴더 조직", ...goal }),
  });
  const org = organizationDetailSchema.parse(await res.json());
  expect(existsSync(path.join(home!, "organizations", org.id))).toBe(true);
});
