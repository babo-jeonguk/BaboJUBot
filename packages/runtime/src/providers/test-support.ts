import { defaultApprovalPolicy, type RunRequest } from "@babojubot/contracts";
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
