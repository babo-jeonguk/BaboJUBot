import { createHash } from "node:crypto";
import {
  harnessNameSchema,
  type AgentRole,
  type FlowTemplateSnapshot,
  type InstructionCopy,
  type InstructionFile,
  type InstructionKind,
  type InstructionSourceFile,
} from "@babojubot/contracts";

// Research Harness 규칙: 라이브러리 내용의 검증, 에이전트 지침 bundle의 경로와 버전.
// 파일을 읽는 일은 서버가 하고, 여기서는 읽은 내용만 다룬다.

/** 하네스 라이브러리에서 읽은 내용. 서버가 요청 때마다 저장소의 `harness/`에서 읽는다. */
export type HarnessLibraryContents = {
  roles: Map<
    string,
    {
      label: string;
      agent: AgentRole;
      skills: string[];
      /** 그 Role의 에이전트가 받을 지침 bundle: AGENTS.md, SOUL.md, skills/<name>/SKILL.md. */
      files: InstructionSourceFile[];
      /** 그 Role의 에이전트가 받는 기본 heartbeat 간격(분). */
      heartbeatMinutes: number;
    }
  >;
  templates: Map<string, FlowTemplateSnapshot>;
};

/** 에이전트 지침 bundle 안의 경로. Role은 AGENTS.md, Soul은 SOUL.md, Skill은 skills 아래 SKILL.md다. */
export const instructionPaths = {
  role: "AGENTS.md",
  soul: "SOUL.md",
  skill: (name: string) => `skills/${name}/SKILL.md`,
};

export function instructionKindOf(path: string): InstructionKind {
  if (path === instructionPaths.role) return "role";
  if (path === instructionPaths.soul) return "soul";
  return "skill";
}

export const contentDigest = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

/** bundle 버전 직렬화 규칙의 이름. 규칙을 바꾸면 이 값을 올려 이전 버전과 섞이지 않게 한다. */
export const bundleFormat = "babojubot-instructions-bundle/1";

/**
 * 지침 bundle 버전. 에이전트 사본 전체(경로와 UTF-8 내용)에서 결정적으로 정하며 사본 ID·시각과는 무관하다.
 * 파일은 경로 순서로 놓고 각 파일을 `경로\n바이트 길이\n내용\n`으로 이어 붙여 파일 경계가 섞이지 않게 한다.
 * 사본이 없으면 버전도 없다.
 */
export function instructionsBundleVersion(
  files: InstructionFile[]
): string | null {
  if (!files.length) return null;
  const hash = createHash("sha256").update(`${bundleFormat}\n`);
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  for (const file of sorted) {
    const bytes = Buffer.from(file.content, "utf8");
    hash.update(`${file.path}\n${bytes.length}\n`).update(bytes).update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

export const instructionMaxBytes = 1024 * 1024;

/** 지침 파일 bytes를 글자로. 잘못된 UTF-8은 바꿔 넣지 않고 거부한다. BOM은 내용으로 보존한다. */
export function decodeInstructionText(bytes: Uint8Array): string {
  if (bytes.byteLength > instructionMaxBytes)
    throw new Error("지침 파일이 1 MiB를 넘습니다");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes
  );
}

/**
 * SKILL.md frontmatter의 name·description(Agent Skills 명세). 최상위 `key: value` 줄만 읽는다.
 * name은 소문자·숫자·하이픈 64자 이하, description은 1~1024자다.
 */
export function parseSkillFrontmatter(text: string): {
  name: string;
  description: string;
} {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("SKILL.md에 frontmatter가 없습니다");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("SKILL.md frontmatter가 닫히지 않았습니다");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (!match) continue;
    fields.set(match[1]!, unquote(match[2]!.trim()));
  }
  const name = harnessNameSchema.parse(fields.get("name"));
  const description = fields.get("description") ?? "";
  if (!description || description.length > 1024)
    throw new Error("SKILL.md description은 1~1024자여야 합니다");
  return { name, description };
}

const unquote = (value: string) =>
  /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;

/** 라이브러리 내용을 에이전트 하나의 사본으로. 사본마다 새 ID를 받으므로 같은 Role의 에이전트끼리도 공유하지 않는다. */
export function copyInstructions(
  agent: { id: string; organizationId: string },
  files: InstructionSourceFile[],
  { newId, createdAt }: { newId: () => string; createdAt: string }
): InstructionCopy[] {
  return files.map((file) => ({
    ...file,
    id: newId(),
    organizationId: agent.organizationId,
    agentId: agent.id,
    kind: instructionKindOf(file.path),
    createdAt,
  }));
}
