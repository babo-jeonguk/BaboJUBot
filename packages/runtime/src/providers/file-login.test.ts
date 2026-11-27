import {
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  attemptEach,
  combinedFailure,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts";
import { fileLinks } from "@babojubot/process/test-support";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fileLogin, type FileLoginShape } from "./file-login.ts";
import { readRegularFile } from "./regular-file.ts";
import { testFolders } from "./test-folders.ts";
import { attemptFolder } from "./attempt-folder.ts";

/** 시험 폴더를 실행 시도 폴더로 감싼다. 로그인 파일은 그 폴더의 자격 증명 사본으로 기록된다(정리는 시험 폴더가 맡는다). */
const attemptAt = (folder: string) =>
  attemptFolder(folder, { kind: "attempt folder", connection: "test" });

// 같은 조직의 두 실행 시도가 함께 자리 표시를 두는 순서를 고정한다. 자리 표시 폴더의 첫 쓰기를 잡아 그 사이에 다른 시도를 돌리고,
// 그 시도의 열기가 "없음"으로 실패하면 첫 쓰기가 끝날 때까지 그 실패를 붙든다. 결함·붙잡기는 모두 그 시험이 고른 폴더(`in`, 실제
// 경로)에서만 건다: 제품은 그 폴더를 handle을 거친 경로(Linux `/proc/self/fd/<n>/…`, #278)로 다루므로 대역은 쓰는 자리의 폴더를
// 실제 경로로 풀어(`realpathSync`) 비교한다.
const race = vi.hoisted(() => ({
  /** 이 폴더의 첫 쓰기를 붙잡는다. */
  holdFirstWrite: undefined as
    | undefined
    | { in: string; hold: (write: () => Promise<void>) => Promise<void> },
  /** 이 폴더의 열기를 모두 적고(`opened`), "없음"으로 실패한 열기마다 `missing`을 부른다. */
  onOpen: undefined as
    undefined | { in: string; missing: () => Promise<void>; opened: string[] },
  /** 이 폴더의 쓰기가 파일을 만든 뒤 이 오류로 실패한다(디스크가 찬 경우처럼). */
  failAfterCreate: undefined as undefined | { in: string; error: Error },
  /** 이 폴더에서 로그인 자리 이름(`token`)으로 옮긴 대상. 자리 표시를 게시한 자리다. */
  published: undefined as undefined | { in: string; renamed: string[] },
  /** 제품이 이 키(`at`, 그 시험의 로그인 자리)의 차례를 청하면(`oneAtATime`) `requested`에 남기고 `arrived`를 부른다. */
  turnRequested: undefined as
    undefined | { at: string; requested: string[]; arrived: () => void },
}));
// 같은 자리의 확인과 게시는 키마다 차례로 한다(`./one-at-a-time.ts`). 차례를 청한 것을 시험이 본다. 기다리는 쪽은 아무 일도
// 하지 않으므로, 이 신호가 없으면 "기다리는 중"을 알 수 없다.
vi.mock("./one-at-a-time.ts", async (importOriginal) => {
  const real = await importOriginal<{
    oneAtATime: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  }>();
  return {
    oneAtATime: <T>(key: string, task: () => Promise<T>) => {
      const turn = race.turnRequested;
      if (turn?.at === key) {
        turn.requested.push(key);
        turn.arrived();
      }
      return real.oneAtATime(key, task);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  /** 쓰거나 여는 자리의 폴더의 실제 경로. 그 폴더가 없으면 시험이 고른(있는) 폴더가 아니다. */
  const folderOf = (file: unknown) =>
    orIfMissing(
      () => realpathSync(path.dirname(String(file))),
      hasErrorCode("ENOENT"),
      undefined
    );
  // 대역은 칸을 불린 순간(첫 await 전) 모두 잡고 그 뒤에는 잡은 것만 쓴다(tests/hoisted-state-at-call).
  const writeFile: typeof real.writeFile = async (file, ...rest) => {
    const { failAfterCreate: failure, holdFirstWrite: hold } = race;
    const folder = folderOf(file);
    const failing = failure?.in === folder ? failure : undefined;
    const held = !failing && hold?.in === folder ? hold : undefined;
    if (held) race.holdFirstWrite = undefined;
    if (failing) {
      await real.writeFile(file, "", rest[1]);
      throw failing.error;
    }
    if (held) return held.hold(() => real.writeFile(file, ...rest));
    return real.writeFile(file, ...rest);
  };
  const open: typeof real.open = async (...args) => {
    const { onOpen } = race;
    const watched = onOpen?.in === folderOf(args[0]) ? onOpen : undefined;
    watched?.opened.push(String(args[0]));
    try {
      return await real.open(...args);
    } catch (error) {
      // 불린 순간 잡은 동작만 부른다. 그 동작(시험이 둔 것)은 여러 번 불려도 같은 결과다(표시와 풀기).
      if (watched && hasErrorCode("ENOENT")(error)) {
        // 주입한 동작이 실패해도 원래 열기 실패를 잃지 않는다. 둘을 함께 던진다.
        const failures = await attemptEach([watched.missing]);
        if (failures.length)
          throw combinedFailure(
            [error, ...failures],
            "the open failed and the hook injected at that moment failed too"
          );
      }
      throw error;
    }
  };
  const rename: typeof real.rename = async (from, to) => {
    const { published } = race;
    const recording =
      published?.in === folderOf(to) && path.basename(String(to)) === "token"
        ? published
        : undefined;
    await real.rename(from, to);
    recording?.renamed.push(String(to));
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
  race.holdFirstWrite = undefined;
  race.onOpen = undefined;
  race.failAfterCreate = undefined;
  race.published = undefined;
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
  // 폴더 링크는 모든 시스템에서 본다. Windows의 폴더 링크(junction)는 권한 없이 만들 수 있고, 다른 시스템은 `"junction"`을
  // 무시하고 폴더를 가리키는 링크를 만든다(Node `fs.symlink`). junction의 대상은 절대 경로여야 한다.
  it("does not follow a folder link to the connection's own login", async () => {
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
    // .gemini/antigravity-cli → providers/nested/login
    await symlink(
      path.dirname(original),
      path.join(organization, ".gemini", "antigravity-cli"),
      "junction"
    );
    const attempt = await folders.make("babojubot-attempt-");

    await expect(
      prepared.attemptLogin(attemptAt(attempt), "grant")
    ).rejects.toMatchObject({
      message:
        "the login place in the organization folder is not a folder; the stand-in was not placed",
    });
    expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
  });

  it("places the stand-in in the organization's own folders", async () => {
    const root = await folders.make("babojubot-file-login-");
    const login = fileLogin(root, "nested", nested);
    const prepared = await login.prepare(organizationId, true);
    if (prepared.refusal !== undefined || !prepared.attemptLogin)
      throw new Error(`no isolated login: ${prepared.refusal}`);
    const attempt = await folders.make("babojubot-attempt-");

    const placed = await prepared.attemptLogin(attemptAt(attempt), "grant");
    expect(await readFile(placed.source, "utf8")).toBe(
      JSON.stringify({ token: "grant" })
    );
    expect(await readFile(placed.target, "utf8")).toBe(
      JSON.stringify({ token: "" })
    );
  });

  // 격리 실행의 컨테이너가 심어 둔 링크는 격리를 끈 뒤에도 남는다. 이 컴퓨터의 실행이 조직 자리에 링크를 만들며 그 링크를 따라가면
  // 연결의 원본 로그인을 set-aside로 옮기거나 지운다.
  it("does not follow a folder link an isolated run left when a host run links the login", async () => {
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
      path.dirname(original),
      path.join(organization, ".gemini", "antigravity-cli"),
      "junction"
    );

    await expect(login.prepare(organizationId, false)).rejects.toThrow(
      /not a folder/
    );
    expect(await readFile(original, "utf8")).toBe("REAL LOGIN");
  });

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
    const place = path.join(
      root,
      "providers",
      "nested",
      "organizations",
      organizationId,
      nested.loginFile
    );
    // 붙잡기·감시·게시 기록은 이 시험의 자리 표시 폴더에서만 한다(준비가 연결 폴더에 `token`으로 옮기는 것은 세지 않는다). 그 폴더는
    // 제품이 나중에 만들므로 있는 `root`의 실제 경로 아래로 적는다(대역은 쓰는 자리의 폴더를 실제 경로로 푼다).
    const placeFolder = path.join(
      realpathSync(root),
      path.relative(root, path.dirname(place))
    );
    const published = { in: placeFolder, renamed: [] as string[] };
    race.published = published;
    const first = await folders.make("babojubot-attempt-");
    const second = await folders.make("babojubot-attempt-");
    let secondDone: Promise<unknown> = Promise.resolve();
    let checkedWhilePlacing = false;
    let turnsWhileHeld: string[] = [];
    const opened: string[] = [];
    race.holdFirstWrite = {
      in: placeFolder,
      hold: async (write) => {
        const turn = {
          at: place,
          requested: [] as string[],
          arrived: () => {},
        };
        const secondArrived = new Promise<void>((resolve) => {
          turn.arrived = resolve;
          race.turnRequested = turn;
          race.onOpen = {
            in: placeFolder,
            missing: async () => {
              checkedWhilePlacing = true;
              resolve();
            },
            opened,
          };
        });
        secondDone = attemptLogin(attemptAt(second), "grant-two");
        await secondArrived;
        turnsWhileHeld = [...turn.requested];
        await write();
      },
    };

    const placed = await attemptLogin(attemptAt(first), "grant-one");
    const other = (await secondDone) as typeof placed;
    expect(checkedWhilePlacing).toBe(false);
    // 첫 쓰기를 붙잡은 동안 둘째 시도가 그 자리의 차례를 청해 기다렸다(붙잡기가 실제로 그 사이를 만들었다).
    expect(turnsWhileHeld).toEqual([place]);
    // 감시가 이 시험의 자리 표시 폴더를 실제로 보았다(고르기가 어긋나 감시가 꺼진 채 통과하지 않게).
    expect(opened.length).toBeGreaterThan(0);
    expect(published.renamed).toHaveLength(1);
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
  // 링크를 만들 권한이 없는 Windows에서는 이유와 함께 건너뛴다. CI는 필수로 정한다(`fileLinks`, #286 항목 16).
  it.skipIf(!fileLinks())(
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
        attemptAt(await folders.make("babojubot-attempt-")),
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
        attemptAt(await folders.make("babojubot-attempt-")),
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
    const place = path.join(
      root,
      "providers",
      "nested",
      "organizations",
      organizationId,
      ".gemini",
      "antigravity-cli"
    );
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    // 그 폴더는 제품이 나중에 만들므로 있는 `root`의 실제 경로 아래로 적는다(대역은 쓰는 자리의 폴더를 실제 경로로 푼다).
    race.failAfterCreate = {
      in: path.join(realpathSync(root), path.relative(root, place)),
      error: full,
    };
    await expect(
      prepared.attemptLogin(attemptAt(attempt), "grant")
    ).rejects.toBe(full);
    expect(await readdir(place)).toEqual([]);
  });
});
