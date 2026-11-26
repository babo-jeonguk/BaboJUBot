import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callArming } from "@babojubot/process/call-arming";
import { removeFolder } from "@babojubot/process/remove-folder";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ephemeralCluster, startEmbeddedCluster } from "./embedded.ts";
import { attemptAll } from "@babojubot/contracts";

// 임시 cluster를 만들다 실패한 뒤 그 폴더를 지우는 정리까지 실패하게 한다. 지우기·주인 기록 폴더 만들기·주인 기록 읽기를 그 시험의
// 경로에서만 실패시킨다(#286).
const inject = vi.hoisted(() => ({
  /** 정확히 이 경로(`at`, 그 시험의 임시 cluster 폴더)를 지우면 이 오류로 실패한다. */
  removeFails: undefined as { at: string; error: Error } | undefined,
  /** 이 폴더(`in`, 그 시험의 `<dataDir>.owner`) 안의 주인 기록 파일을 읽으면 이 오류로 실패한다. */
  ownerReadFails: undefined as { in: string; error: Error } | undefined,
}));
/**
 * 제품이 안에서 만드는 임시 cluster 폴더는 시험이 그 경로를 미리 알 수 없다. 시험은 제품 호출을
 * `madeCalls.run(무장, () => 제품 호출)`로 감싸고, 대역은 불린 순간 그 호출의 무장을 잡는다. 그 호출이 만든 폴더를 `made`에 남기고,
 * 그 폴더의 지우기·주인 기록 폴더 만들기만 실패시킨다. 다른 시험의 호출이나 문맥 밖 호출은 무장이 없어 실패하지 않는다(#286).
 */
const madeCalls = callArming<{
  made: string[];
  removeFails?: Error;
  ownerFolderFails?: Error;
}>();
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    const fault = inject.removeFails;
    if (fault?.at === String(target)) throw fault.error;
    const arming = madeCalls.current();
    if (arming?.removeFails && arming.made.includes(String(target)))
      throw arming.removeFails;
    return real.rm(target, options);
  };
  const mkdtemp = (async (prefix: string) => {
    const arming = madeCalls.current();
    const made = await real.mkdtemp(prefix);
    arming?.made.push(made);
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
    const arming = madeCalls.current();
    if (
      arming?.ownerFolderFails &&
      arming.made.some((made) => `${made}.owner` === String(target))
    )
      throw arming.ownerFolderFails;
    return real.mkdirSync(target, options);
  }) as typeof real.mkdirSync;
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const fault = inject.ownerReadFails;
    if (fault?.in === path.dirname(String(args[0]))) throw fault.error;
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

/** 진단은 오류 문구·객체 대신 원인 코드로 남는다(#286, failureCode). 남긴 줄에 그 코드가 있고, 오류 객체는 남기지 않는다. */
function expectLoggedCode(values: unknown[], code: string) {
  expect(values.filter((value) => value instanceof Error)).toEqual([]);
  expect(values).toContainEqual(expect.stringContaining(`(${code})`));
}

afterEach(() => {
  inject.removeFails = undefined;
  inject.ownerReadFails = undefined;
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
    inject.removeFails = { at: options.dataDir, error: removeError };
    await expect(startEmbeddedCluster(options)).rejects.toThrow(
      "could not create embedded Postgres"
    );
    expectLoggedCode(logs(), "EACCES");
  }, 60_000);

  it("keeps the ownership error and records the removal failure", async () => {
    const ownerError = Object.assign(
      new Error("injected: the owner record folder could not be made"),
      { code: "EACCES" }
    );
    const removeError = Object.assign(
      new Error("injected: removing the folder failed"),
      { code: "EBUSY" }
    );
    const arming = {
      made: [] as string[],
      ownerFolderFails: ownerError,
      removeFails: removeError,
    };
    onTestFinished(() =>
      attemptAll(
        arming.made.flatMap((made) => [
          () => removeFolder(made),
          () => removeFolder(`${made}.owner`),
        ])
      )
    );
    const logs = logged();
    await expect(madeCalls.run(arming, () => ephemeralCluster())).rejects.toBe(
      ownerError
    );
    // 그 호출이 만든 폴더 하나에서 두 실패가 났다.
    expect(arming.made).toHaveLength(1);
    // 지우기 실패는 소유 오류와 다른 원인 코드로 남는다.
    expectLoggedCode(logs(), "EBUSY");
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
    inject.ownerReadFails = { in: owners, error: denied };
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
    inject.ownerReadFails = {
      in: owners,
      error: Object.assign(
        new Error("injected: the leftover owner record could not be read"),
        { code: "EACCES" }
      ),
    };
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
    // 남긴 줄이 그 남은 cluster와 원인 코드를 함께 담는다.
    expect(
      logs().filter(
        (value) =>
          typeof value === "string" &&
          value.includes(leftover) &&
          value.includes("(EACCES)")
      )
    ).toHaveLength(1);
    expectLoggedCode(logs(), "EACCES");
  });
});
