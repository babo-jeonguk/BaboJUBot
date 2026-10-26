import {
  agentDetailSchema,
  agentInstructionsSchema,
  approvalSchema,
  approvalSummaryListSchema,
  artifactSchema,
  conversationMessageListSchema,
  conversationMessageSchema,
  eventListSchema,
  flowTemplateCopySchema,
  inboxItemStateSchema,
  inboxSchema,
  instructionCopySchema,
  instructionRevisionSchema,
  instructionRevisionSummarySchema,
  organizationDetailSchema,
  organizationListSchema,
  organizationSchema,
  researchLinkSchema,
  researchMapSchema,
  researchNodeDetailSchema,
  researchNodeSchema,
  resultSubmissionSchema,
  resultSubmissionSummaryListSchema,
  runDetailSchema,
  runSummaryListSchema,
  taskCommentSchema,
  taskDetailSchema,
  taskListSchema,
  type AddResearchLinkInput,
  type AgentCommand,
  type CreateOrganizationInput,
  type CreateResearchNodeInput,
  type DecideApprovalInput,
  type DecideResultInput,
  type EditInstructionCopyInput,
  type InboxItemKind,
  type MessageDelivery,
  type Organization,
  type OrganizationCommand,
  type OrganizationDetail,
  type UpdateApprovalPolicyInput,
  type UpdateHeartbeatInput,
  type UpdateInboxItemInput,
  type UpdateResearchNodeInput,
} from "@babojubot/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

/** 조직 범위 조회는 모두 그 조직 key 아래에 두어, 조직 Event가 오면 한꺼번에 다시 불러온다. */
export const queryKeys = {
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
  conversation: (id: string) => ["organizations", id, "messages"] as const,
  events: (id: string, agentId?: string) =>
    ["organizations", id, "events", agentId ?? "all"] as const,
  runs: (id: string) => ["organizations", id, "runs"] as const,
  runningRuns: (id: string) =>
    ["organizations", id, "runs", { status: "running" }] as const,
  run: (id: string, runId: string) =>
    ["organizations", id, "runs", runId] as const,
  agent: (id: string, agentId: string) =>
    ["organizations", id, "agents", agentId] as const,
  instructions: (id: string, agentId: string) =>
    ["organizations", id, "agents", agentId, "instructions"] as const,
  instructionRevisions: (id: string, agentId: string, copyId: string) =>
    [
      "organizations",
      id,
      "agents",
      agentId,
      "instructions",
      copyId,
      "revisions",
    ] as const,
  instructionRevision: (
    id: string,
    agentId: string,
    copyId: string,
    number: number
  ) =>
    [...queryKeys.instructionRevisions(id, agentId, copyId), number] as const,
  flowTemplate: (id: string) => ["organizations", id, "flow-template"] as const,
  approvals: (id: string) => ["organizations", id, "approvals"] as const,
  approval: (id: string, approvalId: string) =>
    ["organizations", id, "approvals", approvalId] as const,
  results: (id: string) => ["organizations", id, "results"] as const,
  result: (id: string, submissionId: string) =>
    ["organizations", id, "results", submissionId] as const,
  tasks: (id: string) => ["organizations", id, "tasks"] as const,
  task: (id: string, taskId: string) =>
    ["organizations", id, "tasks", taskId] as const,
  artifact: (id: string, artifactId: string) =>
    ["organizations", id, "artifacts", artifactId] as const,
  researchMap: (id: string) => ["organizations", id, "research-map"] as const,
  researchNode: (id: string, nodeId: string) =>
    ["organizations", id, "research-nodes", nodeId] as const,
  /** 조직을 가로지르는 대기열. 어느 조직의 Event든 다시 불러온다. */
  inbox: ["inbox"] as const,
};

const orgPath = (id: string, rest = "") =>
  `/api/organizations/${encodeURIComponent(id)}${rest}`;
const notFoundIsFinal = (count: number, error: Error) =>
  !(error instanceof ApiError && error.status === 404) && count < 3;

