import type { InstructionCopy, LifecycleStage } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  decodeInstructionText,
  instructionKindOf,
  instructionsBundleVersion,
  parseSkillFrontmatter,
  planInstructionEdit,
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

describe("planInstructionEdit", () => {
  const ids = () => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  };
  const at = new Date("2026-10-23T01:02:03.000Z");
  const copy = (path: string, content: string): InstructionCopy => ({
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    kind: instructionKindOf(path),
    path,
    content,
    source: `roles/researcher/${path}`,
    sourceDigest: "digest-of-the-library-file",
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const leadAgentId = "44444444-4444-4444-8444-444444444444";
  const plan = (
    target: InstructionCopy,
    input: { content: string; expectedRevision: number },
    stage: LifecycleStage = "researching"
  ) =>
    planInstructionEdit({ copy: target, stage, leadAgentId }, input, {
      newId: ids(),
      now: () => at,
    });

  it("replaces the content, appends the next revision by the owner and wakes the Lead with the edit as the reason", () => {
    const role = copy("AGENTS.md", "# 연구원\n");
    const result = plan(role, {
      content: "# 고친 연구원\n",
      expectedRevision: 1,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.copy).toEqual({
      ...role,
      content: "# 고친 연구원\n",
      revision: 2,
    });
    expect(result.revision).toEqual({
      id: expect.any(String),
      organizationId: role.organizationId,
      agentId: role.agentId,
      copyId: role.id,
      number: 2,
      editor: { author: "owner" },
      path: "AGENTS.md",
      content: "# 고친 연구원\n",
      createdAt: at.toISOString(),
    });
    expect(result.wake).toEqual({
      id: expect.any(String),
      organizationId: role.organizationId,
      agentId: leadAgentId,
      kind: "instruction_edit",
      instructionRevisionId: result.revision.id,
      createdAt: at.toISOString(),
    });
    expect(result.event).toEqual({
      organizationId: role.organizationId,
      type: "instruction_copy.edited",
      payload: {
        by: "owner",
        agentId: role.agentId,
        copyId: role.id,
        path: "AGENTS.md",
        revisionId: result.revision.id,
        revision: 2,
        wokenAgentId: leadAgentId,
      },
    });
  });

  it("keeps the copy source and digest: they describe where the copy came from, not its content", () => {
    const soul = copy("SOUL.md", "a");
    const result = plan(soul, { content: "b", expectedRevision: 1 });
    if (typeof result === "string") throw new Error(result);
    expect(result.copy).toMatchObject({
      source: soul.source,
      sourceDigest: soul.sourceDigest,
    });
  });

  it("records every accepted save, including one that keeps the same content", () => {
    const soul = copy("SOUL.md", "same");
    const result = plan(soul, { content: "same", expectedRevision: 1 });
    if (typeof result === "string") throw new Error(result);
    expect(result.revision.number).toBe(2);
  });

  it("refuses an edit started from an older revision", () => {
    const soul = { ...copy("SOUL.md", "a"), revision: 3 };
    expect(plan(soul, { content: "b", expectedRevision: 2 })).toBe(
      "revision_conflict"
    );
    expect(plan(soul, { content: "b", expectedRevision: 4 })).toBe(
      "revision_conflict"
    );
  });

  it("refuses edits once the organization is completed or stopped, but accepts them while setting goals or paused", () => {
    const role = copy("AGENTS.md", "a");
    for (const stage of ["completed", "stopped"] as const)
      expect(plan(role, { content: "b", expectedRevision: 1 }, stage)).toBe(
        "organization_closed"
      );
    for (const stage of ["goal_setting", "planning", "paused"] as const)
      expect(
        typeof plan(role, { content: "b", expectedRevision: 1 }, stage)
      ).toBe("object");
  });

  it("keeps a Skill loadable: its frontmatter must stay valid and keep the skill's directory name", () => {
    const skill = copy(
      "skills/record-research-node/SKILL.md",
      "---\nname: record-research-node\ndescription: 노드를 남긴다\n---\n본문\n"
    );
    const edit = (content: string) =>
      plan(skill, { content, expectedRevision: 1 });
    expect(typeof edit(skill.content.replace("본문", "고친 본문"))).toBe(
      "object"
    );
    expect(edit("frontmatter 없음")).toBe("invalid_skill");
    expect(edit(skill.content.replace("description: 노드를 남긴다", ""))).toBe(
      "invalid_skill"
    );
    expect(
      edit(skill.content.replace("name: record-research-node", "name: other"))
    ).toBe("invalid_skill");
    // Role·Soul은 빈 본문도 받는다.
    expect(
      typeof plan(copy("SOUL.md", "a"), { content: "", expectedRevision: 1 })
    ).toBe("object");
  });
});
