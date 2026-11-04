import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSummaryListSchema } from "@babojubot/contracts";
import { insertLegacyOrganization } from "@babojubot/db/testing";
import { afterEach, expect, it } from "vitest";
import { scriptedAgents, serverHelpers, idle } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 조직 폴더는 자기 조직 ID를 안다. 경로 이름만으로는 다른 조직의 폴더를 구별할 수 없기 때문이다.
let t: TestServer | undefined;
let root = "";
afterEach(async () => {
  await t?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function server() {
  root = await mkdtemp(path.join(tmpdir(), "identity-test-"));
  const agents = scriptedAgents();
  t = await startTestServer({ runtime: agents.runtime, dataDir: root });
  const helpers = serverHelpers(() => t!);
  const folder = (id: string) => path.join(root, "organizations", id);
  const marker = (id: string) =>
    path.join(folder(id), "workspace-identity.json");
  const claimed = async (id: string) =>
    JSON.parse(await readFile(marker(id), "utf8")).organizationId;
  const latestRun = async (id: string) => {
    const res = await t!.request("GET", `/api/organizations/${id}/runs`);
    return runSummaryListSchema.parse(res.body)[0]!;
  };
  return { agents, ...helpers, folder, marker, claimed, latestRun };
}

it("writes the organization's own ID into its folder, outside what agents work in", async () => {
  const { agents, researching, claimed } = await server();
  const org = await researching(agents, "표식 조직");
  expect(await claimed(org.id)).toBe(org.id);
});

it("fails the run with the reason when another organization's folder sits in its place, and others go on", async () => {
  const { agents, researching, say, folder, claimed, latestRun } =
    await server();
  const one = await researching(agents, "하나");
  const two = await researching(agents, "둘");
  const three = await researching(agents, "셋");
  await rename(folder(one.id), `${folder(one.id)}-kept`);
  await rename(folder(two.id), folder(one.id));

  await say(one.id, "실행");
  await t!.drain();
  const failed = await latestRun(one.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("workspace-identity.json");
  expect(await claimed(one.id)).toBe(two.id);

  agents.queue(three.lead.id, idle);
  await say(three.id, "실행");
  await t!.drain();
  expect((await latestRun(three.id)).status).toBe("completed");
});

it("does not write the mark again when it disappears from a folder that has been marked", async () => {
  const { agents, researching, say, marker, latestRun } = await server();
  const org = await researching(agents, "표식 없어진 조직");
  await rm(marker(org.id));
  await say(org.id, "실행");
  await t!.drain();
  const failed = await latestRun(org.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("workspace-identity.json");
  await expect(readFile(marker(org.id))).rejects.toThrow();
});

it("does not mark a folder that already says it belongs to someone else", async () => {
  const { agents, say, folder, marker, claimed, latestRun } = await server();
  const org = await insertLegacyOrganization(t!.db, "남의 표식");
  await mkdir(folder(org.id), { recursive: true });
  await writeFile(marker(org.id), JSON.stringify({ organizationId: "other" }));
  agents.queue(org.lead.id, idle);
  await say(org.id, "실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("failed");
  expect(await claimed(org.id)).toBe("other");
});

it.each([
  ["unreadable", "{broken"],
  ["empty", ""],
])("refuses a folder with an %s mark", async (_name, content) => {
  const { agents, researching, say, marker, latestRun } = await server();
  const org = await researching(agents, "깨진 표식");
  agents.queue(org.lead.id, idle);
  await writeFile(marker(org.id), content);
  await say(org.id, "실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("failed");
  expect(await readFile(marker(org.id), "utf8")).toBe(content);
});

it("marks the existing folder of an organization from before the mark, once, keeping its files", async () => {
  const { agents, say, folder, claimed, marker, latestRun } = await server();
  const org = await insertLegacyOrganization(t!.db, "예전 조직");
  const shared = path.join(folder(org.id), "shared");
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, "기존.md"), "기존 파일");

  agents.queue(org.lead.id, idle);
  await say(org.id, "실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("completed");
  expect(await claimed(org.id)).toBe(org.id);
  expect(await readFile(path.join(shared, "기존.md"), "utf8")).toBe(
    "기존 파일"
  );

  // 표식을 남긴 뒤로는 다시 만들지 않는다.
  await rm(marker(org.id));
  await say(org.id, "다시 실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("failed");
});

it("repairs a folder that is gone altogether, since nothing can be mistaken", async () => {
  const { agents, researching, say, folder, claimed, latestRun } =
    await server();
  const org = await researching(agents, "폴더 없어진 조직");
  await rm(folder(org.id), { recursive: true });
  agents.queue(org.lead.id, idle);
  await say(org.id, "실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("completed");
  expect(await claimed(org.id)).toBe(org.id);
});

it("accepts a folder restored by copying, whose file numbers all changed", async () => {
  const { agents, researching, say, folder, latestRun } = await server();
  const org = await researching(agents, "복원 조직");
  const backup = `${folder(org.id)}-backup`;
  await cp(folder(org.id), backup, { recursive: true });
  await rm(folder(org.id), { recursive: true });
  await rename(backup, folder(org.id));
  agents.queue(org.lead.id, idle);
  await say(org.id, "실행");
  await t!.drain();
  expect((await latestRun(org.id)).status).toBe("completed");
});

// 표식을 읽거나 쓰지 못하는 원인도 어디를 봐야 하는지 알려야 한다. 일반 오류 문구로는 찾을 수 없다.
it("names the mark when the file system stops it being read", async () => {
  const { agents, researching, say, folder, latestRun } = await server();
  const org = await researching(agents, "읽을 수 없는 표식");
  await rm(folder(org.id), { recursive: true });
  await writeFile(folder(org.id), "폴더 자리에 놓인 파일");
  await say(org.id, "실행");
  await t!.drain();
  const failed = await latestRun(org.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("workspace-identity.json");
  expect(failed.error).toContain("ENOTDIR");
});

it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "names the mark when the file system stops it being written",
  async () => {
    const { agents, say, folder, latestRun } = await server();
    const org = await insertLegacyOrganization(t!.db, "쓸 수 없는 표식");
    await mkdir(folder(org.id), { recursive: true });
    await chmod(folder(org.id), 0o555);
    try {
      agents.queue(org.lead.id, idle);
      await say(org.id, "실행");
      await t!.drain();
      const failed = await latestRun(org.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("workspace-identity.json");
      expect(failed.error).toContain("EACCES");
    } finally {
      await chmod(folder(org.id), 0o755);
    }
  }
);
