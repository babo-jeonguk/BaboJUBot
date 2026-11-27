import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, realpathSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { hasErrorCode } from "@babojubot/contracts";
import { fileLinks, insideFolder } from "@babojubot/process/test-support";
import { claudeSessionCost, claudeSessionFacts } from "./claude-transcript.ts";
import { testFolders } from "./test-folders.ts";

/**
 * 그 시험의 세션 기록 파일(`at`, 실제 경로) 열기가 "없음"으로 실패한다(그 자리는 그대로 있다: 여는 사이 바뀐 장면). 실패시킨 자리를
 * `missed`에 남긴다(시험이 그 기록에서 실제로 났는지 본다, #286).
 */
let missing: { at: string; missed: string[] } | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (...args) => {
    // 결함은 불린 순간(첫 await 전) 읽는다. 제품은 확인한 폴더 handle을 거친 경로(`/proc/self/fd/<n>/…`)로 열기도 한다(`insideFolder`).
    const file = String(args[0]);
    if (missing && insideFolder(missing.at, file)) {
      missing.missed.push(
        path.join(realpathSync(path.dirname(file)), path.basename(file))
      );
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    }
    return real.open(...args);
  };
  return { ...real, open, default: { ...real, open } };
});
afterEach(() => {
  missing = undefined;
});

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

    // 에이전트가 쓸 수 있는 폴더라 기록 자리가 폴더나 링크로 바뀔 수 있다. 그것은 "기록 없음"이 아니라 확인하지 못한 것이다.
    // 사용량 사실 읽기라 건너뛰되 그 까닭을 남긴다. 실제로 없는 기록만 말없이 넘긴다(#286 PR 1 parent 점검).
    it("skips a folder in place of the transcript, saying it is not a regular file", async () => {
      const home = await folders.make("babojubot-transcript-");
      const projects = path.join(home, "config", "projects", "project");
      await mkdir(path.join(projects, `${session}.jsonl`), { recursive: true });
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      expect(await readTranscript(home, session)).toBeUndefined();
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] a Claude session transcript is not a regular file",
      ]);
    });

    // 파일 링크를 만들 권한이 없는 Windows에서는 이유와 함께 건너뛴다. CI는 필수로 정한다(`fileLinks`, #286 항목 16).
    it.skipIf(!fileLinks())(
      "skips a link in place of the transcript, saying it is not a regular file",
      async () => {
        const home = await folders.make("babojubot-transcript-");
        const projects = path.join(home, "config", "projects", "project");
        await mkdir(projects, { recursive: true });
        const elsewhere = path.join(home, "elsewhere.jsonl");
        await writeFile(elsewhere, transcript);
        await symlink(elsewhere, path.join(projects, `${session}.jsonl`));
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());
        expect(await readTranscript(home, session)).toBeUndefined();
        expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
          "[provider] a Claude session transcript is not a regular file",
        ]);
      }
    );

    // 실제로 없는 기록은 기록이 없는 것이다. 말없이 넘긴다.
    it("says nothing when the transcript is simply missing", async () => {
      const home = await folders.make("babojubot-transcript-");
      await mkdir(path.join(home, "config", "projects", "project"), {
        recursive: true,
      });
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      expect(await readTranscript(home, session)).toBeUndefined();
      expect(warned).not.toHaveBeenCalled();
    });

    // 기록을 여는 사이 자리가 바뀌었으면 읽지 못한 것이다. 건너뛰되 그 까닭을 남긴다(#286 리뷰 2회차 SPEC-3 같은 모양).
    it("skips a transcript that changed while it was opened, saying so", async () => {
      const home = await realpath(await folders.make("babojubot-transcript-"));
      const projects = path.join(home, "config", "projects", "project");
      await mkdir(projects, { recursive: true });
      const file = path.join(projects, `${session}.jsonl`);
      await writeFile(file, transcript);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      const failing = { at: file, missed: [] as string[] };
      missing = failing;
      expect(await readTranscript(home, session)).toBeUndefined();
      expect(failing.missed).toEqual([file]);
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] a Claude session transcript changed while it was opened",
      ]);
    });

    // 가는 길의 폴더 자리에 둔 링크는 모든 시스템에서 본다. Windows의 폴더 링크(junction)는 권한 없이 만들 수 있고, 다른
    // 시스템은 `"junction"`을 무시하고 폴더를 가리키는 링크를 만든다(Node `fs.symlink`). junction의 대상은 절대 경로여야 한다.
    it("does not follow a link in place of a folder on the way to the transcript", async () => {
      const home = await folders.make("babojubot-transcript-");
      const elsewhere = path.join(home, "elsewhere");
      await mkdir(path.join(elsewhere, "projects", "project"), {
        recursive: true,
      });
      await writeFile(
        path.join(elsewhere, "projects", "project", `${session}.jsonl`),
        transcript
      );
      await symlink(elsewhere, path.join(home, "config"), "junction");
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      expect(await readTranscript(home, session)).toBeUndefined();
      // 확인하지 못한 폴더는 "기록 없음"과 같지 않다. 건너뛰되 그 까닭을 남긴다(#286 리뷰 2회차 SPEC-3 같은 모양).
      expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
        "[provider] a Claude session transcript folder could not be checked (link)",
      ]);
    });

    // Windows에는 FIFO가 없다. FIFO 경우는 POSIX에서 본다.

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
        const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warned.mockRestore());
        expect(await readTranscript(home, session)).toBeUndefined();
        // 기록 자리의 특수 파일은 기록이 없는 것이 아니라 확인하지 못한 것이다. 건너뛰되 그 까닭을 남긴다(#286 PR 1 parent 점검).
        expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
          "[provider] a Claude session transcript is not a regular file",
        ]);
      }
    );
  }
);