export class ApiError extends Error {
  readonly status: number;
  /** 서버가 돌려준 오류 코드(`already_decided` 등). */
  readonly code: string | undefined;
  constructor(status: number, code?: string) {
    super(`API ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit
): Promise<z.infer<T>> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      { error?: { code?: string } } | undefined;
    throw new ApiError(res.status, body?.error?.code);
  }
  return schema.parse(await res.json());
}

export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.organizations,
    queryFn: () => request(organizationListSchema, "/api/organizations"),
  });
}

export function useOrganization(id: string) {
  return useQuery({
    queryKey: queryKeys.organization(id),
    queryFn: () =>
      request(
        organizationDetailSchema,
        `/api/organizations/${encodeURIComponent(id)}`
      ),
    retry: notFoundIsFinal,
  });
}

/** 성공 응답으로 캐시를 바로 채운다. 같은 생성의 Event가 먼저 와도 목록에 두 번 들어가지 않는다. */
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      request(organizationDetailSchema, "/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (org: OrganizationDetail) => {
      queryClient.setQueryData(queryKeys.organization(org.id), org);
      const { agents: _agents, ...summary } = org;
      queryClient.setQueryData<Organization[]>(
        queryKeys.organizations,
        (list) =>
          list && !list.some((o) => o.id === org.id) ? [...list, summary] : list
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organizations,
        exact: true,
      });
    },
  });
}

export function useConversation(orgId: string) {
  return useQuery({
    queryKey: queryKeys.conversation(orgId),
    queryFn: () =>
      request(conversationMessageListSchema, orgPath(orgId, "/messages")),
  });
}

/**
 * Lead 대화에 사용자 메시지를 보낸다. 실패하면 입력과 전달 방식을 지우지 않도록 호출한 쪽이 결과를 본다.
 * `중단하고 반영`은 메시지와 실행 시도 중단 제어 명령을 한 요청으로 보낸다(서버가 함께 저장).
 */
export function useSendMessage(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      delivery,
    }: {
      body: string;
      delivery: MessageDelivery;
    }) =>
      request(conversationMessageSchema, orgPath(orgId, "/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, delivery }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(orgId),
      }),
  });
}

export function useEvents(orgId: string, agentId?: string) {
  return useQuery({
    queryKey: queryKeys.events(orgId, agentId),
    queryFn: () =>
      request(
        eventListSchema,
        orgPath(
          orgId,
          agentId ? `/events?agentId=${encodeURIComponent(agentId)}` : "/events"
        )
      ),
  });
}

export function useRuns(orgId: string) {
  return useQuery({
    queryKey: queryKeys.runs(orgId),
    queryFn: () => request(runSummaryListSchema, orgPath(orgId, "/runs")),
  });
}

/** 진행 중 실행 시도 전부(취소 정리 중 포함). 최근 목록과 달리 개수를 자르지 않는다. */
export function useRunningRuns(orgId: string) {
  return useQuery({
    queryKey: queryKeys.runningRuns(orgId),
    queryFn: () =>
      request(runSummaryListSchema, orgPath(orgId, "/runs?status=running")),
  });
}

export function useRun(orgId: string, runId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.run(orgId, runId ?? ""),
    queryFn: () =>
      request(
        runDetailSchema,
        orgPath(orgId, `/runs/${encodeURIComponent(runId!)}`)
      ),
    enabled: runId !== undefined,
    retry: notFoundIsFinal,
  });
}

export function useAgent(orgId: string, agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agent(orgId, agentId ?? ""),
    queryFn: () =>
      request(
        agentDetailSchema,
        orgPath(orgId, `/agents/${encodeURIComponent(agentId!)}`)
      ),
    enabled: agentId !== undefined,
    retry: notFoundIsFinal,
  });
}

export function useAgentInstructions(orgId: string, agentId: string) {
  return useQuery({
    queryKey: queryKeys.instructions(orgId, agentId),
    queryFn: () =>
      request(
        agentInstructionsSchema,
        orgPath(orgId, `/agents/${encodeURIComponent(agentId)}/instructions`)
      ),
    retry: notFoundIsFinal,
  });
}

const copyPath = (orgId: string, agentId: string, copyId: string, rest = "") =>
  orgPath(
    orgId,
    `/agents/${encodeURIComponent(agentId)}/instructions/${encodeURIComponent(copyId)}${rest}`
  );

/** 사본의 revision 목록(최근 것부터). 사본이 저장되면 조직 Event로 다시 불러온다. */
export function useInstructionRevisions(
  orgId: string,
  agentId: string,
  copyId: string
) {
  return useQuery({
    queryKey: queryKeys.instructionRevisions(orgId, agentId, copyId),
    queryFn: () =>
      request(
        z.array(instructionRevisionSummarySchema),
        copyPath(orgId, agentId, copyId, "/revisions")
      ),
    retry: notFoundIsFinal,
  });
}

/** 사본 revision 하나의 전체 본문. revision은 바뀌지 않으므로 다시 불러오지 않는다. */
export function useInstructionRevision(
  orgId: string,
  agentId: string,
  copyId: string,
  number: number | undefined
) {
  return useQuery({
    queryKey: queryKeys.instructionRevision(
      orgId,
      agentId,
      copyId,
      number ?? 0
    ),
    queryFn: () =>
      request(
        instructionRevisionSchema,
        copyPath(orgId, agentId, copyId, `/revisions/${number}`)
      ),
    enabled: number !== undefined,
    staleTime: Infinity,
    retry: notFoundIsFinal,
  });
}

/**
 * 사본 편집 저장. 서버가 저장한 뒤에만 사본·revision 목록·에이전트 상세(bundle 버전)를 다시 불러온다.
 * 다른 곳에서 먼저 저장해 충돌하면 사본을 다시 불러와 지금 revision을 보인다. 거부·실패해도 편집 중인 본문은 호출한 쪽이 지우지 않는다.
 */
export function useEditInstructionCopy(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      copyId,
      ...input
    }: EditInstructionCopyInput & { copyId: string }) =>
      request(
        instructionCopySchema,
        copyPath(orgId, agentId, copyId),
        json("PUT", input)
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.instructions(orgId, agentId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agent(orgId, agentId),
          exact: true,
        }),
      ]),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "revision_conflict")
        void queryClient.invalidateQueries({
          queryKey: queryKeys.instructions(orgId, agentId),
        });
    },
  });
}

/** 조직의 연구 흐름 템플릿 사본. 초기 연구 승인 전에는 없다(`null`). */
export function useFlowTemplate(orgId: string) {
  return useQuery({
    queryKey: queryKeys.flowTemplate(orgId),
    queryFn: async () => {
      try {
        return await request(
          flowTemplateCopySchema,
          orgPath(orgId, "/flow-template")
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/**
 * 승인 정책 변경 제어 명령. 서버가 저장한 정책으로만 화면을 바꾸고(낙관 반영 없음), 그 조직을 다시 불러온다.
 * 다른 탭은 정책 변경 Event로 같은 조직을 다시 불러온다.
 */
export function useUpdateApprovalPolicy(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateApprovalPolicyInput) =>
      request(organizationSchema, orgPath(orgId, "/approval-policy"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: (org) => {
      queryClient.setQueryData<OrganizationDetail>(
        queryKeys.organization(orgId),
        (detail) => detail && { ...detail, ...org }
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organization(orgId),
        exact: true,
      });
    },
  });
}

/**
 * 조직 일시정지·재개·중단 제어 명령. 서버가 확정한 조직으로만 화면을 바꾸고(낙관 반영 없음) 그 조직 범위를 다시 불러온다.
 * 다른 탭은 제어 명령 Event로 같은 조직을 다시 불러온다.
 */
export function useControlOrganization(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: OrganizationCommand) =>
      request(organizationSchema, orgPath(orgId, `/${command}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    onSuccess: (org) => {
      queryClient.setQueryData<OrganizationDetail>(
        queryKeys.organization(orgId),
        (detail) => detail && { ...detail, ...org }
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organization(orgId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organizations,
        exact: true,
      });
    },
  });
}

