import type { ResearchNode } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  planDiscard,
  planLinkAddition,
  planNodeCreation,
  planNodeUpdate,
  planParentChange,
  planRestore,
  planTaskNodeLink,
  type MapEditor,
  type MapSnapshot,
} from "./research-map.ts";

const at = "2026-10-20T00:00:00.000Z";
let n = 0;
const source = { newId: () => `id-${++n}`, now: () => new Date(at) };

const owner: MapEditor = { author: "owner", leadAgentId: "lead" };
const agent: MapEditor = { author: "agent", agentId: "w1", runId: "run-w1" };

const node = (
  id: string,
  fields: Partial<ResearchNode> = {}
): ResearchNode => ({
  id,
  organizationId: "org-1",
  kind: "hypothesis",
  title: `노드 ${id}`,
  body: "",
  status: "proposed",
  statusBeforeDiscard: null,
  parentNodeId: null,
  createdBy: { author: "owner" },
  createdAt: at,
  updatedAt: at,
  ...fields,
});

/** P ← H ← M (주 연결), D는 폐기된 노드, X는 부모 없는 노드. */
const map = (...extra: ResearchNode[]): MapSnapshot => ({
  organizationId: "org-1",
  nodeKinds: [
    { name: "problem", label: "연구 문제" },
    { name: "hypothesis", label: "가설·아이디어" },
  ],
  linkKinds: [{ name: "supports", label: "뒷받침" }],
  nodes: new Map(
    [
      node("P", { kind: "problem" }),
      node("H", { parentNodeId: "P" }),
      node("M", { parentNodeId: "H" }),
      node("D", {
        parentNodeId: "P",
        status: "discarded",
        statusBeforeDiscard: "in_progress",
      }),
      node("X"),
      ...extra,
    ].map((x) => [x.id, x])
  ),
});

describe("planNodeCreation", () => {
  it("creates a proposed node under an optional primary parent and wakes the Lead only for the owner's edit", () => {
    const byOwner = planNodeCreation(
      map(),
      owner,
      { kind: "hypothesis", title: "새 가설", body: "", parentNodeId: "P" },
      source
    );
    if (typeof byOwner === "string" || byOwner.kind !== "edit")
      throw new Error(String(byOwner));
    expect(byOwner.value).toMatchObject({
      status: "proposed",
      parentNodeId: "P",
      createdBy: { author: "owner" },
    });
    expect(byOwner.edit).toMatchObject({
      editor: { author: "owner" },
      operation: "create_node",
      nodeId: byOwner.value.id,
      summary: "노드 추가: 가설·아이디어 “새 가설” (주 부모 “노드 P”)",
    });
    expect(byOwner.wake).toMatchObject({
      agentId: "lead",
      kind: "research_map_edit",
      mapEditId: byOwner.edit.id,
    });
    expect(byOwner.event.payload).toMatchObject({
      author: "owner",
      agentId: null,
      wokenAgentId: "lead",
    });

    const byAgent = planNodeCreation(
      map(),
      agent,
      { kind: "problem", title: "루트", body: "" },
      source
    );
    if (typeof byAgent === "string" || byAgent.kind !== "edit")
      throw new Error(String(byAgent));
    expect(byAgent.value.parentNodeId).toBeNull();
    expect(byAgent.value.createdBy).toEqual({
      author: "agent",
      agentId: "w1",
      runId: "run-w1",
    });
    expect(byAgent.wake).toBeUndefined();
    expect(byAgent.event.payload).toMatchObject({
      author: "agent",
      agentId: "w1",
      runId: "run-w1",
      wokenAgentId: null,
    });
  });

  it("refuses a kind the organization's template does not declare, a missing parent and a discarded parent", () => {
    const create = (kind: string, parentNodeId?: string) =>
      planNodeCreation(
        map(),
        owner,
        { kind, title: "x", body: "", parentNodeId },
        source
      );
    expect(create("experiment")).toBe("unknown_kind");
    expect(create("problem", "nope")).toBe("not_found");
    expect(create("problem", "D")).toBe("node_discarded");
  });
});

describe("planParentChange", () => {
  it("assigns a parent only to a parentless node and changes it only explicitly", () => {
    expect(planParentChange(map(), agent, "H", "X", "assign", source)).toBe(
      "primary_parent_exists"
    );
    const assigned = planParentChange(map(), agent, "X", "M", "assign", source);
    expect(assigned).toMatchObject({
      kind: "edit",
      value: { parentNodeId: "M" },
      edit: { operation: "assign_parent" },
    });
    const changed = planParentChange(map(), owner, "H", "X", "change", source);
    expect(changed).toMatchObject({
      kind: "edit",
      value: { parentNodeId: "X" },
      edit: { summary: "노드 “노드 H” 주 부모: “노드 P” → “노드 X”" },
    });
    expect(
      planParentChange(map(), owner, "H", null, "change", source)
    ).toMatchObject({ kind: "edit", value: { parentNodeId: null } });
    expect(
      planParentChange(map(), owner, "H", "P", "change", source)
    ).toMatchObject({ kind: "unchanged" });
  });

  it("refuses itself or a descendant as the parent, following primary links through discarded nodes", () => {
    expect(planParentChange(map(), owner, "P", "P", "change", source)).toBe(
      "primary_cycle"
    );
    expect(planParentChange(map(), owner, "P", "M", "change", source)).toBe(
      "primary_cycle"
    );
    // D(폐기)의 하위 노드 C도 P의 후손이다.
    const withChild = map(node("C", { parentNodeId: "D" }));
    expect(planParentChange(withChild, owner, "P", "C", "change", source)).toBe(
      "primary_cycle"
    );
  });

  it("refuses a discarded node or a discarded parent", () => {
    expect(planParentChange(map(), owner, "D", "X", "change", source)).toBe(
      "node_discarded"
    );
    expect(planParentChange(map(), owner, "X", "D", "assign", source)).toBe(
      "node_discarded"
    );
    expect(planParentChange(map(), owner, "X", "nope", "assign", source)).toBe(
      "not_found"
    );
  });
});

