import {
  agentDetailSchema,
  conversationMessageListSchema,
  conversationMessageSchema,
  eventListSchema,
  organizationDetailSchema,
  organizationListSchema,
  runDetailSchema,
  runSummaryListSchema,
  type CreateOrganizationInput,
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
};

const orgPath = (id: string, rest = "") =>
  `/api/organizations/${encodeURIComponent(id)}${rest}`;
const notFoundIsFinal = (count: number, error: Error) =>
  !(error instanceof ApiError && error.status === 404) && count < 3;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`API ${status}`);
    this.status = status;
  }
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit
): Promise<z.infer<T>> {
  const res = await fetch(path, init);
  if (!res.ok) throw new ApiError(res.status);
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
