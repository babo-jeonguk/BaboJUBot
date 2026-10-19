import { z } from "zod";
import { flowKindSchema } from "./harness.ts";
import type { LifecycleStage } from "./organization.ts";
import { artifactSummarySchema, taskSchema } from "./task.ts";

// 연구 지도: 연구 노드, 주 연결(노드의 주 부모), 보조 연결, 작업의 연구 노드 연결. 노드·보조 연결 종류는 조직 사본
// 흐름 템플릿이 선언한 것만 받는다. 조직·편집자·실행 시도는 입력이 아니라 실행 시도별 토큰(에이전트) 또는 경로(사용자)가 정한다.

const text = (max: number) => z.string().trim().min(1).max(max);
export const researchNodeTitleMaxLength = 300;
export const researchNodeBodyMaxLength = 20_000;
const kindName = flowKindSchema.shape.name;

/**
 * 연구 노드 상태. `discarded`(폐기)는 삭제 대신 쓰는 상태이며 폐기 직전 상태를 함께 남겨 폐기 취소 때 되돌린다.
 * 폐기된 노드는 폐기 취소만 받고, 새 하위·보조 연결·작업 연결의 대상이 되지 않는다. 기존 자손·연결·작업은 그대로 남는다.
 */
export const researchNodeStatuses = [
  "proposed",
  "in_progress",
  "done",
  "rejected",
  "discarded",
] as const;
export const researchNodeStatusSchema = z.enum(researchNodeStatuses);
export type ResearchNodeStatus = z.infer<typeof researchNodeStatusSchema>;
/** 수정으로 고를 수 있는 상태. 폐기는 폐기 명령으로만 한다. */
export const researchNodeWorkStatuses = [
  "proposed",
  "in_progress",
  "done",
  "rejected",
] as const;
export const researchNodeWorkStatusSchema = z.enum(researchNodeWorkStatuses);
export type ResearchNodeWorkStatus = z.infer<
  typeof researchNodeWorkStatusSchema
>;

/**
 * 사용자가 연구 지도를 편집할 수 있는 조직 단계: 초기 연구 승인 뒤, 최종 완료·중단 전. 에이전트의 지도 쓰기 도구는
 * 다른 쓰기 도구처럼 `연구 진행`에서만 열린다(core `toolRules`).
 */
export const ownerMapEditStages = [
  "researching",
  "paused",
  "result_review",
] as const satisfies readonly LifecycleStage[];

/** 노드 생성. 주 부모는 선택이며 같은 조직의 폐기되지 않은 노드여야 한다. */
export const createResearchNodeInputSchema = z.strictObject({
  kind: kindName,
  title: text(researchNodeTitleMaxLength),
  body: z.string().trim().max(researchNodeBodyMaxLength).default(""),
  parentNodeId: z.uuid().optional(),
});
export type CreateResearchNodeInput = z.input<
  typeof createResearchNodeInputSchema
>;

/** 노드 수정: 제목·본문·상태 중 하나 이상. 지금과 같은 값만 보내면 아무것도 기록하지 않는다. */
export const updateResearchNodeInputSchema = z
  .strictObject({
    title: text(researchNodeTitleMaxLength).optional(),
    body: z.string().trim().max(researchNodeBodyMaxLength).optional(),
    status: researchNodeWorkStatusSchema.optional(),
  })
  .refine(
    (x) =>
      x.title !== undefined || x.body !== undefined || x.status !== undefined,
    { message: "title, body or status is required" }
  );
export type UpdateResearchNodeInput = z.infer<
  typeof updateResearchNodeInputSchema
>;

/** 주 부모 지정. 주 부모가 없는 노드에만 할 수 있고, 이미 다른 주 부모가 있으면 거부한다. */
export const assignResearchNodeParentInputSchema = z.strictObject({
  parentNodeId: z.uuid(),
});
export type AssignResearchNodeParentInput = z.infer<
  typeof assignResearchNodeParentInputSchema
>;

