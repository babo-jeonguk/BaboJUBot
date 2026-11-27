import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RunRequest } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginLink } from "./login-link.ts";
import { createAntigravityProvider as unownedAntigravityProvider } from "./antigravity.ts";
import { createCodexProvider as unownedCodexProvider } from "./codex.ts";
import {
  insideFolder,
  permissionDenial,
  realPlace,
} from "@babojubot/process/test-support";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";

// 링크를 만들 수 없는 컴퓨터에서는 실행이 연결 폴더로 대신 돈다. 그때도 연결의 로그인 하나를 읽어야 한다.
// 로그인 원본이 이미 로그인 전용 폴더로 옮겨진 뒤(다른 컴퓨터에서 옮긴 제품 폴더, 링크만 사라진 경우)도 같다(PR #135 SPEC-1).

/**
 * 이 폴더(`in`, 그 시험의 폴더) 안의 링크 만들기를 이 오류 코드로 거절한다(권한 없는 Windows(EPERM)·링크를 모르는 파일
 * 시스템(ENOTSUP·EOPNOTSUPP)). 거절한 링크 자리를 `refused`에 남긴다(시험이 거절이 실제로 그 시험의 자리에서 났는지 본다, #286).
 */
let refusal: { in: string; code: string; refused: string[] } | undefined;
/**
 * 이 폴더(`in`, 그 시험의 조직 자리 폴더) 안에서 옮기기(`rename`)와 지우기(`rm`)가 이 오류로 실패한다. 실패시킨 옮기기의
 * 출발·도착 경로를 `renamed`에, 지우기 경로를 `removed`에 남긴다.
 */
let linkFailures:
  | {
      in: string;
      rename: Error;
      rm: Error;
      renamed: { from: string; to: string }[];
      removed: string[];
    }
  | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // 결함은 불린 순간(대역 몸 안, 기다리기 전) 읽는다.
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (!linkFailures || !insideFolder(linkFailures.in, String(args[0])))
        return actual.rename(...args);
      linkFailures.renamed.push({
        from: String(args[0]),
        to: String(args[1]),
      });
      return Promise.reject(linkFailures.rename);
    },
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (!linkFailures || !insideFolder(linkFailures.in, String(args[0])))
        return actual.rm(...args);
      linkFailures.removed.push(String(args[0]));
      return Promise.reject(linkFailures.rm);
    },
    symlink: (...args: Parameters<typeof actual.symlink>) => {
      if (!refusal || !insideFolder(refusal.in, String(args[1])))
        return actual.symlink(...args);
      // handle을 거친 경로(`/proc/self/fd/<n>/…`)는 시험이 handle을 닫은 뒤에도 볼 수 있게 폴더의 실제 경로로 남긴다.
      const link = String(args[1]);
      refusal.refused.push(realPlace(link));
      return Promise.reject(
        Object.assign(new Error(`${refusal.code}: cannot link`), {
          code: refusal.code,
        })
      );
    },
  };
});

const folders = testFolders();
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createCodexProvider = folders.owning(unownedCodexProvider);
const createAntigravityProvider = folders.owning(unownedAntigravityProvider);
afterEach(async () => {
  refusal = undefined;
  linkFailures = undefined;
  vi.restoreAllMocks();
});
const control = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});
const fixture = (name: string) => path.resolve("test-fixtures", name);

