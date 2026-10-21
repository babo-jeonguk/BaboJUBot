import type {
  ConversationMessage,
  OrgToolName,
  RequestInitialApprovalInput,
  RunContextResponse,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  Task,
  TaskDetail,
  WakeReason,
} from "@babojubot/contracts";
import { createOrgToolClient, OrgToolError } from "./tools-client.ts";

// 가짜 실행기. 모델을 부르지 않고 에이전트(Role)와 깨우기 사유에 맞는 시나리오 단계를 실행한다.
// 각 단계는 실행 시도별 토큰으로 실제 조직 도구 HTTP 경로를 부르며 DB를 직접 쓰지 않는다.

/** 조직 도구 호출 하나의 결과. 거부를 허용한 단계는 거부도 결과로 남긴다. */
export type ToolCallRecord =
  | { tool: OrgToolName; ok: true; output: unknown }
  | { tool: OrgToolName; ok: false; status: number; code: string | undefined };

/** 시나리오가 진행하며 쌓는 상태. */
export type ScriptState = {
  request: RunRequest;
  context: RunContextResponse | undefined;
  sent: ConversationMessage[];
  calls: ToolCallRecord[];
};

export type ScriptStep =
  /** 내 실행 맥락 조회. */
  | { do: "read_context" }
  /** 공개 활동을 낸다. Control Plane이 허용하지 않는 값은 버려진다. */
  | { do: "emit"; activity: unknown }
  /** Lead 대화에 답장한다. */
  | { do: "send_message"; body: (state: ScriptState) => string }
  /** 조직 안의 메시지 하나를 조회한다. */
  | { do: "read_message"; messageId: (state: ScriptState) => string }
  /**
   * 조직 도구 하나를 부른다. `params`는 경로 변수(`taskId` 등)다.
   * `allowRefusal`이면 거부돼도 결과로 남기고 다음 단계로 간다. `when`이 거짓이면 부르지 않고 건너뛴다.
   */
  | {
      do: "call";
      tool: OrgToolName;
      input?: (state: ScriptState) => unknown;
      params?: (state: ScriptState) => Record<string, string>;
      allowRefusal?: boolean;
      when?: (state: ScriptState) => boolean;
    }
  /** 앞 단계의 결과로 이어서 실행할 단계를 정한다. 정한 단계는 바로 다음에 실행한다. */
  | { do: "then"; steps: (state: ScriptState) => ScriptStep[] }
  /** 테스트가 정한 조건까지 멈춘다. 취소되면 reject해야 한다. */
  | { do: "hold"; until: (signal: AbortSignal) => Promise<void> }
  /** 실행기 오류를 흉내 낸다. */
  | { do: "fail"; error: string };

export type Script = {
  steps: ScriptStep[];
  summary?: (state: ScriptState) => string;
};

export type ScriptSelector = (request: RunRequest) => Script | undefined;

const quote = (body: string) =>
  `“${body.length > 80 ? `${body.slice(0, 80)}…` : body}”`;

const decisionLabel = {
  approve: "승인",
  reject: "반려",
  request_changes: "수정 요청",
} as const;

/** 깨우기 사유 한 줄. */
export function describeWakeReason(reason: WakeReason): string {
  switch (reason.kind) {
    case "owner_message":
      return quote(reason.body);
    case "approval_decision":
      return `초기 연구 승인 요청 ${decisionLabel[reason.decision]}${reason.note ? `: ${quote(reason.note)}` : ""}`;
    case "task_assigned":
      return `작업 ${quote(reason.title)}을 맡음`;
    case "task_completed":
      return `작업 ${quote(reason.title)} 완료, 자기 보고: ${quote(reason.summary)}`;
    case "task_comment":
      return `작업 댓글 ${quote(reason.body)}`;
    case "agent_to_agent_message":
      return `에이전트 메시지 ${quote(reason.body)}`;
    case "research_map_edit":
      return `사용자의 연구 지도 편집: ${reason.summary}`;
    case "result_changes_requested":
      return `제출한 결과에 수정 요청: ${quote(reason.note)}`;
  }
}

/** 받은 깨우기 사유를 모두 짚는 답장. */
const replyToWakeReasons = ({ context, request }: ScriptState) => {
  const reasons = context?.wakeReasons ?? request.wakeReasons;
  return [
    `(가짜 실행기) 메시지 ${reasons.length}개를 받았습니다.`,
    ...reasons.map((r) => `- ${describeWakeReason(r)}`),
  ].join("\n");
};

