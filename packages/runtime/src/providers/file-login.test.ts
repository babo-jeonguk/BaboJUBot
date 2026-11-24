import {
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "@babojubot/contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  /** 로그인 자리 이름(`token`)으로 옮겨 둔 횟수. 자리 표시를 게시한 횟수다. */
  published: 0,
  /** 제품이 키 하나의 차례를 청할 때 그 키로 부른다(`oneAtATime`). */
  turnRequested: undefined as undefined | ((key: string) => void),
}));
// 같은 자리의 확인과 게시는 키마다 차례로 한다(`./one-at-a-time.ts`). 차례를 청한 것을 시험이 본다. 기다리는 쪽은 아무 일도
// 하지 않으므로, 이 신호가 없으면 "기다리는 중"을 알 수 없다.
vi.mock("./one-at-a-time.ts", async (importOriginal) => {
  const real = await importOriginal<{
    oneAtATime: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  }>();
  return {
    oneAtATime: <T>(key: string, task: () => Promise<T>) => {
      race.turnRequested?.(key);
      return real.oneAtATime(key, task);
    },
  };
});
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
  const rename: typeof real.rename = async (from, to) => {
    await real.rename(from, to);
    if (path.basename(String(to)) === "token") race.published++;
  };
  return {
    ...real,
    writeFile,
    open,
    rename,
    default: { ...real, writeFile, open, rename },
  };
});
afterEach(() => {
  race.outside = [];
  race.holdFirstWrite = undefined;
  race.onOpenMissing = undefined;
  race.failAfterCreate = undefined;
  race.published = 0;
  race.turnRequested = undefined;
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

  // 같은 조직의 두 실행 시도가 함께 자리 표시를 둔다(#279 CI macOS 간헐 실패). 자리 표시는 완성된 파일로 한 번에 나타나야 하고,
  // 먼저 게시한 자리 표시는 바뀌면 안 된다: 그 실행 시도의 컨테이너가 그 파일 위에 로그인을 넣었고, 파일이 바뀌면 그 마운트가
  // 떨어져 나간다. 그래서 자리를 확인하고 게시하는 일은 자리마다 하나씩 한다. 먼저 온 시도가 게시하는 도중(임시 파일 쓰기)에
  // 다른 시도를 시작하고, 그 시도가 차례를 청하거나(차례로 함) 자리를 확인해 없음을 보면(함께 함) 먼저 온 시도의 쓰기를 푼다
  // (#286 항목 6). 이 시험은 앞서 두 시도가 함께 확인하는 것을 전제로 했으나, 그 동작이 먼저 게시한 파일을 바꾸므로 고쳤다.
  it("lets two attempts of one organization place the stand-in one after the other, never replacing the one placed first", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attemptLogin = prepared.attemptLogin;
    // 준비(prepare)는 연결 폴더에 로그인 링크를 두며 같은 이름(`token`)으로 옮긴다. 자리 표시 게시만 센다.
    race.published = 0;
    const place = path.join(
      root,
      "providers",
      "nested",
      "organizations",
      organizationId,
      nested.loginFile
    );
    const first = await folders.make("babojubot-attempt-");
    const second = await folders.make("babojubot-attempt-");
    race.outside = [first, second];
    let secondDone: Promise<unknown> = Promise.resolve();
    let checkedWhilePlacing = false;
    race.holdFirstWrite = async (write) => {
      const secondArrived = new Promise<void>((resolve) => {
        race.turnRequested = (key) => {
          if (key === place) resolve();
        };
        race.onOpenMissing = async () => {
          checkedWhilePlacing = true;
          resolve();
        };
      });
      secondDone = attemptLogin(second, "grant-two");
      await secondArrived;
      await write();
    };

    const placed = await attemptLogin(first, "grant-one");
    const other = (await secondDone) as typeof placed;
    expect(checkedWhilePlacing).toBe(false);
    expect(race.published).toBe(1);
    expect(placed.target).toBe(place);
    expect(other.target).toBe(place);
    expect(await readFile(placed.source, "utf8")).toBe(
      JSON.stringify({ token: "grant-one" })
    );
    expect(await readFile(other.source, "utf8")).toBe(
      JSON.stringify({ token: "grant-two" })
    );
    expect(await readFile(place, "utf8")).toBe(JSON.stringify({ token: "" }));
    // 쓰다 만 임시 파일을 남기지 않는다.
    expect(await readdir(path.dirname(place))).toEqual(["token"]);
  });

  // 격리를 끈 실행은 조직 자리의 자리 표시를 지우고 연결의 로그인 링크를 둔다. 자리 표시인지 확인한 뒤 그 이름에 그 조직의
  // 컨테이너가 다른 파일을 두면, 그 파일은 확인한 것이 아니므로 지우지 않는다(#286 항목 8과 같은 모양). 링크를 둘 때 그 자리의
  // 보통 파일은 연결 폴더의 set-aside로 옮겨진다.
  it.skipIf(windows)(
    "does not remove a file put in place of the stand-in after it was checked, when a host run links the login",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      let hostRun = false;
      let swapped = false;
      const login = fileLogin(root, "nested", {
        ...nested,
        isStandIn: async (file) => {
          const real = await nested.isStandIn(file);
          if (hostRun && real && !swapped) {
            swapped = true;
            const saving = path.join(path.dirname(file), ".agent-save");
            await writeFile(saving, "agent file");
            await rename(saving, file);
          }
          return real;
        },
      });
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");
      const isolated = await login.prepare(organizationId, true);
      if (isolated.refusal !== undefined || !isolated.attemptLogin)
        throw new Error(`no isolated login: ${isolated.refusal}`);
      await isolated.attemptLogin(
        await folders.make("babojubot-attempt-"),
        "grant"
      );

      hostRun = true;
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      await login.prepare(organizationId, false);
      expect(swapped).toBe(true);
      // 확인해 보니 자리 표시가 아니어서 되돌린 것은 지운 것이 아니다. 그 까닭을 남긴다(#286 리뷰 1회차 SPEC-1).
      expect(warned.mock.calls.map(([line]) => String(line))).toContain(
        "[provider] a file put in place of the Nested login stand-in after it was checked was put back; it is not removed"
      );
      const setAside = path.join(root, "providers", "nested", "set-aside");
      const kept = await Promise.all(
        (await readdir(setAside)).map((name) =>
          readFile(path.join(setAside, name), "utf8")
        )
      );
      expect(kept).toEqual(["agent file"]);
      expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
    }
  );

  // 옮긴 자리 표시를 다시 확인하는 사이 원래 이름에 다른 파일이 저장돼 되돌리지 못하면 옮긴 이름에 남긴다. 그 위치는 폴더 handle의
  // 경로(Linux `/proc/self/fd/…`)가 아니라 조직 폴더 기준으로 남겨, handle을 닫은 뒤에도 그 위치로 찾을 수 있다(#296 외부 리뷰
  // 1회차 STD-1·SPEC-2).
  it.skipIf(windows)(
    "records where it kept an unconfirmed file relative to the organization folder, so it can be found after the folder is let go",
    async () => {
      const root = await folders.make("babojubot-file-login-");
      let hostRun = false;
      const login = fileLogin(root, "nested", {
        ...nested,
        isStandIn: async (file) => {
          // 옮긴 이름의 확인: 그 사이 원래 이름에 다른 파일이 저장되고, 옮긴 것은 자리 표시가 아니라고 답한다.
          if (hostRun && file.endsWith(".removing")) {
            await writeFile(
              path.join(path.dirname(file), "token"),
              "agent file"
            );
            return false;
          }
          return nested.isStandIn(file);
        },
      });
      const original = path.join(root, "providers", "nested", "login", "token");
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, "REAL LOGIN");
      const isolated = await login.prepare(organizationId, true);
      if (isolated.refusal !== undefined || !isolated.attemptLogin)
        throw new Error(`no isolated login: ${isolated.refusal}`);
      await isolated.attemptLogin(
        await folders.make("babojubot-attempt-"),
        "grant"
      );

      hostRun = true;
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warned.mockRestore());
      await login.prepare(organizationId, false);
      const kept = warned.mock.calls.flatMap(([line]) => {
        const found =
          /^\[provider\] a file put in place of the Nested login stand-in was kept as "(.+)" in the organization folder$/.exec(
            String(line)
          );
        return found ? [found[1]!] : [];
      });
      expect(kept).toEqual([
        expect.stringMatching(
          /^\.gemini\/antigravity-cli\/\.token\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/
        ),
      ]);
      const organizationFolder = path.join(
        root,
        "providers",
        "nested",
        "organizations",
        organizationId
      );
      expect(
        await readFile(path.join(organizationFolder, kept[0]!), "utf8")
      ).toBe(JSON.stringify({ token: "" }));
    }
  );

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
