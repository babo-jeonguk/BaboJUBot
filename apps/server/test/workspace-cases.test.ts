import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ArtifactFileRead } from "@babojubot/contracts";
import { afterEach, beforeAll, expect, it, type TestContext } from "vitest";
import { readerExit, Workspaces } from "../src/workspace.ts";
import {
  cleanup,
  featureGaps,
  filesBase,
  gapOutcome,
  realScratch,
  runPinned,
  windows,
} from "./files-volume.ts";

// #153: 파일 경로 격리의 사례 표(C01–C37, F1–F6)를 지금 이 파일 시스템에서 확인한다. 같은 파일이 일반 PR의 세 OS와
// 환경별 전체 검증의 각 디스크(NTFS·FAT·SMB, APFS·HFS+)에서 돈다. 사례마다 결과를 test meta(`cases`)에 남기고
// scripts/file-boundary-report.mjs가 환경별 결과표로 모은다. 기대와 다르면 시험이 실패한다(결함).
// 결과 구분: pass(기대대로), limitation(문서에 적은 안전한 오거부·허용한 차이), n/a(이 파일 시스템에 그 기능이 없음),
// unverified(준비하지 못함 — 통과가 아니다). n/a·unverified는 이유와 함께 건너뛴 시험으로 보인다.
type Outcome = "pass" | "limitation" | "n/a" | "unverified";
type CaseNote = { id: string; outcome: Outcome; detail: string };
declare module "vitest" {
  interface TaskMeta {
    cases?: CaseNote[];
    environment?: Record<string, unknown>;
  }
}
const note = (
  context: TestContext,
  id: string,
  outcome: Outcome,
  detail = ""
) => {
  (context.task.meta.cases ??= []).push({ id, outcome, detail });
};
/** 이 환경에서 확인할 수 없는 사례. 결과표에 이유를 남기고 시험은 건너뛴 것으로 보인다. */
const without = (
  context: TestContext,
  id: string,
  outcome: "n/a" | "unverified",
  reason: string
): never => {
  note(context, id, outcome, reason);
  context.skip(reason);
  throw new Error("unreachable");
};

const A = "organization-one";
const B = "organization-two";
// 다른 조직·조직 밖의 시험 바이트에는 모두 SECRET이 들어 있다. 어느 응답도 이 바이트를 돌려주면 안 된다.
const foreign = "B-SECRET";
const outsideBytes = "OUTSIDE-SECRET";
const refusal = (refusal: string) => ({ ok: false, refusal });

afterEach(cleanup);

async function world() {
  const root = await realScratch("bjc-");
  const organizations = path.join(root, "organizations");
  const shared = path.join(organizations, A, "shared");
  const other = path.join(organizations, B, "shared");
  for (const folder of [shared, other]) {
    await mkdir(path.join(folder, "dir"), { recursive: true });
  }
  for (const [id, folder] of [
    [A, shared],
    [B, other],
  ] as const)
    await writeFile(
      path.join(folder, "..", "workspace-identity.json"),
      JSON.stringify({ version: 1, organizationId: id })
    );
  await writeFile(path.join(shared, "a.md"), "A:a.md");
  await writeFile(path.join(shared, "dir", "a.md"), "A:dir/a.md");
  await writeFile(path.join(other, "a.md"), foreign);
  await writeFile(path.join(other, "dir", "a.md"), foreign);
  await writeFile(path.join(root, "outside.md"), outsideBytes);
  await mkdir(path.join(root, "outside-dir"));
  await writeFile(path.join(root, "outside-dir", "a.md"), outsideBytes);
  const workspaces = new Workspaces(root, null as never);
  /** 서버와 같은 읽기. 성공한 응답의 실제 바이트에 다른 조직·밖의 내용이 없는지도 본다. */
  const read = async (requested: string): Promise<ArtifactFileRead> => {
    const result = await workspaces.readArtifact(A, requested);
    if (result.ok)
      expect(
        Buffer.from(result.snapshot.bytes, "base64").toString("latin1"),
        requested
      ).not.toContain("SECRET");
    return result;
  };
  /** 받은 바이트(UTF-8). 거부면 거부 이유. */
  const got = async (requested: string) => {
    const result = await read(requested);
    return result.ok
      ? Buffer.from(result.snapshot.bytes, "base64").toString("utf8")
      : { refused: result.refusal };
  };
  return { root, organizations, shared, other, read, got };
}
/** 테스트 프로세스가 운영체제로 직접 열어 본 결과. 우리 읽기가 같은 파일을 고르는지의 기준이다. */
const osOpen = (absolute: string) =>
  readFile(absolute, "utf8").then(
    (text) => text,
    (error: NodeJS.ErrnoException) => ({ refused: error.code })
  );

const run = (file: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ ok: boolean; output: string }>((resolve) =>
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({ ok: !error, output: `${stdout}${stderr}`.trim() })
    )
  );
/** Windows 8.3 짧은 이름. 이 볼륨이 짧은 이름을 만들지 않으면 긴 이름 그대로다. */
const shortName = async (target: string) => {
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f = New-Object -ComObject Scripting.FileSystemObject; $p = $env:BABO_TARGET; if (Test-Path -LiteralPath $p -PathType Container) { $f.GetFolder($p).ShortName } else { $f.GetFile($p).ShortName }",
    ],
    { BABO_TARGET: target }
  );
  return result.ok ? result.output : undefined;
};

/** 이 파일 시스템에 없는 기능. 없으면 그 사례는 적용 불가로 남긴다. */
const lacks = await featureGaps();
/** 기능을 만들지 못한 이유에 따라 이 사례를 적용 불가(FAT32의 링크 등) 또는 미검증으로 남기고 건너뛴다. */
const needs = (
  context: TestContext,
  id: string,
  feature: keyof typeof lacks
) => {
  const code = lacks[feature];
  if (code) without(context, id, gapOutcome(code), `${feature} 없음(${code})`);
};
const needsLinks = (context: TestContext, id: string) =>
  needs(context, id, "symlink");
