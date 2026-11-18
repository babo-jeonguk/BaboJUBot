import { defaultApprovalPolicy, type RunRequest } from "@babojubot/contracts";
import { createRelayHub } from "./relay.ts";

/** 정책을 붙인 중계(시험용). 연구 목적지는 없고 조직 도구는 404로 답한다. */
export function attachedRelayHub() {
  const hub = createRelayHub();
  hub.attach({
    research: async () => [],
    tools: (_req, res) => {
      res.statusCode = 404;
      res.end();
    },
    protectedPorts: () => [],
  });
  return hub;
}
export function request(): RunRequest {
  const organizationId = crypto.randomUUID(),
    agentId = crypto.randomUUID();
  const agent = { id: agentId, role: "lead" as const, name: "Lead" };
  return {
    identity: { organizationId, agentId, runId: crypto.randomUUID() },
    access: {
      toolsBaseUrl: "http://127.0.0.1:1/api/tools",
      token: "private-run-token",
    },
    wakeReasons: [
      { kind: "organization_created", wakeId: crypto.randomUUID() },
    ],
    context: {
      organization: {
        id: organizationId,
        name: "Research",
        stage: "planning",
        goal: "Research",
        completionCriteria: null,
        approvalPolicy: defaultApprovalPolicy,
      },
      agent,
      team: [agent],
      conversations: [],
      conversation: [],
      researchFlow: null,
    },
    instructionsBundleVersion: null,
    instructions: [],
    workspace: null,
    model: null,
    previousSession: null,
  };
}
export const saying =
  (body: string) =>
  (
    access: RunRequest["access"],
    identity: RunRequest["identity"]
  ): RunRequest => {
    const input = request(),
      conversationId = crypto.randomUUID();
    const agent = { id: identity.agentId, role: "lead" as const, name: "Lead" };
    return {
      ...input,
      access,
      identity,
      wakeReasons: [
        {
          kind: "owner_message",
          wakeId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          conversationId,
          body,
        },
      ],
      context: {
        ...input.context,
        organization: {
          ...input.context.organization,
          id: identity.organizationId,
          stage: "researching",
        },
        agent,
        team: [agent],
        conversations: [
          {
            id: conversationId,
            title: "기본 대화",
            isDefault: true,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    };
  };

/**
 * A clock that moves only when the test says (#215). Limits on it measure only the step under test (starting a program takes
 * no time on it however slow the machine is), and the order of timers and program events is set by state, not by real time.
 */
export function manualClock() {
  let now = 0,
    sequence = 0;
  const timers = new Map<
    number,
    { at: number; setAt: number; callback: () => void }
  >();
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      timers.set(++sequence, { at: now + ms, setAt: now, callback });
      return sequence;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    /** The delays of the timers still waiting, in the order they were set. */
    scheduled: () =>
      [...timers.values()].map((timer) => timer.at - timer.setAt),
    /**
     * Moves the time on and runs, in order, every timer that is due by then, including ones a callback sets on the way (a stop
     * timer that sets a kill timer runs both), each at its own time as on the real clock.
     */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort(([ha, a], [hb, b]) => a.at - b.at || ha - hb)[0];
        if (!next) break;
        const [handle, timer] = next;
        timers.delete(handle);
        now = timer.at;
        timer.callback();
      }
      now = until;
    },
  };
}