/** 에이전트 일시정지·재개 제어 명령. 응답의 에이전트 상세로 바꾸고 그 조직 범위를 다시 불러온다. */
export function useControlAgent(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: AgentCommand) =>
      request(
        agentDetailSchema,
        orgPath(orgId, `/agents/${encodeURIComponent(agentId)}/${command}`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }
      ),
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agent(orgId, agentId), agent);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organization(orgId),
      });
    },
  });
}

/**
 * 에이전트 heartbeat 설정 변경. 서버가 확정한 에이전트 상세(다음 heartbeat 포함)로만 화면을 바꾼다.
 * 다른 탭은 `agent.heartbeat_changed` Event로 같은 에이전트를 다시 불러온다.
 */
export function useUpdateHeartbeat(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateHeartbeatInput) =>
      request(
        agentDetailSchema,
        orgPath(orgId, `/agents/${encodeURIComponent(agentId)}/heartbeat`),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      ),
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agent(orgId, agentId), agent);
    },
  });
}

export function useApprovals(orgId: string) {
  return useQuery({
    queryKey: queryKeys.approvals(orgId),
    queryFn: () =>
      request(approvalSummaryListSchema, orgPath(orgId, "/approvals")),
  });
}

export function useApproval(orgId: string, approvalId: string) {
  return useQuery({
    queryKey: queryKeys.approval(orgId, approvalId),
    queryFn: () =>
      request(
        approvalSchema,
        orgPath(orgId, `/approvals/${encodeURIComponent(approvalId)}`)
      ),
    retry: notFoundIsFinal,
  });
}