const leadReplySteps = (
  body: (state: ScriptState) => string = replyToWakeReasons
): ScriptStep[] => [
  { do: "read_context" },
  {
    do: "emit",
    activity: { type: "progress", text: "받은 메시지를 읽었습니다." },
  },
  { do: "send_message", body },
];

/** 사용자 메시지에 대한 Lead의 기본 시나리오: 맥락을 읽고 받은 깨우기 사유를 모두 짚어 답장한다. */
export const leadReplyScript: Script = {
  steps: leadReplySteps(),
  summary: ({ sent, request }) =>
    `깨우기 ${request.wakeReasons.length}개에 답장 ${sent.length}개를 보냈습니다.`,
};

/**
 * 데모용 초기 연구 승인 요청. 목표를 그대로 옮긴 계획, 연구원 두 명, 기본 연구 흐름 템플릿.
 * 반려·수정 요청을 받았으면 그 사유를 계획에 적는다.
 */
export function demoProposal(
  goal: string,
  feedback?: string | null
): RequestInitialApprovalInput {
  return {
    plan: [
      `# 초기 연구 계획`,
      ``,
      `목표: ${goal}`,
      ``,
      `1. 연구 문제를 목록화한다.`,
      `2. 문제마다 가설·아이디어와 검증 방법을 세운다.`,
      `3. 연구원 두 명이 실험·검증을 나눠 수행하고 결과를 평가한다.`,
      ...(feedback ? [``, `반영한 사용자 의견: ${feedback}`] : []),
    ].join("\n"),
    environment: [
      `# 연구 환경 명세`,
      ``,
      `- compute: 로컬 CPU`,
      `- 데이터: 사용자가 지정할 공개 데이터셋`,
      `- 사용자 할 일: 없음`,
      `(가짜 실행기가 만든 예시입니다.)`,
    ].join("\n"),
    team: [{ role: "researcher", count: 2 }],
    template: "basic-research",
  };
}

/** 사용자 메시지에서 `목표:`·`완료 기준:` 줄을 읽는다. 둘 다 있을 때만 목표로 기록한다. */
export function parseGoalMessage(
  body: string
): { goal: string; completionCriteria: string } | undefined {
  const line = (label: string) =>
    new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, "m").exec(body)?.[1]?.trim();
  const goal = line("목표");
  const completionCriteria = line("완료 기준");
  return goal && completionCriteria ? { goal, completionCriteria } : undefined;
}

/**
 * 가짜 Lead의 데모 흐름. 실제 판단 없이 단계와 깨우기 사유로 정한다.
 * - 목표 설정: `목표:`·`완료 기준:` 줄이 있는 메시지를 받으면 목표를 기록하고 곧바로 초기 연구 승인을 요청한다.
 * - 계획 수립(반려·수정 요청을 받음): 사유를 반영한 새 요청을 제출한다.
 * - 연구 진행(승인을 받음): 작업자마다 작업을 하나씩 만들어 맡긴다.
 * - 연구 진행(사용자가 `결과 제출`을 부탁하거나 제출한 결과에 수정을 요청함): 완료한 작업의 산출물을 근거로 결과를 제출한다.
 *   가짜 실행기는 완료 기준 충족을 판단하지 않으므로 사용자의 부탁이 제출 시점이다.
 * - 그 밖(하위 작업 완료, 결과 검토 중의 메시지 등): 받은 깨우기 사유에 답장한다.
 */
