import {
  agentDetailSchema,
  agentInstructionsSchema,
  approvalSchema,
  approvalSummaryListSchema,
  artifactSchema,
  conversationMessageListSchema,
  conversationMessageSchema,
  conversationPageSchema,
  conversationPageSize,
  conversationSummaryListSchema,
  eventListSchema,
  flowTemplateCopySchema,
  inboxItemStateSchema,
  inboxSchema,
  instructionCopySchema,
  instructionRevisionSchema,
  instructionRevisionSummarySchema,
  organizationDetailSchema,
  organizationDashboardSchema,
  organizationListSchema,
  organizationSchema,
  overviewSchema,
  researchLinkSchema,
  researchMapSchema,
  researchNodeDetailSchema,
  researchNodeSchema,
  resultSubmissionSchema,
  resultSubmissionSummaryListSchema,
  runDetailSchema,
  startConversationResultSchema,
  runSummaryListSchema,
  taskCommentSchema,
  taskDetailSchema,
  taskListSchema,
  type AddResearchLinkInput,
  type AgentCommand,
  type ConversationPage,
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
  type UpdateAgentProfileInput,
  type UpdateApprovalPolicyInput,
  type UpdateHeartbeatInput,
  type UpdateInboxItemInput,
  type UpdateResearchNodeInput,
} from "@babojubot/contracts";
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

/** 조직 범위 조회는 모두 그 조직 key 아래에 두어, 조직 Event가 오면 한꺼번에 다시 불러온다. */
export const queryKeys = {
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
  conversations: (id: string) =>
    ["organizations", id, "conversations"] as const,
  /** 대화 하나의 기록(쪽 단위). 대화 ID가 없으면 기본 대화다. */
  conversation: (id: string, conversationId?: string) =>
    [
      "organizations",
      id,
      "conversations",
      conversationId ?? "default",
      "messages",
    ] as const,
  /** 대화 하나의 줄 세운 메시지. */
  queuedMessages: (id: string, conversationId?: string) =>
    [
      "organizations",
      id,
      "conversations",
      conversationId ?? "default",
      "queued",
    ] as const,
  events: (id: string, agentId?: string) =>
    ["organizations", id, "events", agentId ?? "all"] as const,
  dashboard: (id: string, timeZone: string) =>
    ["organizations", id, "dashboard", timeZone] as const,
  runs: (id: string) => ["organizations", id, "runs"] as const,
  runningRuns: (id: string) =>
    ["organizations", id, "runs", { status: "running" }] as const,
  run: (id: string, runId: string) =>
    ["organizations", id, "runs", runId] as const,
  agents: (id: string) => ["organizations", id, "agents"] as const,
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
  /** 홈 개요(모든 조직의 진행 중 실행 시도 수). 어느 조직의 Event든 다시 불러온다. */
  overview: ["overview"] as const,
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

/** 조직의 대화 목록. 기본 대화가 맨 위, 나머지는 마지막 활동이 최근인 것부터다. */
export function useConversations(orgId: string) {
  return useQuery({
    queryKey: queryKeys.conversations(orgId),
    queryFn: () =>
      request(conversationSummaryListSchema, orgPath(orgId, "/conversations")),
  });
}

/** 대화의 경로. 대화가 없으면 기본 대화다. */
const chatPath = (orgId: string, conversationId?: string) =>
  orgPath(
    orgId,
    conversationId ? `/conversations/${encodeURIComponent(conversationId)}` : ""
  );
const messagesPath = (orgId: string, conversationId?: string) =>
  `${chatPath(orgId, conversationId)}/messages`;
const pagePath = (
  orgId: string,
  conversationId: string | undefined,
  cursor?: { before?: string; after?: string }
) => {
  const query = new URLSearchParams(cursor);
  return `${messagesPath(orgId, conversationId)}${query.size ? `?${query}` : ""}`;
};

/**
 * 불러온 대화 기록. 첫 쪽이 가장 최근 것이고 뒤로 갈수록 오래된 쪽이다. 쪽 안은 오래된 것부터다.
 * 쪽마다 `hasMore`는 그보다 오래된 메시지가 있는가, `before`는 그것을 받을 커서다(마지막 쪽의 것으로 더 오래된 쪽을 받는다).
 */
export type TranscriptData = InfiniteData<ConversationPage, string | null>;

/** 맨 아래를 따라가는 동안 불러 둔 대화 기록이 이보다 많으면 오래된 쪽을 덜어 낸다(`trimTranscript`). */
export const transcriptWindowMax = 100;

/**
 * 대화 기록. 대화 ID가 없으면 기본 대화다. 처음에는 가장 최근 쪽만 받고 `fetchNextPage`가 더 오래된 쪽을 받는다.
 * 새 메시지는 Event가 올 때 `catchUpConversation`이 가장 새 메시지 뒤의 것만 받아 붙이므로(불러온 쪽 전체를 다시 받지 않는다)
 * 창 focus·재연결의 다시 불러오기를 끄고 오래됨으로 보지 않는다. 줄 세운 메시지는 `useQueuedMessages`가 따로 받는다.
 */
export function useConversation(orgId: string, conversationId?: string) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: queryKeys.conversation(orgId, conversationId),
    queryFn: ({ pageParam }) =>
      request(
        conversationPageSchema,
        pagePath(orgId, conversationId, pageParam ? { before: pageParam } : {})
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.before : undefined),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: notFoundIsFinal,
    meta: {
      liveRefresh: () =>
        catchUpConversation(queryClient, orgId, conversationId),
    },
  });
}

