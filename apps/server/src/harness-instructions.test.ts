import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { orgToolNames } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { listHarnessLibrary, loadHarnessLibrary } from "./harness.ts";

const harnessDir = path.resolve(import.meta.dirname, "../../../harness");
const hangul = /[ㄱ-ㆎ가-힣]/;

/** 에이전트가 읽는 지침: Role 문서·Soul·Skill. */
async function instructionFiles() {
  const files: string[] = [];
  for (const kind of ["roles", "skills"])
    for (const name of await readdir(path.join(harnessDir, kind)))
      for (const file of await readdir(path.join(harnessDir, kind, name)))
        if (file.endsWith(".md")) files.push(path.join(kind, name, file));
  return files;
}

describe("harness library instructions", () => {
  it("are written in English and name only tools that exist", async () => {
    const files = await instructionFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(path.join(harnessDir, file), "utf8");
      expect(content, file).not.toMatch(hangul);
      for (const [, name] of content.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g))
        expect(orgToolNames, `${file}: ${name}`).toContain(name);
    }
  });

  it("still load as a valid library with Korean labels for the Owner", async () => {
    const library = listHarnessLibrary(await loadHarnessLibrary(harnessDir));
    expect(library.roles.map((r) => r.label)).toContain("연구원");
    expect(library.templates.map((t) => t.label)).toContain("기본 연구 흐름");
  });

  it("tell every Role to write for the Owner in Korean", async () => {
    for (const role of await readdir(path.join(harnessDir, "roles")))
      expect(
        await readFile(
          path.join(harnessDir, "roles", role, "AGENTS.md"),
          "utf8"
        ),
        role
      ).toMatch(/^## Language\n\n.*in Korean/m);
  });
});
