import { defaultApprovalPolicy, type RunRequest } from "@babojubot/contracts";
import { describeRuntimeContract } from "./runtime-contract.ts";
import { createScriptedRuntime, expiredFakeSession } from "./scripted.ts";

/** 연구 진행 중인 조직의 Lead가 사용자 메시지 하나로 깨어난 요청. */
function leadRequest(access: RunRequest["access"], body: string): RunRequest {
  const organizationId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const lead = { id: agentId, role: "lead" as const, name: "Research Lead" };
  return {
    identity: { organizationId, agentId, runId: crypto.randomUUID() },
    access,
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
      organization: {
        id: organizationId,
        name: "조직",
        stage: "researching",
        goal: "목표",
        completionCriteria: "기준",
        approvalPolicy: defaultApprovalPolicy,
      },
      agent: lead,
      team: [lead],
      conversations: [
        {
          id: conversationId,
          title: "기본 대화",
          isDefault: true,
          createdAt: new Date().toISOString(),
        },
      ],
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

const scenes = {
  // 사용자 메시지에 답장하고 끝난다(맥락 조회 → 진행 활동 → 답장).
  finishes: (access: RunRequest["access"]) =>
    leadRequest(access, "진행 상황을 알려 주세요"),
  // `실행 유지 연습`은 취소될 때까지 끝내지 않는다.
  worksUntilCancelled: (access: RunRequest["access"]) =>
    leadRequest(access, "실행 유지 연습"),
};

// 가짜 프로바이더가 첫 adapter다. 실제 HTTP로 가짜 도구 서버에 붙는다. 기본 설정(끼워 넣기·세션·사용량 지원)과
// 아무것도 지원하지 않는 설정 둘 다 같은 공통 검사를 통과한다.
describeRuntimeContract("scripted runtime", {
  adapter: createScriptedRuntime(),
  ...scenes,
  unusableSession: expiredFakeSession,
});

describeRuntimeContract("scripted runtime supporting nothing optional", {
  adapter: createScriptedRuntime({
    settings: {
      capabilities: {
        steer: false,
        resume: false,
        reinjectInstructionsOnResume: false,
        usageTokens: false,
        usageCost: false,
        precompact: false,
      },
      readiness: { status: "not_ready", reason: "product_login_missing" },
      loginCommand: null,
    },
  }),
  ...scenes,
});