export function useInbox() {
  return useQuery({
    queryKey: queryKeys.inbox,
    queryFn: () => request(inboxSchema, "/api/inbox"),
  });
}

/**
 * 알림 정리 명령(읽음·보관). 결과를 미리 반영하지 않고, 끝나면 성공·실패와 상관없이 Inbox를 다시 불러와 서버 상태를 보인다.
 * 원본의 결정은 바꾸지 않으므로 다른 조회는 다시 부르지 않는다.
 */
/**
 * 체크한 항목을 한꺼번에 읽음으로. 항목마다 같은 정리 명령을 보낸다(부르는 쪽은 이미 읽은 항목을 넘기지 않는다).
 */
export type InboxItemRef = {
  organizationId: string;
  kind: InboxItemKind;
  sourceId: string;
};
export function useMarkInboxItemsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: InboxItemRef[]) =>
      Promise.all(
        items.map((item) =>
          request(
            inboxItemStateSchema,
            orgPath(
              item.organizationId,
              `/inbox/${item.kind}/${encodeURIComponent(item.sourceId)}`
            ),
            json("PUT", { read: true })
          )
        )
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
  });
}

export function useUpdateInboxItem(item: {
  organizationId: string;
  kind: InboxItemKind;
  sourceId: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInboxItemInput) =>
      request(
        inboxItemStateSchema,
        orgPath(
          item.organizationId,
          `/inbox/${item.kind}/${encodeURIComponent(item.sourceId)}`
        ),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
  });
}

/**
 * 승인 결정 제어 명령. 성공하거나 이미 결정됐다는 응답을 받으면 그 조직과 Inbox를 다시 불러와 서버의 결과를 보인다.
 * 결과를 미리 화면에 반영하지 않는다.
 */
export function useDecideApproval(orgId: string, approvalId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.organization(orgId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
  };
  return useMutation({
    mutationFn: (input: DecideApprovalInput) =>
      request(
        approvalSchema,
        orgPath(orgId, `/approvals/${encodeURIComponent(approvalId)}/decision`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      ),
    onSuccess: (approval) => {
      queryClient.setQueryData(queryKeys.approval(orgId, approvalId), approval);
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "already_decided")
        refresh();
    },
  });
}

export function useResultSubmissions(orgId: string) {
  return useQuery({
    queryKey: queryKeys.results(orgId),
    queryFn: () =>
      request(resultSubmissionSummaryListSchema, orgPath(orgId, "/results")),
  });
}

export function useResultSubmission(orgId: string, submissionId: string) {
  return useQuery({
    queryKey: queryKeys.result(orgId, submissionId),
    queryFn: () =>
      request(
        resultSubmissionSchema,
        orgPath(orgId, `/results/${encodeURIComponent(submissionId)}`)
      ),
    retry: notFoundIsFinal,
  });
}

/**
 * 결과 검토 제어 명령(수정 요청·최종 완료). 성공하거나 이미 결정됐다는 응답을 받으면 그 조직과 Inbox를 다시 불러와
 * 서버의 결과를 보인다. 결과를 미리 화면에 반영하지 않는다.
 */
export function useDecideResult(orgId: string, submissionId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.organization(orgId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
  };
  return useMutation({
    mutationFn: (input: DecideResultInput) =>
      request(
        resultSubmissionSchema,
        orgPath(orgId, `/results/${encodeURIComponent(submissionId)}/decision`),
        json("POST", input)
      ),
    onSuccess: (submission) => {
      queryClient.setQueryData(
        queryKeys.result(orgId, submissionId),
        submission
      );
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "already_decided")
        refresh();
    },
  });
}