export function demoLeadScript(request: RunRequest): Script {
  const { stage } = request.context.organization;
  const messages = request.wakeReasons.flatMap((r) =>
    r.kind === "owner_message" ? [r.body] : []
  );
  const goal = messages.map(parseGoalMessage).findLast(Boolean);

  if (stage === "goal_setting" && goal)
    return {
      steps: [
        { do: "read_context" },
        { do: "call", tool: "record_goal", input: () => goal },
        {
          do: "call",
          tool: "request_initial_approval",
          input: () => demoProposal(goal.goal),
        },
        {
          do: "send_message",
          body: () =>
            `(가짜 실행기) 목표와 완료 기준을 기록하고 초기 연구 승인을 요청했습니다. Inbox에서 계획·팀·연구 환경 명세를 검토해 주세요.`,
        },
      ],
      summary: () => "목표를 기록하고 초기 연구 승인을 요청했습니다.",
    };

  const sentBack = request.wakeReasons.findLast(
    (r) => r.kind === "approval_decision" && r.decision !== "approve"
  );
  const recorded = request.context.organization.goal;
  if (
    stage === "planning" &&
    sentBack?.kind === "approval_decision" &&
    recorded
  )
    return {
      steps: [
        { do: "read_context" },
        {
          do: "call",
          tool: "request_initial_approval",
          input: () => demoProposal(recorded, sentBack.note),
        },
        {
          do: "send_message",
          body: () =>
            `(가짜 실행기) ${describeWakeReason(sentBack)}\n사유를 반영해 계획을 다시 제출했습니다.`,
        },
      ],
      summary: () => "사유를 반영해 초기 연구 승인을 다시 요청했습니다.",
    };

  const approved = request.wakeReasons.some(
    (r) => r.kind === "approval_decision" && r.decision === "approve"
  );
  if (stage === "researching" && approved) return assignInitialTasks(request);

  const changes = request.wakeReasons.findLast(
    (r) => r.kind === "result_changes_requested"
  );
  if (
    stage === "researching" &&
    (changes || messages.some((m) => resultRequest.test(m)))
  )
    return submitResultScript(
      request,
      changes?.kind === "result_changes_requested" ? changes.note : null
    );

  if (stage === "goal_setting" && messages.length)
    return {
      ...leadReplyScript,
      steps: leadReplySteps((state) =>
        [
          replyToWakeReasons(state),
          "목표가 정해지면 `목표: …`와 `완료 기준: …` 줄로 보내 주세요. 기록하고 초기 연구 승인을 요청합니다.",
        ].join("\n")
      ),
    };
  return leadReplyScript;
}

/**
 * 승인 직후 가짜 Lead의 첫 분담: 작업자마다 목표를 나눈 작업 하나를 만들어 맡기고 Lead 대화로 알린다.
 * 작업자가 없으면 아무 작업도 만들지 않는다.
 */
function assignInitialTasks(request: RunRequest): Script {
  const workers = request.context.team.filter((a) => a.role === "worker");
  const goal = request.context.organization.goal ?? "연구 목표";
  return {
    steps: [
      { do: "read_context" },
      ...workers.map((worker, i): ScriptStep => ({
        do: "call",
        tool: "create_task",
        input: () => ({
          title: `연구 문제 정리 ${i + 1}`,
          description: `목표 “${goal}”에 필요한 연구 문제를 정리하고 메모를 산출물로 남긴다. (가짜 실행기가 만든 예시 작업입니다.)`,
          assigneeAgentId: worker.id,
        }),
      })),
      {
        do: "send_message",
        body: () =>
          `(가짜 실행기) 초기 연구 승인을 받아 작업 ${workers.length}개를 만들어 ${workers.map((w) => w.name).join(", ")}에게 맡겼습니다. 작업 화면에서 진행을 볼 수 있습니다.`,
      },
    ],
    summary: () => `작업 ${workers.length}개를 만들어 맡겼습니다.`,
  };
}

/** 사용자가 결과 제출을 부탁하는 메시지. */
const resultRequest = /결과(를)?\s*제출/;

/**
 * 가짜 Lead의 결과 제출: 작업 목록에서 완료한 작업을 읽어 그 산출물을 근거로 묶고, 자기 보고를 모은 요약으로 제출한다.
 * 수정 요청을 받았으면 그 의견을 요약에 적는다. 근거 산출물이 없으면 제출하지 않고 Lead 대화로 알린다.
 */
