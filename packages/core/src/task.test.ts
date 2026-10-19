import { describe, expect, it } from "vitest";
import {
  planAgentToAgentMessage,
  planOwnerTaskComment,
  planTaskCompletion,
  planTaskCreation,
  planTaskStart,
  type TaskState,
} from "./task.ts";

const at = "2026-10-19T00:00:00.000Z";
let n = 0;
const source = { newId: () => `id-${++n}`, now: () => new Date(at) };

const lead = {
  id: "run-lead",
  organizationId: "org-1",
  agentId: "lead",
  role: "lead",
} as const;
const worker = (agentId: string) =>
  ({
    id: `run-${agentId}`,
    organizationId: "org-1",
    agentId,
    role: "worker",
  }) as const;
const task = (fields: Partial<TaskState> = {}): TaskState => ({
  id: "task-1",
  organizationId: "org-1",
  title: "자료 조사",
  status: "open",
  assigneeAgentId: "w1",
  createdByAgentId: "lead",
  parentAssigneeAgentId: null,
  ...fields,
});

describe("planTaskCreation", () => {
  it("wakes the assignee with the assignment", () => {
    const plan = planTaskCreation(
      lead,
      { title: "자료 조사", description: "", assigneeAgentId: "w1" },
      source
    );
    expect(plan.task).toMatchObject({
      status: "open",
      parentTaskId: null,
      createdByAgentId: "lead",
      createdByRunId: "run-lead",
    });
    expect(plan.wake).toMatchObject({
      agentId: "w1",
      kind: "task_assigned",
      taskId: plan.task.id,
    });
    expect(plan.event.payload).toMatchObject({ wokenAgentId: "w1" });
  });

  it("does not wake an agent that assigned the task to itself", () => {
    const plan = planTaskCreation(
      worker("w1"),
      { title: "하위 조사", description: "", assigneeAgentId: "w1" },
      source
    );
    expect(plan.wake).toBeUndefined();
    expect(plan.event.payload).toMatchObject({ wokenAgentId: null });
  });
});

describe("planTaskStart", () => {
  it("lets only the assignee start an open task", () => {
    expect(planTaskStart(worker("w1"), task(), source)).toMatchObject({
      event: { type: "task.started" },
    });
    expect(planTaskStart(worker("w2"), task(), source)).toBe("not_assignee");
    expect(planTaskStart(lead, task(), source)).toBe("not_assignee");
    for (const status of ["in_progress", "completed"] as const)
      expect(planTaskStart(worker("w1"), task({ status }), source)).toBe(
        "invalid_transition"
      );
  });
});

describe("planTaskCompletion", () => {
  it("wakes the parent task's assignee, even while sibling tasks are open", () => {
    const plan = planTaskCompletion(
      worker("w1"),
      task({ parentAssigneeAgentId: "w2", status: "in_progress" }),
      "정리했습니다",
      source
    );
    expect(plan).toMatchObject({
      report: { summary: "정리했습니다", agentId: "w1", runId: "run-w1" },
      wake: { agentId: "w2", kind: "task_completed", taskId: "task-1" },
      event: { payload: { wokenAgentId: "w2" } },
    });
  });

  it("wakes the creating agent when the task has no parent", () => {
    expect(
      planTaskCompletion(worker("w1"), task(), "끝", source)
    ).toMatchObject({ wake: { agentId: "lead", kind: "task_completed" } });
  });

  it("does not wake the completing agent itself", () => {
    const plan = planTaskCompletion(lead, task(), "Lead가 정리", source);
    expect(plan).toMatchObject({ wake: undefined });
    expect(plan).toMatchObject({ event: { payload: { wokenAgentId: null } } });
  });

  it("lets the assignee or the Lead complete a task once", () => {
    expect(planTaskCompletion(worker("w2"), task(), "x", source)).toBe(
      "not_assignee"
    );
    expect(
      planTaskCompletion(
        worker("w1"),
        task({ status: "completed" }),
        "x",
        source
      )
    ).toBe("already_completed");
    expect(
      planTaskCompletion(lead, task({ status: "completed" }), "x", source)
    ).toBe("already_completed");
  });
});

describe("planOwnerTaskComment", () => {
  it("wakes the assignee even when the task is completed, without reopening it", () => {
    const plan = planOwnerTaskComment(
      task({ status: "completed" }),
      "근거를 보강해 주세요",
      source
    );
    expect(plan.comment).toMatchObject({
      author: "owner",
      agentId: null,
      runId: null,
    });
    expect(plan.wake).toMatchObject({
      agentId: "w1",
      kind: "task_comment",
      commentId: plan.comment.id,
    });
    expect("status" in plan).toBe(false);
  });
});

describe("planAgentToAgentMessage", () => {
  it("wakes the recipient and refuses messages to oneself", () => {
    expect(
      planAgentToAgentMessage(
        worker("w1"),
        { recipientAgentId: "w2", body: "데이터 어디 있나요?" },
        source
      )
    ).toMatchObject({
      message: { senderAgentId: "w1", recipientAgentId: "w2" },
      wake: { agentId: "w2", kind: "agent_to_agent_message" },
    });
    expect(
      planAgentToAgentMessage(
        worker("w1"),
        { recipientAgentId: "w1", body: "나에게" },
        source
      )
    ).toBe("self_message");
  });
});
