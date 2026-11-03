import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { recoverProviderProcesses } from "./recovery.ts";

// 복구 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 경고하고 넘어간다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function records() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-recovery-"));
  roots.push(root);
  const directory = path.join(root, "providers/claude/processes");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

it("skips a record that cannot be read and still handles the others", async () => {
  const { root, directory } = await records();
  await writeFile(path.join(directory, "123.json"), '{"pid":12');
  await writeFile(
    path.join(directory, "456.json"),
    JSON.stringify({
      pid: 456,
      start: "1",
      group: 456,
      boot: "another-boot",
      lease: "x",
    })
  );
  await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

it("leaves a process group it cannot identify alone and still starts", async () => {
  const { root, directory } = await records();
  const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => leader.on("close", resolve));
  const group = leader.pid!;
  try {
    await writeFile(
      path.join(directory, `${group}.json`),
      JSON.stringify({
        pid: group,
        start: "1",
        group,
        boot: (
          await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        ).trim(),
        lease: "not-the-real-lease",
      })
    );
    await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
    expect(() => process.kill(-group, 0)).not.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    process.kill(-group, "SIGKILL");
  }
});
