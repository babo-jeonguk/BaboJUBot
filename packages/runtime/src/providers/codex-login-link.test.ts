import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  hasErrorCode,
  orIfMissing,
  type RunRequest,
} from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexProvider as unownedCodexProvider } from "./codex.ts";
import { loginLink } from "./login-link.ts";
import { request } from "./test-support.ts";
import { testFolders } from "./test-folders.ts";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { insideFolder, realPlace } from "@babojubot/process/test-support";

// Codex 로그인 하나를 연결의 모든 조직이 링크로 같이 쓴다(docs/research/org-product-folders-references.md 사용자 결정).
// 링크를 만들 수 없는 컴퓨터와 여러 조직이 한꺼번에 시작하는 장면에서도 로그인이 남아야 한다.

/**
 * 이 폴더(`in`, 그 시험의 폴더) 안의 링크 만들기를 거절한다(권한 없는 Windows·링크를 모르는 파일 시스템). 거절한 링크 자리를
 * `refused`에 남긴다(시험이 거절이 실제로 그 시험의 자리에서 났는지 본다, #286).
 */
let refusal: { in: string; refused: string[] } | undefined;
// 원본 로그인을 옮기는 rename 하나를 붙잡아 둔다. 링크를 임시 이름에서 제자리로 옮기는 rename은 세지 않는다.
let gatedOriginal: string | undefined;
let heldOriginalRename: Promise<void> | undefined;
let originalRenames = 0;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: (...args: Parameters<typeof actual.symlink>) => {
      // 결함은 불린 순간(대역 몸 안, 기다리기 전) 읽는다.
      if (!refusal || !insideFolder(refusal.in, String(args[1])))
        return actual.symlink(...args);
      // handle을 거친 경로(`/proc/self/fd/<n>/…`)는 시험이 handle을 닫은 뒤에도 볼 수 있게 폴더의 실제 경로로 남긴다.
      const link = String(args[1]);
      refusal.refused.push(realPlace(link));
      return Promise.reject(
        Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        })
      );
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (gatedOriginal && String(args[1]) === gatedOriginal) {
        originalRenames += 1;
        if (heldOriginalRename)
          return heldOriginalRename.then(() => actual.rename(...args));
      }
      return actual.rename(...args);
    },
  };
});

afterEach(() => {
  refusal = undefined;
  gatedOriginal = undefined;
  heldOriginalRename = undefined;
  originalRenames = 0;
});
// 시험이 시작한 준비 확인·실행은 정리가 멈추고 끝나기를 기다린 뒤에 폴더를 지운다(ownProvider). 단언이 실패하거나 시한을 넘긴 시험도 같다.
const folders = testFolders();
// 이 파일이 만드는 프로바이더 연결은 모두 정리가 실행을 맡는다(시험 표에 담아 넘긴 factory도 같다).
const createCodexProvider = folders.owning(unownedCodexProvider);
const control = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});