/** 주 부모 변경. 기존 주 부모를 명시적으로 바꾸거나(`null`이면) 없앤다. */
export const changeResearchNodeParentInputSchema = z.strictObject({
  parentNodeId: z.uuid().nullable(),
});
export type ChangeResearchNodeParentInput = z.infer<
  typeof changeResearchNodeParentInputSchema
>;

/**
 * 보조 연결 추가. 개수 제한과 순환 검사가 없고, 같은 두 노드 사이에 같은 종류의 연결도 따로 남는다.
 * 자기 자신과의 연결만 거부한다.
 */
export const addResearchLinkInputSchema = z.strictObject({
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  kind: kindName,
});
export type AddResearchLinkInput = z.infer<typeof addResearchLinkInputSchema>;

/** 작업의 연구 노드 연결. 작업은 노드 0~1개에 연결된다. */
export const linkTaskResearchNodeInputSchema = z.strictObject({
  researchNodeId: z.uuid(),
});
export type LinkTaskResearchNodeInput = z.infer<
  typeof linkTaskResearchNodeInputSchema
>;

/** 입력이 없는 명령(폐기·폐기 취소·작업 연결 해제). */
export const emptyCommandInputSchema = z.strictObject({});

const time = z.iso.datetime({ offset: true });

/** 기록을 만든 쪽. 사용자는 에이전트·실행 시도가 없고, 에이전트는 둘 다 있다. */
export const mapActorSchema = z.discriminatedUnion("author", [
  z.object({ author: z.literal("owner") }),
  z.object({
    author: z.literal("agent"),
    agentId: z.uuid(),
    runId: z.uuid(),
  }),
]);
export type MapActor = z.infer<typeof mapActorSchema>;

export const researchNodeSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  status: researchNodeStatusSchema,
  /** 폐기 직전 상태. 폐기된 노드에만 있다. */
  statusBeforeDiscard: researchNodeWorkStatusSchema.nullable(),
  /** 주 부모. 주 연결의 ID는 이 노드(자식)의 ID다. */
  parentNodeId: z.uuid().nullable(),
  createdBy: mapActorSchema,
  createdAt: time,
  updatedAt: time,
});
export type ResearchNode = z.infer<typeof researchNodeSchema>;

/** 보조 연결. 관계마다 ID가 따로 있어 같은 두 노드 사이의 여러 연결이 합쳐지지 않는다. */
export const researchLinkSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  kind: z.string(),
  createdBy: mapActorSchema,
  createdAt: time,
});
export type ResearchLink = z.infer<typeof researchLinkSchema>;

/** 조직의 연구 지도 전체. 노드·보조 연결은 만든 순서대로. */
export const researchMapSchema = z.object({
  nodes: z.array(researchNodeSchema),
  links: z.array(researchLinkSchema),
});
export type ResearchMap = z.infer<typeof researchMapSchema>;

export const researchMapOperations = [
  "create_node",
  "update_node",
  "assign_parent",
  "change_parent",
  "add_link",
  "discard_node",
  "restore_node",
  "link_task",
  "relink_task",
  "unlink_task",
] as const;
export const researchMapOperationSchema = z.enum(researchMapOperations);
export type ResearchMapOperation = z.infer<typeof researchMapOperationSchema>;

/**
 * 연구 지도 편집 기록 하나. 편집자(사용자 또는 에이전트·실행 시도)와 대상·변경 요약을 남긴다.
 * 사용자 편집은 Lead를 깨운다. 지금과 같은 값의 요청은 편집이 아니어서 기록하지 않는다.
 */
export const researchMapEditSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  editor: mapActorSchema,
  operation: researchMapOperationSchema,
  nodeId: z.uuid().nullable(),
  linkId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  summary: z.string(),
  createdAt: time,
});
export type ResearchMapEdit = z.infer<typeof researchMapEditSchema>;

/** 노드 상세: 연결 작업과 그 산출물, 이 노드의 편집 기록(오래된 것부터). */
export const researchNodeDetailSchema = researchNodeSchema.extend({
  tasks: z.array(taskSchema),
  artifacts: z.array(artifactSummarySchema),
  edits: z.array(researchMapEditSchema),
});
export type ResearchNodeDetail = z.infer<typeof researchNodeDetailSchema>;
