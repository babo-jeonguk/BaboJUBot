import { z } from "zod";
import { agentRoleSchema } from "./organization.ts";

// Research Harness 계약. 하네스 라이브러리의 Role·Soul·Skill·연구 흐름 템플릿과
// 그 내용을 복사한 에이전트별·조직별 사본의 모양(docs/architecture.md Research Harness).

/** 하네스 라이브러리 이름(Role·Skill·템플릿). Agent Skills의 name 규칙과 같다. */
export const harnessNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** 지침 파일 하나. `path`는 에이전트 지침 bundle 안의 상대 경로다(`AGENTS.md`, `SOUL.md`, `skills/<name>/SKILL.md`). */
export const instructionFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type InstructionFile = z.infer<typeof instructionFileSchema>;

/** 하네스 라이브러리에서 읽은 지침 파일. 라이브러리 안의 출처 경로와 그때 내용의 SHA-256을 함께 둔다. */
export const instructionSourceFileSchema = instructionFileSchema.extend({
  source: z.string(),
  sourceDigest: z.string(),
});
export type InstructionSourceFile = z.infer<typeof instructionSourceFileSchema>;

export const instructionKinds = ["role", "soul", "skill"] as const;
export const instructionKindSchema = z.enum(instructionKinds);
export type InstructionKind = z.infer<typeof instructionKindSchema>;

/**
 * 에이전트 하나가 소유한 지침 사본. 같은 Role에서 복사했어도 에이전트마다 따로 있고 ID가 다르다.
 * 사본을 고쳐도 하네스 라이브러리와 다른 에이전트의 사본은 바뀌지 않는다.
 */
export const instructionCopySchema = instructionSourceFileSchema.extend({
  id: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  kind: instructionKindSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type InstructionCopy = z.infer<typeof instructionCopySchema>;

/** 에이전트의 지침 사본 전체와 그 내용에서 정한 지침 bundle 버전. 사본이 없으면 버전도 없다. */
export const agentInstructionsSchema = z.object({
  agentId: z.uuid(),
  bundleVersion: z.string().nullable(),
  copies: z.array(instructionCopySchema),
});
export type AgentInstructions = z.infer<typeof agentInstructionsSchema>;

/** 연구 흐름 템플릿이 선언하는 연구 노드 종류·연결 종류 하나. */
export const flowKindSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1),
});
export type FlowKind = z.infer<typeof flowKindSchema>;

/** 연구 흐름 템플릿 정의. Control Plane은 이 구조만 검증하고 연구적 판단은 하지 않는다. */
export const flowTemplateDefinitionSchema = z.strictObject({
  label: z.string().trim().min(1),
  description: z.string(),
  nodeKinds: z.array(flowKindSchema).min(1),
  linkKinds: z.array(flowKindSchema),
});
export type FlowTemplateDefinition = z.infer<
  typeof flowTemplateDefinitionSchema
>;

/** 하네스 라이브러리에서 읽어 승인 요청에 고정한 템플릿. */
export const flowTemplateSnapshotSchema = flowTemplateDefinitionSchema.extend({
  name: harnessNameSchema,
  source: z.string(),
  sourceDigest: z.string(),
});
export type FlowTemplateSnapshot = z.infer<typeof flowTemplateSnapshotSchema>;

/** 조직이 소유한 연구 흐름 템플릿 사본. 초기 연구 승인 때 승인한 snapshot에서 만든다. */
export const flowTemplateCopySchema = flowTemplateSnapshotSchema.extend({
  id: z.uuid(),
  organizationId: z.uuid(),
  approvalId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type FlowTemplateCopy = z.infer<typeof flowTemplateCopySchema>;

/** 하네스 라이브러리 목록. Lead가 팀 구성과 템플릿을 고를 때 본다. 내용은 승인 요청 상세에서 보인다. */
export const harnessLibrarySchema = z.object({
  roles: z.array(
    z.object({
      name: harnessNameSchema,
      label: z.string(),
      agent: agentRoleSchema,
      skills: z.array(harnessNameSchema),
    })
  ),
  templates: z.array(
    flowTemplateDefinitionSchema.extend({ name: harnessNameSchema })
  ),
});
export type HarnessLibrary = z.infer<typeof harnessLibrarySchema>;
