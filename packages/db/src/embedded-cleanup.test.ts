import fs from "node:fs";
import path from "node:path";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ephemeralCluster, startEmbeddedCluster } from "./embedded.ts";

// 임시 cluster를 만들다 실패한 뒤 그 폴더를 지우는 정리까지 실패하게 한다. 지우기·주인 기록 폴더 만들기를 시험이 고른
// 경로에서만 실패시킨다.
const inject = vi.hoisted(() => ({
  removeFails: undefined as Error | undefined,
  ownerFolderFails: undefined as Error | undefined,
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
  return { ...real, mkdirSync, default: { ...real, mkdirSync } };
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
    const logs = logged();
    try {
      inject.removeFails = removeError;
      await expect(startEmbeddedCluster(options)).rejects.toThrow(
        "could not create embedded Postgres"
      );
      expect(logs()).toContain(removeError);
    } finally {
      inject.removeFails = undefined;
      await removeFolder(options.dataDir);
      await removeFolder(`${options.dataDir}.owner`);
    }
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
    const logs = logged();
    try {
      inject.ownerFolderFails = ownerError;
      inject.removeFails = removeError;
      await expect(ephemeralCluster()).rejects.toBe(ownerError);
      expect(logs()).toContain(removeError);
    } finally {
      inject.ownerFolderFails = undefined;
      inject.removeFails = undefined;
      for (const made of inject.made.splice(0)) {
        await removeFolder(made);
        await removeFolder(`${made}.owner`);
      }
    }
  });
});
