import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ephemeralCluster, startEmbeddedCluster } from "./embedded.ts";
import { attemptAll } from "@babojubot/contracts";

// 임시 cluster를 만들다 실패한 뒤 그 폴더를 지우는 정리까지 실패하게 한다. 지우기·주인 기록 폴더 만들기를 시험이 고른
// 경로에서만 실패시킨다.
const inject = vi.hoisted(() => ({
  removeFails: undefined as Error | undefined,
  ownerFolderFails: undefined as Error | undefined,
  /** 주인 기록 파일(`<dataDir>.owner/<번호>`)을 읽으면 이 오류로 실패한다. */
  ownerReadFails: undefined as Error | undefined,
  /** 정하면 이 폴더 안의 주인 기록만 실패한다. */
  ownerReadFailsIn: undefined as string | undefined,
  /** 이 시험이 만든 임시 폴더. 지우기를 실패시킨 폴더를 시험 끝에 치운다. */
  made: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    if (inject.removeFails && String(target).includes("babojubot-pg-"))
      throw inject.removeFails;
    return real.rm(target, options);
  };
  const mkdtemp = (async (prefix: string) => {
    const made = await real.mkdtemp(prefix);
    inject.made.push(made);
    return made;
  }) as typeof real.mkdtemp;
  return {
    ...real,
    rm,
    mkdtemp,
    default: { ...real, rm, mkdtemp },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const mkdirSync = ((target, options) => {
    if (inject.ownerFolderFails && String(target).endsWith(".owner"))
      throw inject.ownerFolderFails;
    return real.mkdirSync(target, options);
  }) as typeof real.mkdirSync;
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const file = String(args[0]);
    if (
      inject.ownerReadFails &&
      /\.owner[\\/]\d+$/.test(file) &&
      (!inject.ownerReadFailsIn || file.startsWith(inject.ownerReadFailsIn))
    )
      throw inject.ownerReadFails;
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return {
    ...real,
    mkdirSync,
    readFileSync,
    default: { ...real, mkdirSync, readFileSync },
  };
});

/** console.error·warn으로 남긴 값들. 정리 실패가 원래 오류와 따로 기록됐는지 본다. */
function logged() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => [...error.mock.calls, ...warn.mock.calls].flat();
}

afterEach(() => {
  inject.removeFails = undefined;
  inject.ownerFolderFails = undefined;
  inject.ownerReadFails = undefined;
  inject.ownerReadFailsIn = undefined;
  vi.restoreAllMocks();
});

describe("a temporary cluster whose cleanup fails after a failed start", () => {
  it("keeps the creation error and records the removal failure", async () => {
    const options = await ephemeralCluster();
    // 비어 있지 않은 폴더에는 initdb가 cluster를 만들지 않는다.
    fs.writeFileSync(path.join(options.dataDir, "unrelated"), "");
    const removeError = Object.assign(
      new Error("injected: removing the folder failed"),
      { code: "EACCES" }
    );
    // 지우기를 실패시킨 폴더는 시험 정리가 지운다. 실패 주입은 그 전에 afterEach가 끈다.
    onTestFinished(() =>
      attemptAll([
        () => removeFolder(options.dataDir),
        () => removeFolder(`${options.dataDir}.owner`),
      ])
    );
    const logs = logged();
    inject.removeFails = removeError;
    await expect(startEmbeddedCluster(options)).rejects.toThrow(
      "could not create embedded Postgres"
    );
    expect(logs()).toContain(removeError);
  }, 60_000);

  it("keeps the ownership error and records the removal failure", async () => {
    const ownerError = Object.assign(
      new Error("injected: the owner record folder could not be made"),
      { code: "EACCES" }
    );
    const removeError = Object.assign(
      new Error("injected: removing the folder failed"),
      { code: "EACCES" }
    );
    onTestFinished(() =>
      attemptAll(
        inject.made
          .splice(0)
          .flatMap((made) => [
            () => removeFolder(made),
            () => removeFolder(`${made}.owner`),
          ])
      )
    );
    const logs = logged();
    inject.ownerFolderFails = ownerError;
    inject.removeFails = removeError;
    await expect(ephemeralCluster()).rejects.toBe(ownerError);
    expect(logs()).toContain(removeError);
  });
});

// 주인 기록을 읽지 못한 것은 주인이 없는 것과 다르다. 주인 없음으로 보면 살아 있는 다른 주인의 cluster를 다음 세대로 가져간다.
describe("an owner record that cannot be read", () => {
  it("fails the start with the read error and does not take ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-owner-"));
    onTestFinished(() => removeFolder(root));
    // dataDir 자리에 파일을 두어, 주인을 잘못 가져가더라도 Postgres를 띄우기 전에 실패하게 한다.
    const dataDir = path.join(root, "data");
    fs.writeFileSync(dataDir, "");
    const owners = `${dataDir}.owner`;
    fs.mkdirSync(owners);
    fs.writeFileSync(
      path.join(owners, "1"),
      JSON.stringify({ pid: process.pid, persistent: true })
    );
    const denied = Object.assign(
      new Error("injected: the owner record could not be read"),
      { code: "EACCES" }
    );
    inject.ownerReadFails = denied;
    logged();

    await expect(
      startEmbeddedCluster({ dataDir, persistent: true })
    ).rejects.toBe(denied);
    inject.ownerReadFails = undefined;
    expect(fs.readdirSync(owners).sort()).toEqual(["1"]);
  });
});

// 남은 임시 cluster를 치우는 것은 덤이다. 그중 하나의 주인 기록을 읽지 못해도 새 임시 cluster는 뜨고, 그 항목은 손대지 않고 남긴다.
describe("a leftover temporary cluster whose owner record cannot be read", () => {
  it("is left with a warning while a new temporary cluster still starts", async () => {
    // 기록만 남은 남은 cluster. 주인은 살아 있는 이 시험 프로세스라 동시에 도는 다른 시험 프로세스는 치우지 않는다.
    const leftover = path.join(os.tmpdir(), `babojubot-pg-${randomUUID()}`);
    const owners = `${leftover}.owner`;
    onTestFinished(() => removeFolder(owners));
    fs.mkdirSync(owners);
    fs.writeFileSync(
      path.join(owners, "1"),
      JSON.stringify({ pid: process.pid, persistent: false })
    );
    inject.ownerReadFails = Object.assign(
      new Error("injected: the leftover owner record could not be read"),
      { code: "EACCES" }
    );
    inject.ownerReadFailsIn = owners;
    const logs = logged();

    const options = await ephemeralCluster();
    onTestFinished(() =>
      attemptAll([
        () => removeFolder(options.dataDir),
        () => removeFolder(`${options.dataDir}.owner`),
      ])
    );
    inject.ownerReadFails = undefined;

    expect(fs.existsSync(options.dataDir)).toBe(true);
    expect(fs.readdirSync(owners)).toEqual(["1"]);
    expect(
      logs().some(
        (value) => typeof value === "string" && value.includes(leftover)
      )
    ).toBe(true);
  });
});