/**
 * 불러온 대화 기록에 그 뒤에 온 메시지만 이어 붙인다(`?after=` 커서, 남으면 이어서). 아직 첫 쪽을 받지 않았으면 아무것도 하지 않고,
 * 비어 있던 대화면 가장 최근 쪽을 새로 받는다. 서버의 새 메시지는 늘 받은 순서의 맨 뒤에 놓이므로 붙이기만 하면 된다.
 * 응답을 기다리는 사이 다른 이어 받기가 가장 새 쪽을 바꿨으면 그 응답은 붙일 자리가 지났으므로 버리고, 지금 가장 새 메시지
 * 뒤부터 다시 받는다(늦게 온 응답이 순서를 뒤집거나 그보다 새 메시지를 버리지 않도록).
 */
export async function catchUpConversation(
  queryClient: QueryClient,
  orgId: string,
  conversationId?: string
) {
  const key = queryKeys.conversation(orgId, conversationId);
  const newestCursor = (data: TranscriptData) => data.pages[0]?.after ?? null;
  for (;;) {
    const data = queryClient.getQueryData<TranscriptData>(key);
    if (!data) return;
    const base = newestCursor(data);
    const update = await (base === null
      ? fetchFirstPage(orgId, conversationId)
      : fetchArrivals(orgId, conversationId, base));
    let applied = false;
    queryClient.setQueryData<TranscriptData>(key, (old) => {
      if (!old || newestCursor(old) !== base) return old;
      applied = true;
      return update(old);
    });
    if (applied) return;
  }
}

/** 비어 있던 대화의 가장 최근 쪽을 받아 대화 기록을 그것으로 바꾸는 갱신. */
async function fetchFirstPage(orgId: string, conversationId?: string) {
  const fresh = await request(
    conversationPageSchema,
    pagePath(orgId, conversationId)
  );
  return (): TranscriptData => ({ pages: [fresh], pageParams: [null] });
}

/** `after` 커서 뒤에 온 쪽을 끝까지 받아 대화 기록에 붙이는 갱신(`appendArrivals`). */
async function fetchArrivals(
  orgId: string,
  conversationId: string | undefined,
  after: string
) {
  let cursor = after;
  const arrived: ConversationPage[] = [];
  for (;;) {
    const page: ConversationPage = await request(
      conversationPageSchema,
      pagePath(orgId, conversationId, { after: cursor })
    );
    arrived.push(page);
    cursor = page.after ?? cursor;
    if (!page.hasMore) break;
  }
  return (old: TranscriptData) => appendArrivals(old, arrived);
}

/**
 * 새로 받은 쪽(`?after=` 응답, 오래된 것부터)을 대화 기록 앞(가장 새 쪽)에 붙인다. 받은 쪽마다 따로 두어 그 쪽의 `before` 커서를
 * 남기므로 나중에 오래된 쪽을 덜어 내도(`trimTranscript`) 다시 받을 수 있다. 이미 불러 둔 같은 메시지는 예전 쪽에서 뺀다.
 */
