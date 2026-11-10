import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunRequest } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityProvider } from "./antigravity.ts";
import { createCodexProvider } from "./codex.ts";
import { request } from "./test-support.ts";

// 링크를 만들 수 없는 컴퓨터에서는 실행이 연결 폴더로 대신 돈다. 그때도 연결의 로그인 하나를 읽어야 한다.
// 로그인 원본이 이미 로그인 전용 폴더로 옮겨진 뒤(다른 컴퓨터에서 옮긴 제품 폴더, 링크만 사라진 경우)도 같다(PR #135 SPEC-1).

let refusal: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // 권한 없는 Windows(EPERM)·링크를 모르는 파일 시스템(ENOTSUP·EOPNOTSUPP)처럼 링크 만들기를 거절한다.
    symlink: (...args: Parameters<typeof actual.symlink>) =>
      refusal
        ? Promise.reject(
            Object.assign(new Error(`${refusal}: cannot link`), {
              code: refusal,
            })
          )
        : actual.symlink(...args),
  };
});

const roots: string[] = [];
afterEach(async () => {
  refusal = null;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const control = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});
const fixture = (name: string) => path.resolve("test-fixtures", name);

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-login-link-"));
  roots.push(root);
  const requestFor = async (): Promise<RunRequest> => {
    const input = request();
    const shared = path.join(
      root,
      "organizations",
      input.identity.organizationId,
      "shared"
    );
    await mkdir(shared, { recursive: true });
    return { ...input, workspace: { cwd: shared, organization: shared } };
  };
  return { root, requestFor };
}

const antigravityToken = (home: string) =>
  path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");

describe.each(["EPERM", "ENOTSUP", "EOPNOTSUPP"])(
  "a machine that refuses links with %s",
  (code) => {
    it("runs Antigravity with the connection's login that was already moved to the login folder", async () => {
      const env = await setup();
      const connection = path.join(env.root, "providers/antigravity");
      await mkdir(path.join(connection, "login"), { recursive: true });
      await writeFile(
        path.join(connection, "login", "antigravity-oauth-token"),
        '{"synthetic":1}'
      );
      refusal = code;
      const provider = createAntigravityProvider({
        dataDir: env.root,
        command: [process.execPath, fixture("antigravity-simulator.mjs")],
      });
      expect(
        await provider.adapter.checkReadiness(new AbortController().signal)
      ).toEqual({ status: "ready", reason: null });
      const result = await provider.adapter.execute(
        await env.requestFor(),
        control()
      );
      // 이 시험의 도구 주소는 닿지 않아 실행은 실패하지만, 로그인은 보여야 한다.
      expect(result.errorCode).toBeUndefined();
      expect(await readFile(antigravityToken(connection), "utf8")).toBe(
        '{"synthetic":1}'
      );
    }, 20000);

    it("runs Codex with the connection's login that was already moved to the login folder", async () => {
      const env = await setup();
      const connection = path.join(env.root, "providers/codex");
      await mkdir(path.join(connection, "login"), { recursive: true });
      await writeFile(
        path.join(connection, "login", "auth.json"),
        '{"synthetic":1}'
      );
      const dump = path.join(env.root, "auth.txt");
      const script = path.join(env.root, "read-login.cjs");
      // 받은 CODEX_HOME의 로그인을 남기고 끝나는 프로그램.
      await writeFile(
        script,
        `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(dump)}, (() => { try { return fs.readFileSync(require("node:path").join(process.env.CODEX_HOME, "auth.json"), "utf8"); } catch { return "missing"; } })() + "\\n");`
      );
      refusal = code;
      const provider = createCodexProvider({
        dataDir: env.root,
        command: [process.execPath, script],
      });
      await provider.adapter.execute(await env.requestFor(), control());
      expect((await readFile(dump, "utf8")).trim().split("\n").at(-1)).toBe(
        '{"synthetic":1}'
      );
    }, 20000);

    it.skipIf(process.getuid?.() === 0)(
      "is not ready when the login that runs read cannot be rewritten",
      async () => {
        const env = await setup();
        const connection = path.join(env.root, "providers/antigravity");
        await mkdir(path.dirname(antigravityToken(connection)), {
          recursive: true,
        });
        await writeFile(antigravityToken(connection), '{"synthetic":1}');
        await chmod(antigravityToken(connection), 0o400);
        refusal = code;
        expect(
          await createAntigravityProvider({
            dataDir: env.root,
            command: [process.execPath, fixture("antigravity-simulator.mjs")],
          }).adapter.checkReadiness(new AbortController().signal)
        ).toEqual({ status: "not_ready", reason: "check_failed" });
      },
      20000
    );
  }
);