it("counts a missing link as n/a only when the file system lacks the feature", () => {
  // Windows FAT32의 링크·hard link는 ERROR_INVALID_FUNCTION(libuv EISDIR)으로 실패한다.
  expect(gapOutcome("EISDIR", "win32")).toBe("n/a");
  expect(gapOutcome("ENOTSUP", "linux")).toBe("n/a");
  // POSIX의 symlink EPERM은 파일 시스템이 링크를 지원하지 않는다는 뜻이다(symlink(2)).
  expect(gapOutcome("EPERM", "linux")).toBe("n/a");
  // SMB 공유의 정션은 만들어져도 운영체제가 링크로 보지 못한다.
  expect(gapOutcome("NOT_A_LINK", "win32")).toBe("n/a");
  // Windows의 EPERM은 링크를 만들 권한이 없는 계정이다. 기능 부재가 아니다.
  expect(gapOutcome("EPERM", "win32")).toBe("unverified");
  expect(gapOutcome("EACCES", "linux")).toBe("unverified");
  expect(gapOutcome("ENOSPC", "darwin")).toBe("unverified");
});
/** 이 파일 시스템이 이름을 다루는 방식. */
const can = {
  caseSensitive: false,
  /** NFC로 만든 이름을 NFD로 열 수 있는가. */
  normalizationInsensitive: false,
};
beforeAll(async () => {
  const probe = await realScratch("bjc-probe-");
  await writeFile(path.join(probe, "file"), "x");
  can.caseSensitive = !(await stat(path.join(probe, "FILE")).then(
    () => true,
    () => false
  ));
  const korean = "한글.md";
  await writeFile(path.join(probe, korean.normalize("NFC")), "x");
  can.normalizationInsensitive = await stat(
    path.join(probe, korean.normalize("NFD"))
  ).then(
    () => true,
    () => false
  );
});