export function appendArrivals(
  data: TranscriptData,
  arrived: readonly ConversationPage[]
): TranscriptData {
  const fresh = arrived.filter((p) => p.messages.length);
  if (!fresh.length) return data;
  const ids = new Set(fresh.flatMap((p) => p.messages.map((m) => m.id)));
  const pages = fresh
    .map((p) => ({ ...p, hasMore: p.before !== null }))
    .reverse();
  return {
    pages: [
      ...pages,
      ...data.pages.map((p) =>
        p.messages.some((m) => ids.has(m.id))
          ? { ...p, messages: p.messages.filter((m) => !ids.has(m.id)) }
          : p
      ),
    ],
    pageParams: [...pages.map(() => null), ...data.pageParams],
  };
}

/**
 * 맨 아래를 따라가는 동안 불러 둔 대화 기록이 `max`개를 넘으면 가장 최근 `keep`개 이상이 남을 때까지 오래된 쪽을 통째로 덜어 낸다.
 * 남은 마지막 쪽의 `before` 커서로 위로 올리면 덜어 낸 쪽을 다시 받는다. 커서가 없는 쪽에서는 멈춘다.
 */
export function trimTranscript(
  data: TranscriptData,
  { max = transcriptWindowMax, keep = conversationPageSize } = {}
): TranscriptData {
  let total = data.pages.reduce((n, p) => n + p.messages.length, 0);
  if (total <= max) return data;
  let end = data.pages.length;
  while (end > 1) {
    const dropped = data.pages[end - 1]!.messages.length;
    if (total - dropped < keep || data.pages[end - 2]!.before === null) break;
    total -= dropped;
    end--;
  }
  if (end === data.pages.length) return data;
  const pages = data.pages.slice(0, end);
  pages[end - 1] = { ...pages[end - 1]!, hasMore: true };
  return { pages, pageParams: data.pageParams.slice(0, end) };
}

/** 불러 둔 대화 기록의 오래된 쪽을 덜어 낸다(`trimTranscript`). 맨 아래를 따라가는 화면만 부른다. */
export function trimConversation(
  queryClient: QueryClient,
  orgId: string,
  conversationId?: string
) {
  queryClient.setQueryData<TranscriptData>(
    queryKeys.conversation(orgId, conversationId),
    (old) => old && trimTranscript(old)
  );
}

/** 대화 하나의 줄 세운 메시지 전부(보낸 순서). 대화 ID가 없으면 기본 대화다. */
export function useQueuedMessages(orgId: string, conversationId?: string) {
  return useQuery({
    queryKey: queryKeys.queuedMessages(orgId, conversationId),
    queryFn: () =>
      request(
        conversationMessageListSchema,
        `${chatPath(orgId, conversationId)}/queued-messages`
      ),
    retry: notFoundIsFinal,
  });
}

type OwnerMessage = { body: string; delivery: MessageDelivery };
const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Lead 대화에 사용자 메시지를 보낸다. 대화 ID가 없으면 기본 대화다. 실패하면 입력과 전달 방식을 지우지 않도록 호출한 쪽이 결과를 본다.
 * `중단하고 보내기`는 메시지와 실행 시도 중단 제어 명령을 한 요청으로 보낸다(서버가 함께 저장).
 */
export function useSendMessage(orgId: string, conversationId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OwnerMessage) =>
      request(
        conversationMessageSchema,
        messagesPath(orgId, conversationId),
        jsonPost(input)
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.queuedMessages(orgId, conversationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.conversations(orgId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents(orgId),
        }),
      ]),
  });
}

/** 줄 세운 메시지에 대한 명령: 그 자리에서 고치기, 거두기(`취소`, 빈 입력창의 ↑)와 `지금 보내기`. */
export type QueuedMessageCommand = "edit" | "withdraw" | "send_now";
const queuedMessagePath: Record<QueuedMessageCommand, string> = {
  edit: "edit",
  withdraw: "withdraw",
  send_now: "send-now",
};

/**
 * 줄 세운 메시지 하나를 고치거나 거두거나 지금 보낸다. 고치기는 `body`로 글만 바꾼다. 거두기가 돌려받는 메시지는 거두기 전 모양이라
 * 빈 입력창의 ↑가 그 글을 입력창에 되돌린다. 실행 시도가 먼저 받았으면 409 `message_delivered`이며, 성공하든 실패하든 줄 세운
 * 메시지와 Lead(줄 세운 메시지 수)를 다시 불러온다. 대화 기록은 여기서 이어 받지 않는다: 메시지를 받은 실행 시도는 늘 Event를
 * 남기고, 이어 받기는 Event가 부르는 `createLiveRefresh`가 하나씩 맡는다(더 오래된 쪽 불러오기와 겹치면 끝난 뒤 다시).
 */
