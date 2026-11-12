import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
  const requestFor = async (
    organizationId = crypto.randomUUID()
  ): Promise<RunRequest> => {
    const input = request();
    input.identity.organizationId = organizationId;
    input.context.organization.id = organizationId;
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

// 격리 실행의 에이전트는 조직 제품 폴더에 쓸 수 있다. 거기 남은 파일을 나중에 이 컴퓨터의 실행이 연결의 로그인으로 가져가면,
// 컨테이너가 연결의 로그인을 바꿔 놓을 수 있다(#148: 실행 결과를 원본으로 되가져오지 않는다).
describe("a file left at an organization's login place", () => {
  it.each([
    ["Codex", "codex", ["auth.json"], "auth.json"],
    [
      "Antigravity",
      "antigravity",
      [".gemini", "antigravity-cli", "antigravity-oauth-token"],
      "antigravity-oauth-token",
    ],
  ] as const)(
    "is never taken as the %s connection's login: a run on this machine sets it aside and links the organization to the original",
    async (name, id, place, original) => {
      const env = await setup();
      const connection = path.join(env.root, "providers", id);
      const login = path.join(connection, "login", original);
      await mkdir(path.dirname(login), { recursive: true });
      await writeFile(login, '{"real":1}');
      const input = await env.requestFor();
      const organization = path.join(
        connection,
        "organizations",
        input.identity.organizationId
      );
      const planted = path.join(organization, ...place);
      await mkdir(path.dirname(planted), { recursive: true });
      await writeFile(planted, '{"planted":1}');
      const provider =
        name === "Codex"
          ? createCodexProvider({
              dataDir: env.root,
              command: [process.execPath, "-e", ""],
            })
          : createAntigravityProvider({
              dataDir: env.root,
              command: [process.execPath, fixture("antigravity-simulator.mjs")],
            });
      await provider.adapter.execute(input, control());
      expect(await readFile(login, "utf8")).toBe('{"real":1}');
      expect(await readlink(planted)).toBe(login);
      expect(await readFile(`${planted}.set-aside`, "utf8")).toBe(
        '{"planted":1}'
      );
    },
    20000
  );

  it("is still taken from the connection's own folder, where only this machine writes", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/codex");
    // 로그인 전용 폴더가 생기기 전의 판은 연결 폴더에 로그인을 두었다.
    await mkdir(connection, { recursive: true });
    await writeFile(path.join(connection, "auth.json"), '{"older":1}');
    const provider = createCodexProvider({
      dataDir: env.root,
      command: [process.execPath, "-e", ""],
    });
    await provider.adapter.execute(await env.requestFor(), control());
    expect(
      await readFile(path.join(connection, "login", "auth.json"), "utf8")
    ).toBe('{"older":1}');
  }, 20000);
});

// 링크로 같이 쓰던 컴퓨터가 링크를 더 만들 수 없게 된 장면(권한이 바뀐 Windows, 링크를 모르는 저장소로 옮긴 제품 폴더 등).
// 이미 있는 링크와 대신 실행이 섞이면 조직마다 다른 로그인을 읽거나 원본이 사라진 링크를 읽는다(PR #135 SPEC-2).
describe("a machine that stops being able to create links", () => {
  /** 받은 CODEX_HOME의 로그인을 한 줄씩 남기는 프로그램. */
  const codexReader = async (root: string) => {
    const dump = path.join(root, "auth.txt");
    const script = path.join(root, "read-login.cjs");
    await writeFile(
      script,
      `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(dump)}, (() => { try { return fs.readFileSync(require("node:path").join(process.env.CODEX_HOME, "auth.json"), "utf8"); } catch { return "missing"; } })() + "\\n");`
    );
    const last = async () =>
      (await readFile(dump, "utf8")).trim().split("\n").at(-1);
    return { command: [process.execPath, script] as [string, string], last };
  };

  it("keeps every Antigravity organization on the one login, including those that already had a link", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/antigravity");
    await mkdir(path.dirname(antigravityToken(connection)), {
      recursive: true,
    });
    await writeFile(antigravityToken(connection), '{"synthetic":1}');
    const provider = createAntigravityProvider({
      dataDir: env.root,
      command: [process.execPath, fixture("antigravity-simulator.mjs")],
    });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    // 링크를 만들 수 있을 때 조직 A가 먼저 돌아 링크가 생겼다.
    await provider.adapter.execute(await env.requestFor(a), control());
    refusal = "EPERM";
    const signal = new AbortController().signal;
    for (const organizationId of [b, a]) {
      const result = await provider.adapter.execute(
        await env.requestFor(organizationId),
        control()
      );
      expect(result.errorCode).toBeUndefined();
    }
    expect(await provider.adapter.checkReadiness(signal)).toEqual({
      status: "ready",
      reason: null,
    });
    // 다시 링크를 만들 수 있게 되어도 두 조직 모두 같은 로그인을 읽는다.
    refusal = null;
    for (const organizationId of [a, b]) {
      const result = await provider.adapter.execute(
        await env.requestFor(organizationId),
        control()
      );
      expect(result.errorCode).toBeUndefined();
    }
  }, 30000);

  it("runs a Codex organization that already had a link with the login this machine wrote, not an older one", async () => {
    const env = await setup();
    const connection = path.join(env.root, "providers/codex");
    await mkdir(connection, { recursive: true });
    await writeFile(path.join(connection, "auth.json"), '{"old":1}');
    const reader = await codexReader(env.root);
    const provider = createCodexProvider({
      dataDir: env.root,
      command: reader.command,
    });
    const a = crypto.randomUUID();
    await provider.adapter.execute(await env.requestFor(a), control());
    expect(await reader.last()).toBe('{"old":1}');
    refusal = "EPERM";
    // 링크를 만들 수 없는 컴퓨터에서 다시 로그인하면 연결 폴더에 보통 파일로 남는다. 이것이 가장 최근 로그인이다.
    await rm(path.join(connection, "auth.json"));
    await writeFile(path.join(connection, "auth.json"), '{"new":1}');
    await provider.adapter.execute(await env.requestFor(a), control());
    expect(await reader.last()).toBe('{"new":1}');
    await provider.adapter.execute(await env.requestFor(), control());
    expect(await reader.last()).toBe('{"new":1}');
    // 다시 링크를 만들 수 있게 되면 가장 최근 로그인이 원본이 되어 모든 조직이 그것을 읽는다.
    refusal = null;
    await provider.adapter.execute(await env.requestFor(a), control());
    expect(await reader.last()).toBe('{"new":1}');
  }, 30000);
});