async function setup() {
  // 제품이 확인한 폴더 handle로 다루는 경로도 이 폴더로 가를 수 있게 실제 경로로 둔다(`insideFolder`).
  const root = await realpath(await folders.make("babojubot-login-link-"));
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

/** 그 시험의 폴더 안 링크 만들기를 `code`로 거절하기 시작한다. 거절한 자리는 돌려준 무장의 `refused`에 남는다. */
function refuseLinks(folder: string, code: string) {
  const armed = { in: folder, code, refused: [] as string[] };
  refusal = armed;
  return armed;
}
/** 링크 만들기가 거절된 폴더들(처음 거절된 차례). 제품은 링크를 그 자리의 폴더에 임시 이름으로 먼저 만든다. */
const refusedFolders = (refused: string[]) => [
  ...new Set(refused.map(path.dirname)),
];

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
      const refused = refuseLinks(env.root, code);
      const provider = createAntigravityProvider({
        dataDir: env.root,
        command: [process.execPath, fixture("antigravity-simulator.mjs")],
      });
      expect(
        await provider.adapter.checkReadiness(new AbortController().signal)
      ).toEqual({ status: "ready", reason: null });
      const input = await env.requestFor();
      const result = await provider.adapter.execute(input, control());
      // 이 시험의 도구 주소는 닿지 않아 실행은 실패하지만, 로그인은 보여야 한다.
      expect(result.errorCode).toBeUndefined();
      expect(await readFile(antigravityToken(connection), "utf8")).toBe(
        '{"synthetic":1}'
      );
      // 거절은 준비 확인과 실행이 연결 자리에, 실행이 그 조직 자리에 링크를 만들려 할 때 났다.
      expect(refusedFolders(refused.refused)).toEqual([
        path.dirname(antigravityToken(connection)),
        path.dirname(
          antigravityToken(
            path.join(
              connection,
              "organizations",
              input.identity.organizationId
            )
          )
        ),
      ]);
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
      const refused = refuseLinks(env.root, code);
      const provider = createCodexProvider({
        dataDir: env.root,
        command: [process.execPath, script],
      });
      const input = await env.requestFor();
      await provider.adapter.execute(input, control());
      expect((await readFile(dump, "utf8")).trim().split("\n").at(-1)).toBe(
        '{"synthetic":1}'
      );
      expect(refusedFolders(refused.refused)).toEqual([
        connection,
        path.join(connection, "organizations", input.identity.organizationId),
      ]);
    }, 20000);

    it.skipIf(!permissionDenial())(
      "is not ready when the login that runs read cannot be rewritten",
      async () => {
        const env = await setup();
        const connection = path.join(env.root, "providers/antigravity");
        await mkdir(path.dirname(antigravityToken(connection)), {
          recursive: true,
        });
        await writeFile(antigravityToken(connection), '{"synthetic":1}');
        await chmod(antigravityToken(connection), 0o400);
        const refused = refuseLinks(env.root, code);
        expect(
          await createAntigravityProvider({
            dataDir: env.root,
            command: [process.execPath, fixture("antigravity-simulator.mjs")],
          }).adapter.checkReadiness(new AbortController().signal)
        ).toEqual({ status: "not_ready", reason: "check_failed" });
        expect(refused.refused.map(path.dirname)).toEqual([
          path.dirname(antigravityToken(connection)),
        ]);
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
    "is never taken as the %s connection's login: a run on this machine sets it aside in the connection folder and links the organization to the original",
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
      // 치운 파일은 컨테이너에 넣는 조직 제품 폴더가 아니라 이 컴퓨터만 쓰는 연결 폴더에 둔다(#148 PR #171 SP-1).
      await expect(readFile(`${planted}.set-aside`, "utf8")).rejects.toThrow();
      const kept = path.join(connection, "set-aside");
      const files = await readdir(kept);
      expect(files).toHaveLength(1);
      expect(await readFile(path.join(kept, files[0]!), "utf8")).toBe(
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
    const refused = refuseLinks(env.root, "EPERM");
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
    const organization = (id: string) =>
      path.dirname(
        antigravityToken(path.join(connection, "organizations", id))
      );
    expect(refusedFolders(refused.refused)).toEqual([
      path.dirname(antigravityToken(connection)),
      organization(b),
      organization(a),
    ]);
    // 다시 링크를 만들 수 있게 되어도 두 조직 모두 같은 로그인을 읽는다.
    refusal = undefined;
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
    const refused = refuseLinks(env.root, "EPERM");
    // 링크를 만들 수 없는 컴퓨터에서 다시 로그인하면 연결 폴더에 보통 파일로 남는다. 이것이 가장 최근 로그인이다.
    await rm(path.join(connection, "auth.json"));
    await writeFile(path.join(connection, "auth.json"), '{"new":1}');
    await provider.adapter.execute(await env.requestFor(a), control());
    expect(await reader.last()).toBe('{"new":1}');
    const other = await env.requestFor();
    await provider.adapter.execute(other, control());
    expect(await reader.last()).toBe('{"new":1}');
    const organization = (id: string) =>
      path.join(connection, "organizations", id);
    expect(refusedFolders(refused.refused)).toEqual([
      connection,
      organization(a),
      organization(other.identity.organizationId),
    ]);
    // 다시 링크를 만들 수 있게 되면 가장 최근 로그인이 원본이 되어 모든 조직이 그것을 읽는다.
    refusal = undefined;
    await provider.adapter.execute(await env.requestFor(a), control());
    expect(await reader.last()).toBe('{"new":1}');
  }, 30000);
});

// 임시 링크를 제자리로 옮기지 못하고 그 임시 링크도 지우지 못하면, 지우기 실패가 원래 실패를 덮지 않는다(#280 리뷰 2회차 STD-2와 같은 모양).
// Windows에서 링크를 만들려면 권한이 필요하다. 링크를 만들지 못하면 이 길을 타지 않는다.
it.skipIf(process.platform === "win32")(
  "throws the failure to place the link, not the failure to remove the temporary link",
  async () => {
    const root = await realpath(await folders.make("babojubot-login-link-"));
    const original = path.join(root, "login", "auth.json");
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, "{}");
    const share = loginLink({
      original,
      fallback: path.join(root, "connection", "auth.json"),
      label: "Synthetic",
      setAside: path.join(root, "set-aside"),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
    const at = path.join(root, "organization", "auth.json");
    const failing = {
      in: path.dirname(at),
      rename: busy,
      rm: Object.assign(new Error("io"), { code: "EIO" }),
      renamed: [] as { from: string; to: string }[],
      removed: [] as string[],
    };
    linkFailures = failing;
    await expect(share(at)).rejects.toBe(busy);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO"));
    // 옮기기는 그 자리로 옮기는 하나에서 실패했고, 지우기는 그때 옮기려던 임시 링크에서 실패했다.
    expect(failing.renamed.map(({ to }) => to)).toEqual([at]);
    expect(failing.removed).toEqual(failing.renamed.map(({ from }) => from));
  }
);