function submitResultScript(
  request: RunRequest,
  feedback: string | null
): Script {
  const goal = request.context.organization.goal ?? "연구 목표";
  const outputs = <T>({ calls }: ScriptState, tool: OrgToolName) =>
    calls.flatMap((c) => (c.tool === tool && c.ok ? [c.output as T] : []));
  return {
    steps: [
      { do: "read_context" },
      { do: "call", tool: "list_tasks" },
      {
        do: "then",
        steps: (state) =>
          outputs<Task[]>(state, "list_tasks")[0]!
            .filter((task) => task.status === "completed")
            .map((task) => ({
              do: "call",
              tool: "get_task",
              params: () => ({ taskId: task.id }),
            })),
      },
      {
        do: "then",
        steps: (state) => {
          const done = outputs<TaskDetail>(state, "get_task");
          const artifactIds = done.flatMap((t) => t.artifacts.map((a) => a.id));
          if (!artifactIds.length)
            return [
              {
                do: "send_message",
                body: () =>
                  "(가짜 실행기) 아직 근거로 묶을 산출물이 없어 결과를 제출하지 않았습니다. 작업이 끝나면 다시 부탁해 주세요.",
              },
            ];
          const summary = [
            `# 결과 요약`,
            ``,
            `목표: ${goal}`,
            ``,
            `완료한 작업 ${done.length}개의 자기 보고:`,
            ...done.map((t) => `- ${t.title}: ${t.report?.summary ?? ""}`),
            ...(feedback ? [``, `반영한 수정 의견: ${feedback}`] : []),
            ``,
            `(가짜 실행기가 만든 예시 요약입니다. 완료 기준 충족을 판단하지 않았습니다.)`,
          ].join("\n");
          return [
            {
              do: "call",
              tool: "submit_result",
              input: () => ({ summary, artifactIds }),
            },
            {
              do: "send_message",
              body: () =>
                `(가짜 실행기) ${feedback ? "수정 의견을 반영해 " : ""}결과를 근거 산출물 ${artifactIds.length}개와 함께 제출했습니다. Inbox에서 검토하고 수정 요청 또는 최종 완료를 결정해 주세요.`,
            },
          ];
        },
      },
    ],
    summary: ({ calls }) =>
      calls.some((c) => c.tool === "submit_result" && c.ok)
        ? "결과를 제출했습니다."
        : "근거 산출물이 없어 결과를 제출하지 않았습니다.",
  };
}

/**
 * 가짜 작업자의 데모 흐름. 깨우기 사유마다 정해진 단계를 실행한다.
 * - 작업을 맡음: 작업을 읽고 착수해 Markdown 산출물을 남기고, 템플릿의 첫 종류로 연구 노드를 만들어 작업을 연결한 뒤
 *   자기 보고와 함께 완료한다. 착수가 거부되면 그 작업은 거기서 멈춘다.
 * - 사용자의 작업 댓글: 그 작업에 댓글로 답한다. 작업 상태는 바꾸지 않는다.
 * - 에이전트 메시지·하위 작업 완료: 읽었다는 활동만 남긴다.
 */
export function demoWorkerScript(request: RunRequest): Script {
  const steps: ScriptStep[] = [{ do: "read_context" }];
  // 조직 사본 템플릿이 선언한 첫 노드 종류(기본 연구 흐름에서는 연구 문제).
  const firstNodeKind = request.context.researchFlow?.nodeKinds[0]?.name;
  for (const reason of request.wakeReasons) {
    if (reason.kind === "task_assigned") {
      const params = () => ({ taskId: reason.taskId });
      // 이 작업으로 만든 연구 노드.
      const recordedNode = ({ calls }: ScriptState) =>
        (
          calls.findLast(
            (c) =>
              c.tool === "create_research_node" &&
              c.ok &&
              (c.output as { title: string }).title === reason.title
          ) as { output: { id: string } } | undefined
        )?.output.id;
      // 착수가 거부되면(Lead가 먼저 완료한 작업 등) 거부만 남기고 이 작업의 산출물·완료는 건너뛴다.
      const started = ({ calls }: ScriptState) =>
        calls.some(
          (c) =>
            c.tool === "start_task" &&
            c.ok &&
            (c.output as { id: string }).id === reason.taskId
        );
      steps.push(
        { do: "call", tool: "get_task", params },
        { do: "call", tool: "start_task", params, allowRefusal: true },
        {
          do: "call",
          tool: "record_artifact",
          when: started,
          input: () => ({
            taskId: reason.taskId,
            title: `${reason.title} 메모`,
            format: "markdown",
            content: [
              `# ${reason.title} 메모`,
              ``,
              `- 정리한 연구 문제 후보를 적는다.`,
              `- 다음 단계로 가설·아이디어를 세운다.`,
              ``,
              `(가짜 실행기가 만든 예시 산출물입니다. 검증된 결과가 아닙니다.)`,
            ].join("\n"),
          }),
        },
        {
          do: "call",
          tool: "create_research_node",
          when: (state) => started(state) && firstNodeKind !== undefined,
          input: () => ({
            kind: firstNodeKind,
            title: reason.title,
            body: `작업 ${quote(reason.title)}에서 정리한 연구 문제 후보. 근거는 이 작업의 산출물에 있습니다. (가짜 실행기가 만든 예시입니다.)`,
          }),
        },
        {
          do: "call",
          tool: "link_task_research_node",
          when: (state) => recordedNode(state) !== undefined,
          params,
          input: (state) => ({ researchNodeId: recordedNode(state) }),
        },
        {
          do: "call",
          tool: "complete_task",
          params,
          input: () => ({
            summary: `(가짜 실행기) ${quote(reason.title)}을 정리해 메모를 산출물로 남겼습니다.`,
          }),
          when: started,
          // 착수 뒤 Lead가 조정으로 먼저 완료했으면 거부를 남긴다.
          allowRefusal: true,
        }
      );
    } else if (reason.kind === "task_comment")
      steps.push({
        do: "call",
        tool: "comment_task",
        params: () => ({ taskId: reason.taskId }),
        input: () => ({
          body: `(가짜 실행기) 댓글을 받았습니다: ${quote(reason.body)} 다음 작업에 반영하겠습니다.`,
        }),
      });
    else
      steps.push({
        do: "emit",
        activity: {
          type: "progress",
          text: `받은 사유를 읽었습니다: ${describeWakeReason(reason)}`,
        },
      });
  }
  return {
    steps,
    summary: ({ calls }) =>
      `깨우기 ${request.wakeReasons.length}개를 처리하며 조직 도구를 ${calls.length}번 불렀습니다.`,
  };
}