export function useTasks(orgId: string) {
  return useQuery({
    queryKey: queryKeys.tasks(orgId),
    queryFn: () => request(taskListSchema, orgPath(orgId, "/tasks")),
  });
}

export function useTask(orgId: string, taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.task(orgId, taskId ?? ""),
    queryFn: () =>
      request(
        taskDetailSchema,
        orgPath(orgId, `/tasks/${encodeURIComponent(taskId!)}`)
      ),
    enabled: taskId !== undefined,
    retry: notFoundIsFinal,
  });
}

export function useArtifact(orgId: string, artifactId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.artifact(orgId, artifactId ?? ""),
    queryFn: () =>
      request(
        artifactSchema,
        orgPath(orgId, `/artifacts/${encodeURIComponent(artifactId!)}`)
      ),
    enabled: artifactId !== undefined,
    retry: notFoundIsFinal,
  });
}

/**
 * 작업 댓글을 단다. 담당자를 깨우며, 담당자가 실행 중이면 다음 실행 시도에 반영된다.
 * 서버가 저장한 뒤에만 thread를 다시 불러오고, 실패하면 입력을 지우지 않도록 호출한 쪽이 결과를 본다.
 */
export function useAddTaskComment(orgId: string, taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      request(
        taskCommentSchema,
        orgPath(orgId, `/tasks/${encodeURIComponent(taskId)}/comments`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        }
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.task(orgId, taskId),
      }),
  });
}

export function useResearchMap(orgId: string) {
  return useQuery({
    queryKey: queryKeys.researchMap(orgId),
    queryFn: () => request(researchMapSchema, orgPath(orgId, "/research-map")),
  });
}

/** 노드 상세(연결 작업·산출물·편집 기록). 선택한 노드 ID로 최신 기록을 읽는다. */
export function useResearchNode(orgId: string, nodeId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.researchNode(orgId, nodeId ?? ""),
    queryFn: () =>
      request(
        researchNodeDetailSchema,
        orgPath(orgId, `/research-nodes/${encodeURIComponent(nodeId!)}`)
      ),
    enabled: nodeId !== undefined,
    retry: notFoundIsFinal,
  });
}

/** 사용자의 연구 지도 편집 하나. 서버가 편집자를 기록하고 Lead를 깨운다. */
export type MapEdit =
  | { op: "create_node"; input: CreateResearchNodeInput }
  | { op: "update_node"; nodeId: string; input: UpdateResearchNodeInput }
  | { op: "change_parent"; nodeId: string; parentNodeId: string | null }
  | { op: "add_link"; input: AddResearchLinkInput }
  | { op: "discard_node" | "restore_node"; nodeId: string };

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * 연구 지도 편집. 서버가 저장한 뒤에만 지도와 노드 상세를 다시 불러오며 결과를 미리 화면에 반영하지 않는다.
 * 거부·실패하면 지도는 서버 기록 그대로이고, 폼 입력은 호출한 쪽이 지우지 않는다.
 */
export function useEditResearchMap(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: MapEdit): Promise<{ id: string }> => {
      const node = (id: string, rest = "") =>
        orgPath(orgId, `/research-nodes/${encodeURIComponent(id)}${rest}`);
      switch (edit.op) {
        case "create_node":
          return request(
            researchNodeSchema,
            orgPath(orgId, "/research-nodes"),
            json("POST", edit.input)
          );
        case "update_node":
          return request(
            researchNodeSchema,
            node(edit.nodeId),
            json("PATCH", edit.input)
          );
        case "change_parent":
          return request(
            researchNodeSchema,
            node(edit.nodeId, "/parent"),
            json("POST", { parentNodeId: edit.parentNodeId })
          );
        case "add_link":
          return request(
            researchLinkSchema,
            orgPath(orgId, "/research-links"),
            json("POST", edit.input)
          );
        case "discard_node":
        case "restore_node":
          return request(
            researchNodeSchema,
            node(
              edit.nodeId,
              edit.op === "discard_node" ? "/discard" : "/restore"
            ),
            json("POST", {})
          );
      }
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.researchMap(orgId),
        }),
        queryClient.invalidateQueries({
          queryKey: ["organizations", orgId, "research-nodes"],
        }),
      ]),
  });
}
