import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileLogin, type FileLoginShape } from "./file-login.ts";
import { readRegularFile } from "./regular-file.ts";
import { testFolders } from "./test-folders.ts";

// 같은 조직의 두 실행 시도가 함께 자리 표시를 두는 순서를 고정한다. 실행 시도 폴더 밖의 첫 쓰기를 잡아 그 사이에 다른 시도를 돌리고,
// 그 시도의 열기가 "없음"으로 실패하면 첫 쓰기가 끝날 때까지 그 실패를 붙든다.
const race = vi.hoisted(() => ({
  /** 이 폴더들 안의 쓰기(실행 시도 전용 로그인 파일)는 잡지 않는다. */
  outside: [] as string[],
  holdFirstWrite: undefined as
    undefined | ((write: () => Promise<void>) => Promise<void>),
  onOpenMissing: undefined as undefined | (() => Promise<void>),
  /** 실행 시도 폴더 밖의 쓰기가 파일을 만든 뒤 이 오류로 실패한다(디스크가 찬 경우처럼). */
  failAfterCreate: undefined as Error | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof real.writeFile = async (file, ...rest) => {
    const failure = race.failAfterCreate;
    if (
      failure &&
      !race.outside.some((folder) => String(file).startsWith(folder))
    ) {
      await real.writeFile(file, "", rest[1]);
      throw failure;
    }
    const hold = race.holdFirstWrite;
    if (
      hold &&
      !race.outside.some((folder) => String(file).startsWith(folder))
    ) {
      race.holdFirstWrite = undefined;
      return hold(() => real.writeFile(file, ...rest));
    }
    return real.writeFile(file, ...rest);
  };
  const open: typeof real.open = async (...args) => {
    try {
      return await real.open(...args);
    } catch (error) {
      const missed = race.onOpenMissing;
      if (missed && hasErrorCode("ENOENT")(error)) {
        race.onOpenMissing = undefined;
        await missed();
      }
      throw error;
    }
  };
  return { ...real, writeFile, open, default: { ...real, writeFile, open } };
});
afterEach(() => {
  race.outside = [];
  race.holdFirstWrite = undefined;
  race.onOpenMissing = undefined;
  race.failAfterCreate = undefined;
});

const folders = testFolders();
const windows = process.platform === "win32";
const organizationId = "0b7f3c1e-0000-4000-8000-000000000002";

/** 로그인 자리가 조직 폴더 안 폴더 두 칸 아래에 있는 연결(Antigravity와 같은 모양). */
const nested: FileLoginShape = {
  label: "Nested",
  loginFile: path.join(".gemini", "antigravity-cli", "token"),
  contents: (token) => JSON.stringify({ token }),
  isStandIn: async (file) => {
    const text = await readRegularFile(file);
    return text !== undefined && text === JSON.stringify({ token: "" });
  },
};

// 조직 제품 폴더는 그 조직의 모든 컨테이너에 쓰기로 들어간다. 다른 실행 시도의 컨테이너가 로그인 자리로 가는 폴더를
// 연결의 로그인 전용 폴더를 가리키는 링크로 바꿔도, 서버가 자리 표시를 두면서 그 링크를 따라가 원본 로그인을 지우거나
// 덮어쓰면 안 된다. 검사(prepare)와 자리 표시(attemptLogin) 사이에 링크를 넣어 그 순서를 만든다.
describe("placing the login stand-in in a folder an isolated agent can write", () => {
  // Windows에서 링크를 만들려면 관리자 권한이나 개발자 모드가 필요하다. 링크 경우는 POSIX에서 본다.
  it.skipIf(windows)(
    "does not follow a folder link to the connection's own login",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      const login = fileLogin(root, "nested", nested);
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");

      const prepared = await login.prepare(organizationId, true);
      if (prepared.refusal !== undefined || !prepared.attemptLogin)
        throw new Error(`no isolated login: ${prepared.refusal}`);
      const organization = path.join(
        root,
        "providers",
        "nested",
        "organizations",
        organizationId
      );
      await mkdir(path.join(organization, ".gemini"), { recursive: true });
      // 조직 폴더 기준 상대 링크: .gemini/antigravity-cli → providers/nested/login
      await symlink(
        path.join("..", "..", "..", "login"),
        path.join(organization, ".gemini", "antigravity-cli")
      );
      const attempt = await folders.make("babojubot-attempt-");

      await expect(prepared.attemptLogin(attempt, "grant")).rejects.toThrow();
      expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
    }
  );

  it("places the stand-in in the organization's own folders", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attempt = await folders.make("babojubot-attempt-");

    const placed = await prepared.attemptLogin(attempt, "grant");
    expect(await readFile(placed.source, "utf8")).toBe(
      JSON.stringify({ token: "grant" })
    );
    expect(await readFile(placed.target, "utf8")).toBe(
      JSON.stringify({ token: "" })
    );
  });

  // 격리 실행의 컨테이너가 심어 둔 링크는 격리를 끈 뒤에도 남는다. 이 컴퓨터의 실행이 조직 자리에 링크를 만들며 그 링크를 따라가면
  // 연결의 원본 로그인을 set-aside로 옮기거나 지운다.
  it.skipIf(windows)(
    "does not follow a folder link an isolated run left when a host run links the login",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      const login = fileLogin(root, "nested", nested);
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");
      const organization = path.join(
        root,
        "providers",
        "nested",
        "organizations",
        organizationId
      );
      await mkdir(path.join(organization, ".gemini"), { recursive: true });
      await symlink(
        path.join("..", "..", "..", "login"),
        path.join(organization, ".gemini", "antigravity-cli")
      );

      await expect(login.prepare(organizationId, false)).rejects.toThrow(
        /not a folder/
      );
      expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
    }
  );

  // 같은 조직의 두 실행 시도가 함께 자리 표시를 둔다(#279 CI macOS 간헐 실패). 한쪽이 자리를 비우고 쓰는 사이에 다른 쪽이 확인하면
  // 열기는 "없음"인데 바로 뒤에는 파일이 있어 확인이 오류로 끝났다. 자리 표시는 완성된 파일로 한 번에 나타나야 하고, 이미 있는
  // 자리 표시는 다른 컨테이너가 그 위에 로그인을 넣고 있을 수 있어 바꾸지 않는다.
  it("lets two attempts of one organization place the stand-in at the same time", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attemptLogin = prepared.attemptLogin;
    const first = await folders.make("babojubot-attempt-");
    const second = await folders.make("babojubot-attempt-");
    race.outside = [first, second];
    let secondDone: Promise<unknown> = Promise.resolve();
    let missed!: () => void;
    const secondMissed = new Promise<void>((resolve) => (missed = resolve));
    let wrote!: () => void;
    const firstWrote = new Promise<void>((resolve) => (wrote = resolve));
    race.holdFirstWrite = async (write) => {
      race.onOpenMissing = async () => {
        missed();
        await firstWrote;
      };
      secondDone = attemptLogin(second, "grant-two");
      await Promise.race([
        secondMissed,
        secondDone.then(
          () => undefined,
          () => undefined
        ),
      ]);
      await write();
      wrote();
    };

    const placed = await attemptLogin(first, "grant-one");
    const other = (await secondDone) as typeof placed;
    expect(await readFile(placed.source, "utf8")).toBe(
      JSON.stringify({ token: "grant-one" })
    );
    expect(await readFile(other.source, "utf8")).toBe(
      JSON.stringify({ token: "grant-two" })
    );
    expect(await readFile(placed.target, "utf8")).toBe(
      JSON.stringify({ token: "" })
    );
    // 쓰다 만 임시 파일을 남기지 않는다.
    expect(await readdir(path.dirname(placed.target))).toEqual(["token"]);
  });

  // 자리 표시를 쓰다 실패해도 조직 폴더에 임시 파일을 남기지 않는다(#280 리뷰 2회차 STD-2).
  it("leaves no temporary file in the organization folder when writing the stand-in fails", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attempt = await folders.make("babojubot-attempt-");
    race.outside = [attempt];
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    race.failAfterCreate = full;
    await expect(prepared.attemptLogin(attempt, "grant")).rejects.toBe(full);
    const place = path.join(
      root,
      "providers",
      "nested",
      "organizations",
      organizationId,
      ".gemini",
      "antigravity-cli"
    );
    expect(await readdir(place)).toEqual([]);
  });
});