/** 기본 선택: Lead와 작업자의 데모 흐름. */
export const defaultScriptSelector: ScriptSelector = (request) =>
  request.context.agent.role === "lead"
    ? demoLeadScript(request)
    : demoWorkerScript(request);

export function createScriptedRuntime({
  select = defaultScriptSelector,
  fetch,
}: {
  select?: ScriptSelector;
  fetch?: typeof globalThis.fetch;
} = {}): RuntimeAdapter {
  return {
    async execute(request, { signal, emit }) {
      const turns = Number(request.previousSession?.turns ?? 0);
      const end = (
        stopReason: RunResult["stopReason"],
        fields: Partial<RunResult> = {}
      ): RunResult => ({
        stopReason,
        error: null,
        summary: null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        nextSession: { turns: turns + 1 },
        ...fields,
      });

      const script = select(request);
      if (!script)
        return end("failed", {
          error: `가짜 실행기에 ${request.context.agent.role}·${request.wakeReasons.map((r) => r.kind).join(",")} 시나리오가 없습니다.`,
        });
      const tools = createOrgToolClient({
        baseUrl: request.access.toolsBaseUrl,
        token: request.access.token,
        signal,
        fetch,
      });
      const state: ScriptState = {
        request,
        context: undefined,
        sent: [],
        calls: [],
      };
      try {
        const queue = [...script.steps];
        for (let step = queue.shift(); step; step = queue.shift()) {
          signal.throwIfAborted();
          switch (step.do) {
            case "read_context":
              state.context = await tools.getRunContext();
              break;
            case "emit":
              await emit(step.activity);
              break;
            case "send_message":
              state.sent.push(await tools.sendMessage(step.body(state)));
              break;
            case "read_message":
              await tools.getMessage(step.messageId(state));
              break;
            case "call":
              if (step.when && !step.when(state)) break;
              try {
                const output = await tools.call(
                  step.tool,
                  step.input?.(state),
                  step.params?.(state)
                );
                state.calls.push({ tool: step.tool, ok: true, output });
              } catch (error) {
                if (!(error instanceof OrgToolError) || !step.allowRefusal)
                  throw error;
                state.calls.push({
                  tool: step.tool,
                  ok: false,
                  status: error.status,
                  code: error.code,
                });
              }
              break;
            case "then":
              queue.unshift(...step.steps(state));
              break;
            case "hold":
              await step.until(signal);
              break;
            case "fail":
              return end("failed", { error: step.error });
          }
        }
        signal.throwIfAborted();
        return end("completed", { summary: script.summary?.(state) ?? null });
      } catch (error) {
        // 취소 중 생긴 오류는 실패가 아니라 취소다(ACP prompt-turn Cancellation과 같은 규칙).
        if (signal.aborted) return end("cancelled");
        return end("failed", {
          error: error instanceof Error ? error.message : "가짜 실행기 오류",
        });
      }
    },
  };
}