async function setup() {
  // 제품이 확인한 폴더 handle로 다루는 경로도 이 폴더로 가를 수 있게 실제 경로로 둔다(`insideFolder`).
  const root = await realpath(await folders.make("babojubot-codex-login-"));
  const dump = path.join(root, "env.jsonl");
  const script = path.join(root, "dump-env.cjs");
  // 받은 환경을 한 줄로 남기고 끝나는 프로그램. 실행은 실패하지만 어느 폴더로 띄웠는지는 남는다.
  await writeFile(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env) + "\\n");`
  );
  const connection = path.join(root, "providers/codex");
  await mkdir(connection, { recursive: true });
  // 연결 폴더에 바로 있는 로그인(로그인 명령이 쓴 파일, 예전 판의 로그인).
  await writeFile(path.join(connection, "auth.json"), '{"synthetic":1}');
  const provider = createCodexProvider({
    dataDir: root,
    command: [process.execPath, script],
  });
  const requestFor = async (organizationId: string): Promise<RunRequest> => {
    const input = request();
    input.identity.organizationId = organizationId;
    input.context.organization.id = organizationId;
    const shared = path.join(root, "organizations", organizationId, "shared");
    await mkdir(shared, { recursive: true });
    return { ...input, workspace: { cwd: shared, organization: shared } };
  };
  // 프로그램이 돌기 전에는 파일이 없다. 없음만 빈 기록으로 보고, 그 밖의 읽기 실패는 드러낸다.
  const dumps = async (): Promise<NodeJS.ProcessEnv[]> =>
    (
      await orIfMissing(
        () => readFile(dump, "utf8"),
        hasErrorCode("ENOENT"),
        ""
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NodeJS.ProcessEnv);
  return { root, connection, provider, requestFor, dumps };
}

describe("Codex login link", () => {
  it("leaves the login in the connection folder when this machine cannot create file links", async () => {
    const env = await setup();
    const refused = { in: env.root, refused: [] as string[] };
    refusal = refused;
    await env.provider.adapter.checkReadiness(new AbortController().signal);
    const input = await env.requestFor(crypto.randomUUID());
    await env.provider.adapter.execute(input, control());
    // 링크 없이 도는 실행은 연결 폴더를 쓰므로 로그인도 그 자리에 그대로 있어야 한다.
    const login = path.join(env.connection, "auth.json");
    expect((await lstat(login)).isFile()).toBe(true);
    expect(await readFile(login, "utf8")).toBe('{"synthetic":1}');
    await expect(
      lstat(path.join(env.connection, "login", "auth.json"))
    ).rejects.toThrow();
    const dumped = await env.dumps();
    expect(dumped.length).toBeGreaterThan(0);
    for (const one of dumped) expect(one.CODEX_HOME).toBe(env.connection);
    // 거절은 준비 확인과 실행이 연결 자리에, 실행이 그 조직 자리에 링크를 만들려 할 때 났다(제품은 링크를 그 자리의 폴더에
    // 임시 이름으로 먼저 만든다. 대역이 받은 정확한 경로의 폴더로 본다).
    expect([...new Set(refused.refused.map(path.dirname))]).toEqual([
      env.connection,
      path.join(env.connection, "organizations", input.identity.organizationId),
    ]);
  });

  it("moves the connection's login once when several organizations start together", async () => {
    // 첫 실행 직후 여러 조직과 준비 확인이 한꺼번에 같은 로그인을 옮긴다.
    const env = await setup();
    const organizations = [1, 2, 3].map(() => crypto.randomUUID());
    const requests = await Promise.all(organizations.map(env.requestFor));
    const started = await Promise.allSettled([
      ...[1, 2, 3, 4].map(() =>
        env.provider.adapter.checkReadiness(new AbortController().signal)
      ),
      ...requests.map((input) =>
        env.provider.adapter.execute(input, control())
      ),
    ]);
    const readiness = started.slice(0, 4);
    const executions = started.slice(4);
    expect(readiness).toHaveLength(4);
    expect(executions).toHaveLength(3);
    for (const one of readiness) {
      expect(one.status).toBe("fulfilled");
      if (one.status === "fulfilled")
        expect(one.value).toEqual({
          status: "unknown",
          reason: "credentials_unverified",
        });
    }
    for (const one of executions) {
      expect(one.status).toBe("fulfilled");
      if (one.status === "fulfilled")
        expect(one.value).toMatchObject({ stopReason: "failed" });
    }
    const original = path.join(env.connection, "login", "auth.json");
    expect((await lstat(original)).isFile()).toBe(true);
    expect(await readFile(original, "utf8")).toBe('{"synthetic":1}');
    for (const at of [
      path.join(env.connection, "auth.json"),
      ...organizations.map((organizationId) =>
        path.join(env.connection, "organizations", organizationId, "auth.json")
      ),
    ]) {
      expect(await readlink(at)).toBe(original);
      expect(await readFile(at, "utf8")).toBe('{"synthetic":1}');
    }
  });

  it("serializes concurrent link calls for one login at the original migration", async () => {
    // 제품이 확인한 폴더 handle로 다루는 경로도 이 폴더로 가를 수 있게 실제 경로로 둔다(`insideFolder`).
    const root = await realpath(await folders.make("babojubot-codex-login-"));
    const connection = path.join(root, "providers/codex");
    const original = path.join(connection, "login", "auth.json");
    const fallback = path.join(connection, "auth.json");
    const links = ["one", "two", "three"].map((name) =>
      path.join(connection, "links", name, "auth.json")
    );
    await mkdir(connection, { recursive: true });
    await writeFile(fallback, '{"synthetic":1}');
    // 제품처럼 연결 폴더의 set-aside에 치운 로그인을 둔다(codex.ts).
    const setAside = path.join(connection, "set-aside");
    const share = loginLink({ original, fallback, label: "Codex", setAside });
    // 같은 원본에 대한 별도의 loginLink 클로저도 같은 차례를 지켜야 한다.
    const otherShare = loginLink({
      original,
      fallback,
      label: "Codex",
      setAside,
    });

    originalRenames = 0;
    gatedOriginal = original;
    let release!: () => void;
    heldOriginalRename = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = 0;
    const track = (operation: Promise<boolean>) =>
      operation.then((value) => {
        completed += 1;
        return value;
      });
    const operations = [
      share(fallback),
      otherShare(links[0]!),
      share(links[1]!),
      otherShare(links[2]!),
    ].map(track);
    let settled: PromiseSettledResult<boolean>[] = [];
    // 붙잡은 rename을 풀고 모든 호출이 끝난 뒤에 결과를 본다.
    await withCleanup(async (defer) => {
      defer(async () => {
        release();
        settled = await Promise.allSettled(operations);
      });
      // 첫 호출이 원본 로그인을 옮기는 rename에 들어갔다. 그동안 다른 호출은 그 rename에 들어오지 못한다.
      // 다른 호출이 시작하는 시간을 담아 느린 실행기를 감당하게 기다린다(#215).
      await vi.waitFor(
        () => {
          expect(originalRenames).toBe(1);
          expect(completed).toBe(0);
        },
        { timeout: 15_000 }
      );
    });
    const results = settled.flatMap((one) =>
      one.status === "fulfilled" ? [one.value] : []
    );
    expect(results).toEqual([true, true, true, true]);
    expect(originalRenames).toBe(1);
    expect((await lstat(original)).isFile()).toBe(true);
    expect(await readFile(original, "utf8")).toBe('{"synthetic":1}');
    for (const at of [fallback, ...links]) {
      expect(await readlink(at)).toBe(original);
      expect(await readFile(at, "utf8")).toBe('{"synthetic":1}');
    }
  });
});
