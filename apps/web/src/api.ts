import {
  agentDetailSchema,
  agentInstructionsSchema,
  approvalSchema,
  approvalSummaryListSchema,
  conversationMessageListSchema,
  conversationMessageSchema,
  eventListSchema,
  flowTemplateCopySchema,
  inboxSchema,
  organizationDetailSchema,
  organizationListSchema,
  runDetailSchema,
  runSummaryListSchema,
  type CreateOrganizationInput,
  type DecideApprovalInput,
  type Organization,
  type OrganizationDetail,
} from "@babojubot/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";

/** 조직 범위 조회는 모두 그 조직 key 아래에 두어, 조직 Event가 오면 한꺼번에 다시 불러온다. */
export const queryKeys = {
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
  conversation: (id: string) => ["organizations", id, "messages"] as const,
  events: (id: string, agentId?: string) =>
    ["organizations", id, "events", agentId ?? "all"] as const,
  runs: (id: string) => ["organizations", id, "runs"] as const,
  run: (id: string, runId: string) =>
    ["organizations", id, "runs", runId] as const,
  agent: (id: string, agentId: string) =>
    ["organizations", id, "agents", agentId] as const,
  instructions: (id: string, agentId: string) =>
    ["organizations", id, "agents", agentId, "instructions"] as const,
  flowTemplate: (id: string) => ["organizations", id, "flow-template"] as const,
  approvals: (id: string) => ["organizations", id, "approvals"] as const,
  approval: (id: string, approvalId: string) =>
    ["organizations", id, "approvals", approvalId] as const,
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

/** Lead 대화에 사용자 메시지를 보낸다. 실패하면 입력을 지우지 않도록 호출한 쪽이 결과를 본다. */
export function useSendMessage(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      request(conversationMessageSchema, orgPath(orgId, "/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, delivery: "next_run" }),
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