export function useQueuedMessageCommand(
  orgId: string,
  conversationId?: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      command,
      body,
    }: {
      messageId: string;
      command: QueuedMessageCommand;
      body?: string;
    }) =>
      request(
        conversationMessageSchema,
        orgPath(
          orgId,
          `/messages/${encodeURIComponent(messageId)}/${queuedMessagePath[command]}`
        ),
        jsonPost(command === "edit" ? { body } : {})
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.queuedMessages(orgId, conversationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.conversations(orgId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents(orgId),
        }),
      ]),
  });
}

/** 첫 메시지로 새 대화를 시작한다. 메시지를 보내기 전에는 대화가 생기지 않는다. */
export function useStartConversation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OwnerMessage) =>
      request(
        startConversationResultSchema,
        orgPath(orgId, "/conversations"),
        jsonPost(input)
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations(orgId),
        exact: true,
      }),
  });
}

/** 사용자가 대화를 메시지 하나까지 보았다. 서버가 돌려준 대화 목록으로 읽지 않음 표시를 바꾼다. */
export function useMarkConversationRead(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      upToMessageId,
    }: {
      conversationId: string;
      upToMessageId: string;
    }) =>
      request(
        conversationSummaryListSchema,
        orgPath(
          orgId,
          `/conversations/${encodeURIComponent(conversationId)}/read`
        ),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ upToMessageId }),
        }
      ),
    onSuccess: (list) =>
      queryClient.setQueryData(queryKeys.conversations(orgId), list),
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

/** 화면을 보는 브라우저의 시간대. 대시보드 날짜를 이 시계로 자른다. */
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * 조직 대시보드 요약 조회. 서버가 모르는 시간대 이름이면 UTC로 다시 불러오며, 응답의 시간대를 화면에 밝힌다.
 * 날짜가 바뀌면 Event가 없어도 14일이 하루 밀리므로 응답이 자른 오늘이 끝날 때 다시 불러온다. 기다릴 시간은
 * 서버 시각(`asOf`→`nextDayAt`)으로 재므로 대체한 시간대·브라우저 시계와 어긋나지 않는다.
 */
export const dashboardQuery = (orgId: string, timeZone: string) =>
  queryOptions({
    queryKey: queryKeys.dashboard(orgId, timeZone),
    queryFn: () => {
      const get = (tz: string) =>
        request(
          organizationDashboardSchema,
          orgPath(orgId, `/dashboard?timeZone=${encodeURIComponent(tz)}`)
        );
      return get(timeZone).catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "invalid_time_zone")
          return get("UTC");
        throw error;
      });
    },
    refetchInterval: ({ state: { data } }) =>
      data ? Date.parse(data.nextDayAt) - Date.parse(data.asOf) + 1_000 : false,
  });

/** 조직 대시보드 요약(지표·14일·진행 중 실행 시도·최근 활동). 조직 Event와 날짜가 바뀔 때 다시 불러온다. */
export function useOrganizationDashboard(orgId: string) {
  return useQuery(dashboardQuery(orgId, browserTimeZone()));
}

/** 홈 개요. 조직 목록과 따로 오므로 목록에만 있는 새 조직은 0으로 본다. */
export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => request(overviewSchema, "/api/overview"),
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

/** 에이전트 일시정지·재개·실행 중단 제어 명령. 응답의 에이전트 상세로 바꾸고 그 조직 범위를 다시 불러온다. */
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

/**
 * 에이전트 이름·얼굴 변경. 서버가 확정한 에이전트 상세로 바꾸고, 이름이 보이는 조직 상세(사이드바·그래프·활동)를 다시 불러온다.
 * 다른 탭은 `agent.profile_changed` Event로 같은 조직을 다시 불러온다.
 */
export function useUpdateAgentProfile(orgId: string, agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentProfileInput) =>
      request(
        agentDetailSchema,
        orgPath(orgId, `/agents/${encodeURIComponent(agentId)}`),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      ),
    onSuccess: (agent) => {
      queryClient.setQueryData(queryKeys.agent(orgId, agentId), agent);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.organization(orgId),
        exact: true,
      });
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
