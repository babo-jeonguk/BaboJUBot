import { describe, expect, it } from "vitest";
import {
  decodeInstructionText,
  instructionsBundleVersion,
  parseSkillFrontmatter,
} from "./harness.ts";

const bundle = {
  role: { path: "AGENTS.md", content: "# 연구원\n" },
  soul: { path: "SOUL.md", content: "# Soul\n" },
  skill: { path: "skills/record-research-node/SKILL.md", content: "skill\n" },
};

describe("instructionsBundleVersion", () => {
  it("depends only on the bundle content, not on file order or copy identity", () => {
    const files = [bundle.role, bundle.soul, bundle.skill];
    expect(instructionsBundleVersion(files)).toBe(
      instructionsBundleVersion([...files].reverse().map((f) => ({ ...f })))
    );
  });

  it("changes when any of the Role, Soul or Skill content changes", () => {
    const base = instructionsBundleVersion(Object.values(bundle));
    for (const key of ["role", "soul", "skill"] as const) {
      const changed = Object.values({
        ...bundle,
        [key]: { ...bundle[key], content: bundle[key].content + "추가\n" },
      });
      expect(instructionsBundleVersion(changed), key).not.toBe(base);
    }
  });

  it("keeps file boundaries: moving text between files changes the version", () => {
    const a = [
      { path: "AGENTS.md", content: "ab" },
      { path: "SOUL.md", content: "c" },
    ];
    const b = [
      { path: "AGENTS.md", content: "a" },
      { path: "SOUL.md", content: "bc" },
    ];
    expect(instructionsBundleVersion(a)).not.toBe(instructionsBundleVersion(b));
  });

  it("has no version without copies", () => {
    expect(instructionsBundleVersion([])).toBeNull();
  });
});

describe("parseSkillFrontmatter", () => {
  it("reads name and description from the SKILL.md frontmatter", () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: record-research-node\ndescription: "노드를 기록한다."\nmetadata:\n  author: x\n---\n# 본문\n'
      )
    ).toEqual({
      name: "record-research-node",
      description: "노드를 기록한다.",
    });
  });

  it("rejects a missing frontmatter, a bad name or an empty description", () => {
    for (const text of [
      "# 본문만\n",
      "---\nname: Record_Node\ndescription: x\n---\n",
      "---\nname: a--b\ndescription: x\n---\n",
      "---\nname: ok\ndescription:\n---\n",
      "---\nname: ok\ndescription: x\n",
    ])
      expect(() => parseSkillFrontmatter(text), text).toThrow();
  });
});

describe("decodeInstructionText", () => {
  it("keeps valid UTF-8 as is and rejects invalid bytes", () => {
    expect(decodeInstructionText(new TextEncoder().encode("한글 ✓"))).toBe(
      "한글 ✓"
    );
    expect(() =>
      decodeInstructionText(new Uint8Array([0x61, 0xff, 0x62]))
    ).toThrow();
  });
});