describe("planLinkAddition", () => {
  it("adds secondary links freely, including cycles and duplicates, but not to itself", () => {
    const add = (
      sourceNodeId: string,
      targetNodeId: string,
      kind = "supports"
    ) =>
      planLinkAddition(
        map(),
        agent,
        { sourceNodeId, targetNodeId, kind },
        source
      );
    const first = add("M", "P");
    const again = add("M", "P");
    if (typeof first === "string" || first.kind !== "edit") throw first;
    if (typeof again === "string" || again.kind !== "edit") throw again;
    expect(first.value.id).not.toBe(again.value.id);
    expect(first.edit).toMatchObject({
      operation: "add_link",
      nodeId: "M",
      linkId: first.value.id,
      summary: "보조 연결 추가: “노드 M” ─뒷받침→ “노드 P”",
    });
    expect(add("P", "M")).toMatchObject({ kind: "edit" });
    expect(add("P", "P")).toBe("self_link");
    expect(add("P", "M", "relates")).toBe("unknown_kind");
    expect(add("P", "D")).toBe("node_discarded");
    expect(add("P", "nope")).toBe("not_found");
  });
});

describe("planDiscard and planRestore", () => {
  it("discards by status, keeping the previous status, and restores it", () => {
    const busy = map(node("B", { status: "in_progress", parentNodeId: "P" }));
    const discarded = planDiscard(busy, owner, "B", source);
    expect(discarded).toMatchObject({
      kind: "edit",
      value: {
        status: "discarded",
        statusBeforeDiscard: "in_progress",
        parentNodeId: "P",
      },
      wake: { agentId: "lead" },
    });
    expect(planDiscard(busy, owner, "D", source)).toMatchObject({
      kind: "unchanged",
    });
    expect(planRestore(busy, owner, "D", source)).toMatchObject({
      kind: "edit",
      value: { status: "in_progress", statusBeforeDiscard: null },
      edit: { summary: "노드 “노드 D” 폐기 취소 (상태 진행 중)" },
    });
    expect(planRestore(busy, owner, "B", source)).toMatchObject({
      kind: "unchanged",
    });
  });

  it("accepts only a restore for a discarded node", () => {
    expect(planNodeUpdate(map(), owner, "D", { title: "y" }, source)).toBe(
      "node_discarded"
    );
  });
});

describe("planNodeUpdate", () => {
  it("records only what changed and treats the same values as no edit", () => {
    expect(
      planNodeUpdate(
        map(),
        owner,
        "H",
        { title: "노드 H", status: "proposed" },
        source
      )
    ).toMatchObject({ kind: "unchanged" });
    expect(
      planNodeUpdate(
        map(),
        owner,
        "H",
        { title: "바뀐 제목", status: "done" },
        source
      )
    ).toMatchObject({
      kind: "edit",
      value: { title: "바뀐 제목", status: "done", parentNodeId: "P" },
      edit: {
        summary:
          "노드 “노드 H” 수정: 제목 “노드 H” → “바뀐 제목”, 상태 제안됨 → 완료",
      },
    });
  });
});

describe("planTaskNodeLink", () => {
  const task = (researchNodeId: string | null) => ({
    id: "task-1",
    title: "작업",
    researchNodeId,
  });

  it("links an unlinked task once and requires an explicit relink for another node", () => {
    expect(
      planTaskNodeLink(map(), agent, task(null), "H", "link", source)
    ).toMatchObject({
      kind: "edit",
      change: { type: "set_task_node", taskId: "task-1", researchNodeId: "H" },
      edit: { operation: "link_task", nodeId: "H", taskId: "task-1" },
    });
    expect(
      planTaskNodeLink(map(), agent, task("H"), "H", "link", source)
    ).toMatchObject({ kind: "unchanged" });
    expect(planTaskNodeLink(map(), agent, task("H"), "M", "link", source)).toBe(
      "task_already_linked"
    );
    expect(
      planTaskNodeLink(map(), agent, task("H"), "M", "relink", source)
    ).toMatchObject({ kind: "edit", value: { researchNodeId: "M" } });
    expect(
      planTaskNodeLink(map(), agent, task("H"), null, "unlink", source)
    ).toMatchObject({
      kind: "edit",
      edit: { operation: "unlink_task", nodeId: "H" },
      value: { researchNodeId: null },
    });
    expect(
      planTaskNodeLink(map(), agent, task(null), null, "unlink", source)
    ).toMatchObject({ kind: "unchanged" });
    expect(
      planTaskNodeLink(map(), agent, task(null), "D", "link", source)
    ).toBe("node_discarded");
    expect(
      planTaskNodeLink(map(), agent, task(null), "nope", "link", source)
    ).toBe("not_found");
  });
});