// 환경 식별. 준비 단계가 기대한 파일 시스템 설정(BABOJUBOT_FILES_EXPECT)과 실제로 관찰한 동작이 다르면
// 준비가 틀린 것이므로 실패한다. 설정 성공 로그만으로 그 환경을 시험했다고 보지 않는다.
it("ENV identifies the file system under test", async (context) => {
  const { shared } = await world();
  const file = await stat(path.join(shared, "a.md"), { bigint: true });
  const folder = await stat(path.join(shared, "dir"), { bigint: true });
  const environment = {
    volume: process.env.BABOJUBOT_FILES_VOLUME ?? "default",
    fileSystem: process.env.BABOJUBOT_FILES_FS ?? "unknown",
    base: filesBase(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    caseSensitive: can.caseSensitive,
    normalizationInsensitive: can.normalizationInsensitive,
    symlink: lacks.symlink || "yes",
    hardLink: lacks.hardLink || "yes",
    junction: lacks.junction || "yes",
    file: {
      dev: String(file.dev),
      ino: String(file.ino),
      nlink: String(file.nlink),
    },
    folder: { dev: String(folder.dev), ino: String(folder.ino) },
  };
  context.task.meta.environment = environment;
  console.log(JSON.stringify(environment));
  const expected = process.env.BABOJUBOT_FILES_EXPECT;
  if (expected) {
    const want = JSON.parse(expected) as Record<string, unknown>;
    for (const [key, value] of Object.entries(want))
      expect(
        (environment as Record<string, unknown>)[key],
        `prepared ${key}`
      ).toEqual(value);
  }
});

it("C01 refuses ../../../outside.md", async (context) => {
  const { read } = await world();
  expect(await read("../../../outside.md")).toEqual(
    refusal("path_outside_folder")
  );
  note(context, "C01", "pass");
});

it("C02 refuses dir/../../outside.md", async (context) => {
  const { read } = await world();
  for (const requested of [
    "dir/../../outside.md",
    "dir/../../../../outside.md",
  ])
    expect(await read(requested), requested).toEqual(
      refusal("path_outside_folder")
    );
  note(context, "C02", "pass");
});

it("C03 refuses an absolute path outside the working folder", async (context) => {
  const { read, root, organizations } = await world();
  for (const requested of [
    path.join(root, "outside.md"),
    path.join(organizations, B, "shared", "a.md"),
    path.join(root, "outside-dir", "a.md"),
  ])
    expect(await read(requested), requested).toEqual(
      refusal("path_outside_folder")
    );
  note(context, "C03", "pass");
});

it("C04 registers an absolute path inside the working folder", async (context) => {
  const { read, shared } = await world();
  expect(await read(path.join(shared, "dir", "a.md"))).toMatchObject({
    ok: true,
    snapshot: {
      content: "A:dir/a.md",
      file: { path: path.join("dir", "a.md") },
    },
  });
  note(context, "C04", "pass");
});

it("C05 refuses an absolute path that leaves the working folder part and comes back, except on Windows", async (context) => {
  const { got, shared } = await world();
  const back = [shared, "..", "shared", "a.md"].join(path.sep);
  if (windows) {
    // Win32는 `..`를 글자로 줄여 연다. 운영체제가 여는 안쪽 파일과 같다.
    expect(await got(back)).toBe(await osOpen(back));
    expect(await got(back)).toBe("A:a.md");
    note(context, "C05", "pass", "Windows: 글자로 줄여 안쪽 파일");
  } else {
    expect(await got(back)).toEqual({ refused: "path_outside_folder" });
    note(
      context,
      "C05",
      "limitation",
      "작업 폴더 부분의 `..`는 보수적으로 밖으로 본다"
    );
  }
});

it("C06 follows relative and absolute links to files and folders inside", async (context) => {
  needsLinks(context, "C06");
  const { read, shared } = await world();
  await symlink("a.md", path.join(shared, "relative.md"));
  await symlink(
    path.join(shared, "dir", "a.md"),
    path.join(shared, "absolute.md")
  );
  await symlink("dir", path.join(shared, "relative-dir"), "dir");
  await symlink(
    path.join(shared, "dir"),
    path.join(shared, "absolute-dir"),
    "dir"
  );
  for (const [requested, content, selected] of [
    ["relative.md", "A:a.md", "a.md"],
    ["absolute.md", "A:dir/a.md", path.join("dir", "a.md")],
    [path.join("relative-dir", "a.md"), "A:dir/a.md", path.join("dir", "a.md")],
    [path.join("absolute-dir", "a.md"), "A:dir/a.md", path.join("dir", "a.md")],
  ])
    expect(await read(requested!), requested).toMatchObject({
      ok: true,
      snapshot: { content, file: { path: selected } },
    });
  note(context, "C06", "pass");
});

it("C07 refuses links to an outside file, an outside folder, another organization and nothing", async (context) => {
  needsLinks(context, "C07");
  const { read, shared, root, other } = await world();
  await symlink(path.join(root, "outside.md"), path.join(shared, "out.md"));
  await symlink(path.join(other, "a.md"), path.join(shared, "foreign.md"));
  await symlink(
    path.join(root, "outside-dir"),
    path.join(shared, "out-dir"),
    "dir"
  );
  await symlink(path.join(root, "missing.md"), path.join(shared, "none.md"));
  await symlink(
    ["..", "..", "..", "outside.md"].join(path.sep),
    path.join(shared, "up.md")
  );
  for (const requested of [
    "out.md",
    "foreign.md",
    path.join("out-dir", "a.md"),
    "none.md",
    "up.md",
  ])
    expect(await read(requested), requested).toEqual(
      refusal("path_outside_folder")
    );
  note(context, "C07", "pass");
});

// 링크 뒤의 `..`는 운영체제가 여는 것과 같은 파일을 고른다(Linux·macOS는 링크가 가리키는 자리, Windows는 글자로 줄인 자리).
it("C08 picks the file the operating system opens for `..` after a link", async (context) => {
  needsLinks(context, "C08");
  const { got, shared } = await world();
  await mkdir(path.join(shared, "data", "deep"), { recursive: true });
  await writeFile(path.join(shared, "target.md"), "A:WRONG");
  await writeFile(path.join(shared, "data", "target.md"), "A:INTENDED");
  await symlink(path.join("data", "deep"), path.join(shared, "link"), "dir");
  const relative = ["link", "..", "target.md"].join(path.sep);
  const absolute = [shared, relative].join(path.sep);
  await symlink(absolute, path.join(shared, "absolute.md"));
  await symlink(relative, path.join(shared, "relative.md"));
  const differences: string[] = [];
  for (const requested of [relative, absolute, "absolute.md", "relative.md"]) {
    const opened = await osOpen(
      path.isAbsolute(requested)
        ? requested
        : [shared, requested].join(path.sep)
    );
    const ours = await got(requested);
    expect(ours, requested).toEqual(windows ? "A:WRONG" : "A:INTENDED");
    if (JSON.stringify(opened) !== JSON.stringify(ours))
      differences.push(`${requested}: os ${JSON.stringify(opened)}`);
  }
  // 운영체제가 이 볼륨의 링크를 따라가지 않으면(SMB의 링크 평가 정책 등) 우리 읽기가 더 받는다. 고르는 파일은 안쪽이다.
  if (differences.length > 0)
    note(
      context,
      "C08",
      "limitation",
      `운영체제는 열지 않음: ${differences.join("; ")}`
    );
  else note(context, "C08", "pass");
});

it("C09 names a folder link loop", async (context) => {
  needsLinks(context, "C09");
  const { read, shared } = await world();
  await symlink("b", path.join(shared, "a"), "dir");
  await symlink("a", path.join(shared, "b"), "dir");
  expect(await read(path.join("a", "x.md"))).toEqual(refusal("link_loop"));
  note(context, "C09", "pass");
});

it("C10 follows a finite chain of self links and names more than 40 as a loop", async (context) => {
  needsLinks(context, "C10");
  const { read, shared } = await world();
  await symlink(".", path.join(shared, "self"), "dir");
  const through = (count: number) =>
    [...Array.from({ length: count }, () => "self"), "a.md"].join(path.sep);
  expect(await read(through(3))).toMatchObject({
    ok: true,
    snapshot: { content: "A:a.md", file: { path: "a.md" } },
  });
  expect(await read(through(41))).toEqual(refusal("link_loop"));
  note(context, "C10", "pass");
});

/**
 * 읽는 프로세스의 파일 작업 하나(`on`의 `nth`번째 `name` 호출) 앞이나 뒤에서 한 번만 `actions`를 실행한다.
 * 무작위 반복이 아니라 정해진 한 시점의 바꿔치기다.
 */
const inject = `{
  const fs = require("node:fs");
  const plan = JSON.parse(process.env.PLAN);
  let seen = 0;
  let done = false;
  const act = () => {
    if (done) return;
    done = true;
    for (const [operation, ...args] of plan.actions) {
      if (operation === "exec") require("node:child_process").execFileSync(args[0], args.slice(1));
      else fs[operation](...args);
    }
  };
  const owner = plan.on === "chdir" ? process : fs;
  const real = owner[plan.on];
  owner[plan.on] = (...args) => {
    const matches = plan.name === null || args[0] === plan.name;
    if (matches) seen += 1;
    const now = matches && seen === (plan.nth ?? 1);
    if (now && plan.when === "before") act();
    const result = real.apply(owner, args);
    if (now && plan.when === "after") act();
    return result;
  };
}
`;
type Action = [string, ...unknown[]];
const injected = (
  organizations: string,
  requested: string,
  plan: {
    on: "chdir" | "lstatSync" | "openSync" | "fstatSync";
    when: "before" | "after";
    name: string | null;
    nth?: number;
    actions: Action[];
  }
) => runPinned(organizations, inject, { requested, plan });
const text = (bytes: Buffer | null) => bytes?.toString("utf8") ?? null;

it("C11 refuses when a folder in the path or the file itself is swapped right after it was checked", async (context) => {
  const results: Record<string, unknown> = {};
  for (const [name, swap] of [
    ["folder moved in from another organization", "move-dir"],
    ["folder replaced by a link to another organization", "link-dir"],
    ["file moved in from another organization", "move-file"],
    ["file replaced by a link to another organization", "link-file"],
  ] as const) {
    const { organizations, shared, other } = await world();
    const isDir = swap.endsWith("dir");
    const from = isDir
      ? path.join(shared, "dir")
      : path.join(shared, "dir", "a.md");
    const to = isDir ? path.join(other, "dir") : path.join(other, "a.md");
    if (swap.startsWith("link") && lacks.symlink) {
      results[name] = `n/a: symlink 없음(${lacks.symlink})`;
      continue;
    }
    const actions: Action[] = [
      ["renameSync", from, `${from}-kept`],
      swap.startsWith("move")
        ? ["renameSync", to, from]
        : ["symlinkSync", to, from, isDir ? "dir" : "file"],
    ];
    const result = await injected(
      organizations,
      ["dir", "a.md"].join(path.sep),
      isDir
        ? { on: "chdir", when: "before", name: "dir", actions }
        : { on: "openSync", when: "before", name: "a.md", actions }
    );
    expect(text(result.bytes), name).not.toBe(foreign);
    expect(result.code, name).toBe(readerExit.changed);
    results[name] = result.code;
  }
  note(context, "C11", "pass", JSON.stringify(results));
});

it("C12 refuses when the organization folder or shared is swapped for another organization's or a link right before entering", async (context) => {
  const results: Record<string, unknown> = {};
  for (const [name, target, swap] of [
    ["organization folder moved", A, "move"],
    ["organization folder linked", A, "link"],
    ["shared moved", "shared", "move"],
    ["shared linked", "shared", "link"],
  ] as const) {
    const { organizations, shared, other } = await world();
    if (swap === "link" && lacks.symlink) {
      results[name] = `n/a: symlink 없음(${lacks.symlink})`;
      continue;
    }
    const from = target === A ? path.dirname(shared) : shared;
    const to = target === A ? path.dirname(other) : other;
    const result = await injected(organizations, "a.md", {
      on: "chdir",
      when: "before",
      name: target,
      actions: [
        ["renameSync", from, `${from}-kept`],
        swap === "move"
          ? ["renameSync", to, from]
          : ["symlinkSync", to, from, "dir"],
      ],
    });
    expect(text(result.bytes), name).not.toBe(foreign);
    expect(result.code, name).toBe(readerExit.identity);
    results[name] = result.code;
  }
  note(context, "C12", "pass", JSON.stringify(results));
});

it("C13 refuses a hard link to a file outside", async (context) => {
  needs(context, "C13", "hardLink");
  const { read, shared, root, other } = await world();
  await link(path.join(root, "outside.md"), path.join(shared, "hard.md"));
  await link(path.join(other, "a.md"), path.join(shared, "foreign.md"));
  expect(await read("hard.md")).toEqual(refusal("hard_link_refused"));
  expect(await read("foreign.md")).toEqual(refusal("hard_link_refused"));
  note(context, "C13", "pass");
});

// F6: 연 뒤에 바깥에서 같은 파일로 hard link를 더해도, 읽는 descriptor는 이미 안쪽 파일이다. 더한 링크는 감지하지 않는다.
it("C14 reads the inside bytes when a hard link is added after the file was opened", async (context) => {
  needs(context, "C14", "hardLink");
  const { organizations, shared, root } = await world();
  const result = await injected(organizations, "a.md", {
    on: "fstatSync",
    when: "after",
    name: null,
    // 첫 fstat은 조직 표식 파일, 두 번째가 요청한 파일이다.
    nth: 2,
    actions: [
      ["linkSync", path.join(shared, "a.md"), path.join(root, "added.md")],
    ],
  });
  expect(result.code).toBe(0);
  expect(text(result.bytes)).toBe("A:a.md");
  note(
    context,
    "C14",
    "limitation",
    "F6: 연 뒤 더한 hard link는 감지하지 않음, 읽은 바이트는 안쪽 파일"
  );
});

// F5: 경로를 걸으며 확인한 최종 파일이 바로 뒤에 사라지거나 바뀌면 `file_changed`다.
it("C15 names the final file as changed when it disappears or is replaced right after it was checked", async (context) => {
  const results: Record<string, unknown> = {};
  for (const [name, actions] of [
    [
      "removed",
      (shared: string) => [["unlinkSync", path.join(shared, "a.md")]],
    ],
    [
      "replaced by another organization's file",
      (shared: string, other: string) => [
        ["renameSync", path.join(shared, "a.md"), path.join(shared, "kept.md")],
        ["renameSync", path.join(other, "a.md"), path.join(shared, "a.md")],
      ],
    ],
    [
      "replaced by a link outside",
      (shared: string, _other: string, root: string) => [
        ["unlinkSync", path.join(shared, "a.md")],
        [
          "symlinkSync",
          path.join(root, "outside.md"),
          path.join(shared, "a.md"),
          "file",
        ],
      ],
    ],
  ] as const) {
    if (name.includes("link") && lacks.symlink) {
      results[name] = `n/a: symlink 없음(${lacks.symlink})`;
      continue;
    }
    const { organizations, shared, other, root } = await world();
    const result = await injected(organizations, "a.md", {
      on: "lstatSync",
      when: "after",
      name: "a.md",
      actions: actions(shared, other, root) as Action[],
    });
    expect(text(result.bytes), name).toBeNull();
    expect(result.code, name).toBe(readerExit.changed);
    results[name] = result.code;
  }
  note(context, "C15", "pass", JSON.stringify(results));
});

const mkfifo = async (target: string) => {
  const result = await run("mkfifo", [target]);
  return result.ok ? "" : result.output || "mkfifo failed";
};
it("C16 refuses a FIFO without opening it, also when the file turns into one right after it was checked", async (context) => {
  if (windows) without(context, "C16", "n/a", "Windows에는 FIFO 파일이 없다");
  const { read, shared, organizations } = await world();
  const made = await mkfifo(path.join(shared, "pipe.md"));
  if (made)
    without(context, "C16", "unverified", `FIFO를 만들지 못함: ${made}`);
  expect(await read("pipe.md")).toEqual(refusal("not_regular_file"));
  const result = await injected(organizations, "a.md", {
    on: "lstatSync",
    when: "after",
    name: "a.md",
    actions: [
      ["unlinkSync", path.join(shared, "a.md")],
      ["exec", "mkfifo", path.join(shared, "a.md")],
    ],
  });
  expect(result.code).toBe(readerExit.changed);
  note(context, "C16", "pass");
});

it("C17 refuses a Unix socket", async (context) => {
  if (windows)
    without(
      context,
      "C17",
      "n/a",
      "Windows의 Node는 경로 socket 대신 named pipe를 쓴다"
    );
  const { read, shared } = await world();
  const server = createServer();
  const listening = await new Promise<string>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? String(error))
    );
    server.listen(path.join(shared, "s"), () => resolve(""));
  });
  try {
    if (listening)
      without(
        context,
        "C17",
        "unverified",
        `socket을 만들지 못함: ${listening}`
      );
    expect(await read("s")).toEqual(refusal("not_regular_file"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  note(context, "C17", "pass");
});

it("C18 refuses a device file and a link to a device", async (context) => {
  const { read, shared } = await world();
  if (windows) {
    needsLinks(context, "C18");
    await symlink("\\\\.\\NUL", path.join(shared, "device.md"));
    expect(await read("device.md")).toEqual(refusal("path_outside_folder"));
    note(
      context,
      "C18",
      "pass",
      "장치 노드는 Windows에 없음, 장치 링크·예약 장치 이름(C28)으로 확인"
    );
    return;
  }
  if (!lacks.symlink) {
    await symlink("/dev/null", path.join(shared, "device-link"));
    expect(await read("device-link")).toEqual(refusal("path_outside_folder"));
  }
  // 장치 노드는 관리자만 만든다. CI runner의 sudo로 만들고, 시험 자체는 일반 사용자로 읽는다.
  const [major, minor] =
    process.platform === "darwin" ? ["3", "2"] : ["1", "3"];
  const made = await run("sudo", [
    "-n",
    "mknod",
    path.join(shared, "device"),
    "c",
    major,
    minor,
  ]);
  if (!made.ok)
    without(
      context,
      "C18",
      "unverified",
      `장치 노드를 만들지 못함: ${made.output}`
    );
  expect(await read("device")).toEqual(refusal("not_regular_file"));
  note(
    context,
    "C18",
    "pass",
    lacks.symlink ? "장치 노드만(symlink 없음)" : ""
  );
});

it("C19 treats a trailing separator after a file the way the operating system does", async (context) => {
  const { got, shared } = await world();
  const mismatches: string[] = [];
  for (const requested of [
    `a.md${path.sep}`,
    `a.md${path.sep}.`,
    `${shared}${path.sep}a.md${path.sep}`,
  ]) {
    const opened = await osOpen(
      path.isAbsolute(requested)
        ? requested
        : `${shared}${path.sep}${requested}`
    );
    const ours = await got(requested);
    if (windows) {
      if (opened !== ours)
        mismatches.push(
          `${requested}: os ${JSON.stringify(opened)}, ours ${JSON.stringify(ours)}`
        );
    } else {
      expect(typeof opened, requested).not.toBe("string");
      expect(ours, requested).toEqual({ refused: "file_not_found" });
    }
  }
  expect(mismatches).toEqual([]);
  note(
    context,
    "C19",
    "pass",
    windows ? "Windows: 입력한 끝 구분자는 떼고 연다(운영체제와 같음)" : ""
  );
});

it("C20 refuses a folder, an empty path and .", async (context) => {
  const { read } = await world();
  for (const requested of [`dir${path.sep}`, "dir", "", "."])
    expect(await read(requested), JSON.stringify(requested)).toEqual(
      refusal("not_regular_file")
    );
  note(context, "C20", "pass");
});

it("C21 keeps an empty file", async (context) => {
  const { read, shared } = await world();
  await writeFile(path.join(shared, "empty.md"), "");
  expect(await read("empty.md")).toMatchObject({
    ok: true,
    snapshot: { format: "markdown", content: "", file: { size: 0 }, bytes: "" },
  });
  note(context, "C21", "pass");
});

it("C22 refuses a file one byte over 10 MiB", async (context) => {
  const { read, shared } = await world();
  await writeFile(
    path.join(shared, "big.bin"),
    Buffer.alloc(10 * 1024 * 1024 + 1)
  );
  await writeFile(
    path.join(shared, "limit.bin"),
    Buffer.alloc(10 * 1024 * 1024)
  );
  expect(await read("big.bin")).toEqual(refusal("file_too_large"));
  expect(await read("limit.bin")).toMatchObject({
    ok: true,
    snapshot: { file: { size: 10 * 1024 * 1024 } },
  });
  note(context, "C22", "pass");
});

it("C23 keeps invalid UTF-8 Markdown as binary", async (context) => {
  const { read, shared } = await world();
  await writeFile(path.join(shared, "bad.md"), Buffer.from([0x41, 0xff, 0xfe]));
  expect(await read("bad.md")).toMatchObject({
    ok: true,
    snapshot: {
      format: "binary",
      content: "",
      bytes: "Qf/+",
      file: { size: 3 },
    },
  });
  note(context, "C23", "pass");
});

it("C24 keeps Markdown with NUL as binary", async (context) => {
  const { read, shared } = await world();
  // `nul.md`는 Windows에서 장치 이름이라 다른 이름을 쓴다(C28).
  await writeFile(path.join(shared, "zero.md"), "A\0B");
  expect(await read("zero.md")).toMatchObject({
    ok: true,
    snapshot: { format: "binary", content: "", file: { size: 3 } },
  });
  note(context, "C24", "pass");
});

// 한글 이름은 NFC로 만든 파일을 NFD로 요청할 때 운영체제가 여는지(APFS·HFS+는 열고 Linux ext4는 열지 않는다)와 같게 다룬다.
it("C25 registers Korean names and treats NFC and NFD the way the file system does", async (context) => {
  const { got, read, shared } = await world();
  const nfc = "한글 보고서.md".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  await mkdir(path.join(shared, "폴더"));
  await writeFile(path.join(shared, "폴더", nfc), "A:한글");
  expect(await read(path.join("폴더", nfc))).toMatchObject({
    ok: true,
    snapshot: { content: "A:한글", file: { name: nfc } },
  });
  const requested = path.join("폴더".normalize("NFD"), nfd);
  const opened = await osOpen(path.join(shared, requested));
  expect(await got(requested)).toEqual(
    typeof opened === "string" ? "A:한글" : { refused: "file_not_found" }
  );
  note(
    context,
    "C25",
    "pass",
    `NFD 요청: ${typeof opened === "string" ? "운영체제·우리 모두 같은 파일" : "운영체제·우리 모두 없는 파일"}`
  );
});

type Ran = { ok: boolean; output: string };
/**
 * Windows에서 읽기 거부 ACL을 더한 결과를 판정한다. 막았으면 undefined. 거부 항목을 다시 읽어 보니 남지 않았으면
 * 이 파일 시스템이 ACL을 저장하지 않는다는 근거라 적용 불가(FAT)다. 명령이 실패했으면 ACL이 있는 볼륨에서 준비하지
 * 못한 것이라 미검증이다.
 */
function denial(set: Ran, stored?: Ran) {
  if (!set.ok)
    return {
      outcome: "unverified" as const,
      reason: `거부를 설정하지 못함: ${set.output}`,
    };
  if (!stored?.ok)
    return {
      outcome: "unverified" as const,
      reason: `거부 항목을 읽지 못함: ${stored?.output ?? ""}`,
    };
  return stored.output.includes("DENY")
    ? undefined
    : {
        outcome: "n/a" as const,
        reason: `거부 항목이 저장되지 않음(ACL 없는 파일 시스템): ${stored.output.split("\n")[0]}`,
      };
}
it("classifies a Windows read denial that could not be set as unverified, and one the file system dropped as n/a", () => {
  const deny = { ok: true, output: "processed file: x" };
  expect(
    denial(deny, { ok: true, output: "x Everyone:(DENY)(R)" })
  ).toBeUndefined();
  // FAT32: icacls는 성공하지만 다시 읽으면 거부 항목이 없다.
  expect(denial(deny, { ok: true, output: "x NULL SID:(F)" })?.outcome).toBe(
    "n/a"
  );
  // NTFS·SMB에서 권한 부족 등으로 명령이 실패하면 ACL이 있는 볼륨을 준비하지 못한 것이다.
  expect(denial({ ok: false, output: "Access is denied." })?.outcome).toBe(
    "unverified"
  );
  expect(
    denial(deny, { ok: false, output: "Access is denied." })?.outcome
  ).toBe("unverified");
});
/** 읽기 권한을 막는다. Windows는 모든 사용자의 데이터 읽기·폴더 통과를 거부하는 ACL을 더한다. */
const deny = async (target: string, folder: boolean) => {
  if (!windows) {
    await chmod(target, folder ? 0o600 : 0o000);
    return undefined;
  }
  const set = await run("icacls", [
    target,
    "/deny",
    `*S-1-1-0:(${folder ? "RD,X" : "RD"})`,
  ]);
  return denial(set, set.ok ? await run("icacls", [target]) : undefined);
};
const allow = async (target: string, folder: boolean) => {
  if (!windows) await chmod(target, folder ? 0o755 : 0o644);
  else await run("icacls", [target, "/remove:d", "*S-1-1-0"]);
};
it("C26 refuses a file it may not read and a folder it may not search", async (context) => {
  const { got, shared } = await world();
  const file = path.join(shared, "locked.md");
  const folder = path.join(shared, "locked");
  await writeFile(file, "A:locked");
  await mkdir(folder);
  await writeFile(path.join(folder, "a.md"), "A:locked/a.md");
  const fileDenied = await deny(file, false);
  const folderDenied = await deny(folder, true);
  try {
    const failed = fileDenied ?? folderDenied;
    if (failed) without(context, "C26", failed.outcome, failed.reason);
    // 관리자 권한 등으로 운영체제가 그래도 열면 이 환경에서는 거부를 확인할 수 없다. 통과로 세지 않는다.
    const osFile = await osOpen(file);
    const osFolder = await osOpen(path.join(folder, "a.md"));
    if (typeof osFile === "string")
      without(
        context,
        "C26",
        "unverified",
        "이 계정은 막은 파일도 연다(관리자 우회)"
      );
    expect(await got("locked.md")).toEqual({ refused: "file_unreadable" });
    const ours = await got(path.join("locked", "a.md"));
    if (typeof osFolder === "string") {
      // Windows는 폴더 통과 검사를 건너뛰는 권한(SeChangeNotifyPrivilege)이 모든 사용자에게 있다. 열리면 안쪽 파일이다.
      expect([
        "A:locked/a.md",
        JSON.stringify({ refused: "file_unreadable" }),
      ]).toContain(typeof ours === "string" ? ours : JSON.stringify(ours));
      note(
        context,
        "C26",
        "limitation",
        `폴더 통과 거부는 운영체제도 무시함, 우리: ${JSON.stringify(ours)}`
      );
    } else {
      expect(ours).toEqual({ refused: "file_unreadable" });
      note(context, "C26", "pass");
    }
  } finally {
    await allow(file, false);
    await allow(folder, true);
  }
});

it("C27 refuses Windows drive-relative names as outside and keeps them as plain names elsewhere", async (context) => {
  const { read, got, shared } = await world();
  if (windows) {
    for (const requested of [
      "D:outside.md",
      "C:..",
      `C:..${path.sep}outside.md`,
      `dir${path.sep}Z:a.md`,
    ])
      expect(await read(requested), requested).toEqual(
        refusal("path_outside_folder")
      );
  } else {
    await writeFile(path.join(shared, "D:outside.md"), "A:drive");
    expect(await got("D:outside.md")).toBe("A:drive");
  }
  note(context, "C27", "pass", windows ? "" : "Windows가 아니면 보통 이름");
});

const reserved = [
  "NUL",
  "con.txt",
  "COM1",
  "COM¹",
  "CONIN$",
  "CONOUT$",
  "LPT1",
  "AUX",
  "PRN",
  "CONIN$.txt",
  "lpt².md",
];
it("C28 refuses Windows reserved device names and keeps them as plain names elsewhere", async (context) => {
  const { read, got, shared } = await world();
  for (const name of [...reserved, path.join("dir", "aux")]) {
    if (windows)
      expect(await read(name), name).toEqual(refusal("not_regular_file"));
    else {
      await writeFile(path.join(shared, name), "A:reserved");
      expect(await got(name), name).toBe("A:reserved");
    }
  }
  note(context, "C28", "pass", windows ? "" : "Windows가 아니면 보통 이름");
});

it("C29 refuses a Windows alternate data stream and keeps it as a plain name elsewhere", async (context) => {
  const { read, got, shared } = await world();
  if (windows) {
    // NTFS면 스트림에 바깥 시험 바이트를 실제로 둔다. FAT 등 스트림이 없는 볼륨은 이름 거부만 본다.
    const stream = await writeFile(
      path.join(shared, "a.md:s"),
      outsideBytes
    ).then(
      () => "stream written",
      (error: NodeJS.ErrnoException) => `no stream (${error.code})`
    );
    for (const requested of ["a.md:s", "a.md:s:$DATA", "a.md::$DATA"])
      expect(await read(requested), requested).toEqual(
        refusal("not_regular_file")
      );
    note(context, "C29", "pass", stream);
  } else {
    await writeFile(path.join(shared, "a.md:s"), "A:colon");
    expect(await got("a.md:s")).toBe("A:colon");
    note(context, "C29", "pass", "Windows가 아니면 보통 이름");
  }
});

it("C30 refuses Windows names ending in a dot or a space and keeps them elsewhere", async (context) => {
  const { read, got, shared } = await world();
  await writeFile(path.join(shared, "..", "secret.md"), outsideBytes);
  if (windows) {
    for (const requested of [
      "a.md.",
      "a.md ",
      `.. ${path.sep}secret.md`,
      `dir${path.sep}.. ${path.sep}.. ${path.sep}secret.md`,
    ])
      expect(await read(requested), requested).toEqual(
        refusal("not_regular_file")
      );
  } else {
    for (const name of ["a.md.", "a.md "]) {
      await writeFile(path.join(shared, name), "A:trailing");
      expect(await got(name), name).toBe("A:trailing");
    }
  }
  note(context, "C30", "pass", windows ? "" : "Windows가 아니면 보통 이름");
});

/** `\\?\` 확장 표기. UNC는 `\\?\UNC\server\share\…`다. */
const extended = (absolute: string) =>
  absolute.startsWith("\\\\")
    ? `\\\\?\\UNC\\${absolute.slice(2)}`
    : `\\\\?\\${absolute}`;
it("C31 registers a \\\\?\\ extended path to a file inside", async (context) => {
  if (!windows) without(context, "C31", "n/a", "Windows 경로 표기");
  const { read, shared } = await world();
  const requested = `${extended(shared)}\\dir\\a.md`;
  expect(await osOpen(requested)).toBe("A:dir/a.md");
  expect(await read(requested)).toMatchObject({
    ok: true,
    snapshot: { content: "A:dir/a.md", file: { path: "dir\\a.md" } },
  });
  note(context, "C31", "pass", requested.slice(0, 12));
});

// F2: `\\?\UNC\server\share\…`는 `\\server\share\…`와 같은 폴더다. 작업 폴더가 UNC면 등록한다.
// 작업 폴더가 드라이브 문자면 관리 공유(`\\localhost\C$\…`)는 같은 파일이어도 다른 표기(별칭)라 밖으로 본다(F1과 같은 제한).
it("C32 registers a \\\\?\\UNC\\ path to the working folder on a share, and treats another spelling of a local folder as outside", async (context) => {
  if (!windows) without(context, "C32", "n/a", "Windows 경로 표기");
  const { read, shared } = await world();
  if (shared.startsWith("\\\\")) {
    const requested = `${extended(shared)}\\dir\\a.md`;
    expect(await read(requested)).toMatchObject({
      ok: true,
      snapshot: { content: "A:dir/a.md", file: { path: "dir\\a.md" } },
    });
    note(context, "C32", "pass", "작업 폴더가 UNC");
  } else {
    const share = `\\\\localhost\\${shared[0]}$${shared.slice(2)}`;
    expect(await read(`${extended(share)}\\a.md`)).toEqual(
      refusal("path_outside_folder")
    );
    expect(await read(`${share}\\a.md`)).toEqual(
      refusal("path_outside_folder")
    );
    note(
      context,
      "C32",
      "limitation",
      "드라이브 작업 폴더의 관리 공유 표기는 별칭이라 밖으로 본다"
    );
  }
});

// F1: 작업 폴더를 가리키는 다른 절대 링크(별칭)를 거친 절대 경로는 이름 대조가 맞지 않아 밖으로 본다. 안전한 오거부다.
it("C33 treats an absolute path through another link to the working folder as outside", async (context) => {
  needsLinks(context, "C33");
  const { read, root, shared } = await world();
  await symlink(shared, path.join(root, "alias"), "dir");
  expect(await osOpen(path.join(root, "alias", "a.md"))).toBe("A:a.md");
  expect(await read(path.join(root, "alias", "a.md"))).toEqual(
    refusal("path_outside_folder")
  );
  // 같은 파일을 상대 경로나 작업 폴더 표기로는 등록한다.
  expect(await read(path.join(shared, "a.md"))).toMatchObject({ ok: true });
  note(
    context,
    "C33",
    "limitation",
    "F1: 절대 경로 별칭은 path_outside_folder"
  );
});

it("C34 registers a Windows 8.3 short name of an inside file or folder and refuses one of a junction leading out", async (context) => {
  if (!windows) without(context, "C34", "n/a", "Windows 짧은 이름");
  const { read, shared, root } = await world();
  await writeFile(path.join(shared, "long file name.md"), "A:long");
  await mkdir(path.join(shared, "long folder name"));
  await writeFile(
    path.join(shared, "long folder name", "a.md"),
    "A:long folder"
  );
  const file = await shortName(path.join(shared, "long file name.md"));
  const folder = await shortName(path.join(shared, "long folder name"));
  if (!file?.includes("~") || !folder?.includes("~"))
    without(
      context,
      "C34",
      "unverified",
      `이 볼륨이 짧은 이름을 만들지 않음(${file}, ${folder})`
    );
  expect(await read(file!)).toMatchObject({
    ok: true,
    snapshot: { content: "A:long", file: { name: file } },
  });
  expect(await read(`${folder}\\a.md`)).toMatchObject({
    ok: true,
    snapshot: { content: "A:long folder" },
  });
  let junction = `정션 없음(${lacks.junction})`;
  if (!lacks.junction) {
    await symlink(
      path.join(root, "outside-dir"),
      path.join(shared, "long junction name"),
      "junction"
    );
    const short = await shortName(path.join(shared, "long junction name"));
    if (short?.includes("~")) {
      expect(await read(`${short}\\a.md`)).toEqual(
        refusal("path_outside_folder")
      );
      junction = `정션 ${short} 거부`;
    } else junction = `정션 짧은 이름 없음(${short})`;
  }
  note(context, "C34", "pass", `${file}, ${folder}; ${junction}`);
});

it("C35 refuses a Windows junction leading out and follows one inside", async (context) => {
  if (!windows) without(context, "C35", "n/a", "Windows 정션");
  needs(context, "C35", "junction");
  const { read, got, shared, root, other } = await world();
  await symlink(
    path.join(root, "outside-dir"),
    path.join(shared, "out"),
    "junction"
  );
  await symlink(
    path.join(other, "dir"),
    path.join(shared, "foreign"),
    "junction"
  );
  await symlink(path.join(shared, "dir"), path.join(shared, "in"), "junction");
  // 볼륨마다 정션이 어떻게 보이는지(링크인지 폴더인지, 가리키는 곳, 운영체제가 여는 내용)를 결과와 함께 남긴다.
  const seen: Record<string, unknown> = {};
  for (const name of ["out", "foreign", "in"]) {
    const at = path.join(shared, name);
    const info = await lstat(at).catch(
      (e: NodeJS.ErrnoException) => e.code ?? "error"
    );
    seen[name] = {
      lstat:
        typeof info === "string"
          ? info
          : info.isSymbolicLink()
            ? "link"
            : info.isDirectory()
              ? "dir"
              : "other",
      readlink: await readlink(at).catch(
        (e: NodeJS.ErrnoException) => `<${e.code}>`
      ),
      os: await osOpen(path.join(at, "a.md")),
      ours: await got(`${name}\\a.md`),
    };
  }
  const detail = JSON.stringify(seen);
  expect(seen.out, detail).toMatchObject({
    ours: { refused: "path_outside_folder" },
  });
  expect(seen.foreign, detail).toMatchObject({
    ours: { refused: "path_outside_folder" },
  });
  expect(await read("in\\a.md"), detail).toMatchObject({
    ok: true,
    snapshot: { content: "A:dir/a.md", file: { path: "dir\\a.md" } },
  });
  note(context, "C35", "pass", detail);
});

/** 이름 하나의 대소문자를 뒤집는다. */
const flip = (name: string) =>
  [...name]
    .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    .join("");
// F4: 절대 경로의 작업 폴더 부분은 이름을 대소문자까지 그대로 대조한다(드라이브 문자만 무시). 대소문자를 가리는 폴더에서는
// 대소문자만 다른 다른 폴더일 수 있기 때문이다. 대소문자를 가리지 않는 볼륨에서 같은 폴더를 다르게 적으면 안전한 오거부다.
it("C36 matches the working folder part with its exact case and names inside the way the file system does", async (context) => {
  const { read, got, shared, organizations } = await world();
  const details: string[] = [];
  const flipped = path.join(
    path.dirname(organizations),
    flip("organizations"),
    A,
    "shared",
    "a.md"
  );
  expect(await read(flipped)).toEqual(refusal("path_outside_folder"));
  details.push(
    can.caseSensitive
      ? "대소문자 구분 볼륨"
      : "대소문자 무시 볼륨: 다른 대소문자 작업 폴더 표기는 오거부"
  );
  if (windows) {
    const drive = shared[0]!;
    if (/[A-Za-z]/.test(drive) && shared[1] === ":") {
      const other = `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}${shared.slice(1)}`;
      expect(await read(`${other}\\a.md`)).toMatchObject({
        ok: true,
        snapshot: { content: "A:a.md" },
      });
      details.push("드라이브 문자 대소문자는 무시");
    }
  }
  // 안쪽 이름의 대소문자는 운영체제가 여는 것과 같다.
  const opened = await osOpen(path.join(shared, "A.MD"));
  expect(await got("A.MD")).toEqual(
    typeof opened === "string" ? "A:a.md" : { refused: "file_not_found" }
  );
  // Windows는 폴더 하나만 대소문자를 가리게 할 수 있다(NTFS).
  if (windows) {
    const folder = path.join(shared, "cs");
    await mkdir(folder);
    const set = await run("fsutil.exe", [
      "file",
      "setCaseSensitiveInfo",
      folder,
      "enable",
    ]);
    if (set.ok) {
      await writeFile(path.join(folder, "note.md"), "A:lower");
      await writeFile(path.join(folder, "NOTE.md"), "A:upper");
      expect(await got("cs\\note.md")).toBe("A:lower");
      expect(await got("cs\\NOTE.md")).toBe("A:upper");
      expect(await got("cs\\Note.md")).toEqual({ refused: "file_not_found" });
      details.push("대소문자 구분 폴더 확인");
    } else
      details.push(
        `대소문자 구분 폴더: 적용 불가(${set.output.split("\n")[0]})`
      );
  }
  // F4 그대로: 대소문자를 가리는 부모 폴더에 `organizations`와 `Organizations`가 따로 있으면 대소문자만 다른 표기는
  // 다른 폴더다. 그 폴더의 파일은 운영체제가 열어도 작업 폴더 밖으로 거부한다.
  const parent = await realScratch("bjc-cs-");
  const sensitive = windows
    ? await run("fsutil.exe", [
        "file",
        "setCaseSensitiveInfo",
        parent,
        "enable",
      ])
    : { ok: can.caseSensitive, output: "대소문자 무시 볼륨" };
  if (sensitive.ok) {
    const mine = path.join(parent, "organizations", A, "shared");
    const twin = path.join(parent, "Organizations", A, "shared");
    await mkdir(mine, { recursive: true });
    await mkdir(twin, { recursive: true });
    await writeFile(
      path.join(mine, "..", "workspace-identity.json"),
      JSON.stringify({ version: 1, organizationId: A })
    );
    await writeFile(path.join(mine, "a.md"), "A:a.md");
    await writeFile(path.join(twin, "a.md"), outsideBytes);
    expect(await osOpen(path.join(twin, "a.md"))).toBe(outsideBytes);
    expect(
      await new Workspaces(parent, null as never).readArtifact(
        A,
        path.join(twin, "a.md")
      )
    ).toEqual(refusal("path_outside_folder"));
    details.push("대소문자 구분 부모 폴더의 다른 대소문자 폴더 거부(F4)");
  } else
    details.push(
      `F4 대소문자 구분 부모 폴더: 적용 불가(${sensitive.output.split("\n")[0]})`
    );
  note(
    context,
    "C36",
    can.caseSensitive ? "pass" : "limitation",
    details.join("; ")
  );
});

it("C37 refuses when a parent folder is renamed away and a link leading out takes its name while walking", async (context) => {
  needsLinks(context, "C37");
  const { organizations, shared, root } = await world();
  const result = await injected(organizations, ["dir", "a.md"].join(path.sep), {
    on: "chdir",
    when: "before",
    name: "dir",
    actions: [
      ["renameSync", path.join(shared, "dir"), path.join(root, "moved")],
      [
        "symlinkSync",
        path.join(root, "outside-dir"),
        path.join(shared, "dir"),
        "dir",
      ],
    ],
  });
  expect(text(result.bytes)).toBeNull();
  expect(result.code).toBe(readerExit.changed);
  note(context, "C37", "pass");
});

// F3: 링크 대상의 끝 구분자·`.`·`..` 표기도 운영체제와 같은 파일을 고르거나 함께 거부한다.
it("F3 treats the spelling at the end of a link target the way the operating system does", async (context) => {
  needsLinks(context, "F3");
  const { got, shared } = await world();
  const sep = path.sep;
  await mkdir(path.join(shared, "dir", "sub"));
  const links: [string, string, "file" | "dir"][] = [
    ["file-dot", `a.md${sep}.`, "file"],
    ["file-slash", `a.md${sep}`, "file"],
    ["file-up", `dir${sep}a.md${sep}..`, "file"],
    ["dir-dot", `dir${sep}.`, "dir"],
    ["dir-slash", `dir${sep}`, "dir"],
    ["dir-up", `dir${sep}sub${sep}..`, "dir"],
  ];
  for (const [name, target, type] of links)
    await symlink(target, path.join(shared, name), type);
  const mismatches: string[] = [];
  for (const [name, , type] of links) {
    const requested = type === "dir" ? `${name}${sep}a.md` : name;
    const opened = await osOpen(path.join(shared, requested));
    const ours = await got(requested);
    if (
      (typeof opened === "string") !== (typeof ours === "string") ||
      (typeof opened === "string" && opened !== ours)
    )
      mismatches.push(
        `${requested}: os ${JSON.stringify(opened)}, ours ${JSON.stringify(ours)}`
      );
  }
  expect(mismatches).toEqual([]);
  note(context, "F3", "pass");
});
