import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasErrorCode } from "@babojubot/contracts";
import { claudeSessionCost, claudeSessionFacts } from "./claude-transcript.ts";
import { testFolders } from "./test-folders.ts";

const folders = testFolders();
const windows = process.platform === "win32";
const session = "3f8a2c1e-0000-4000-8000-000000000001";
const transcript = [
  JSON.stringify({
    type: "assistant",
    sessionId: session,
    timestamp: "2026-11-22T00:00:00.000Z",
    message: { usage: { input_tokens: 10 } },
  }),
  JSON.stringify({
    type: "cost-state",
    sessionId: session,
    totalCostUSD: 0.5,
    modelUsage: {},
  }),
].join("\n");
/** 세션 기록을 읽는 두 함수. 둘 다 같은 길로 기록을 찾고 연다. */
const readers = [
  ["claudeSessionFacts", claudeSessionFacts],
  ["claudeSessionCost", claudeSessionCost],
] as const;

// Claude의 세션 기록은 조직 제품 폴더에 있고, 격리 실행에서는 같은 조직의 컨테이너가 그 폴더에 쓸 수 있다.
// 서버는 그 폴더 안을 링크를 따라가거나 FIFO에서 기다리며 열지 않는다.
describe.each(readers)(
  "%s reading a session transcript in a folder an isolated agent can write",
  (_name, readTranscript) => {
    it("reads a transcript in the organization's own folders", async () => {
      const home = await folders.make("babojubot-transcript-");
      const projects = path.join(home, "config", "projects", "project");
      await mkdir(projects, { recursive: true });
      await writeFile(path.join(projects, `${session}.jsonl`), transcript);
      expect(await readTranscript(home, session)).toBeDefined();
    });

    // Windows에서 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하고, FIFO가 없다. 링크·FIFO 경우는 POSIX에서 본다.
    it.skipIf(windows)(
      "does not follow a link in place of a folder on the way to the transcript",
      async () => {
        const home = await folders.make("babojubot-transcript-");
        const elsewhere = path.join(home, "elsewhere");
        await mkdir(path.join(elsewhere, "projects", "project"), {
          recursive: true,
        });
        await writeFile(
          path.join(elsewhere, "projects", "project", `${session}.jsonl`),
          transcript
        );
        await symlink(elsewhere, path.join(home, "config"));
        expect(await readTranscript(home, session)).toBeUndefined();
      }
    );

    it.skipIf(windows)(
      "answers nothing for a FIFO in place of the transcript without waiting for a writer",
      { timeout: 10_000 },
      async () => {
        const home = await folders.make("babojubot-transcript-");
        const projects = path.join(home, "config", "projects", "project");
        await mkdir(projects, { recursive: true });
        const fifo = path.join(projects, `${session}.jsonl`);
        execFileSync("mkfifo", [fifo], { timeout: 10_000 });
        // 열기가 멈춰 있으면 쓰는 쪽으로 한 번 열어 풀어 준다. 읽는 쪽이 없으면(이미 끝남) ENXIO다.
        folders.own(async () => {
          try {
            closeSync(
              openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
            );
          } catch (error) {
            if (!hasErrorCode("ENXIO")(error)) throw error;
          }
        }, "fifo writer");
        expect(await readTranscript(home, session)).toBeUndefined();
      }
    );
  }
);
