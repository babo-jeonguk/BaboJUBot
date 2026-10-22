import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentRoleSchema,
  defaultHeartbeatMinutes,
  flowTemplateDefinitionSchema,
  heartbeatIntervalSchema,
  harnessNameSchema,
  type HarnessLibrary,
  type InstructionSourceFile,
} from "@babojubot/contracts";
import {
  type AgentRoleSource,
  contentDigest,
  decodeInstructionText,
  instructionPaths,
  parseSkillFrontmatter,
  type HarnessLibraryContents,
} from "@babojubot/core";
import { z } from "zod";

/** 저장소의 하네스 라이브러리. 사용자가 고치는 원본이며, 요청마다 읽어 그때 내용을 사본·승인 대상으로 고정한다. */
export const defaultHarnessDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../harness"
);

/** Lead가 조직 생성 때 사본을 받는 하네스 Role. */
export const leadHarnessRole = "lead";

const roleManifestSchema = z.strictObject({
  label: z.string().trim().min(1),
  agent: agentRoleSchema,
  skills: z.array(harnessNameSchema),
  /** 이 Role의 에이전트가 받는 기본 heartbeat 간격(분). 사용자가 에이전트마다 조정한다. */
  heartbeatMinutes: heartbeatIntervalSchema.default(defaultHeartbeatMinutes),
});

/**
 * 하네스 라이브러리를 읽는다. 구조는 `roles/<name>/{role.json,AGENTS.md,SOUL.md}`,
 * `skills/<name>/SKILL.md`, `templates/<name>/template.json`이다. 이름은 Agent Skills name 규칙을 따르고,
 * 파일은 UTF-8이어야 한다. 하나라도 어긋나면 무엇이 틀렸는지 담아 실패한다.
 */
export async function loadHarnessLibrary(
  dir: string
): Promise<HarnessLibraryContents> {
  const read = async (relative: string) => {
    const bytes = await fs.readFile(path.join(dir, relative));
    try {
      const content = decodeInstructionText(bytes);
      return {
        content,
        source: relative,
        sourceDigest: contentDigest(content),
      };
    } catch (error) {
      throw new Error(`하네스 ${relative}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  };
  const names = async (sub: string) =>
    (await fs.readdir(path.join(dir, sub), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => {
        const parsed = harnessNameSchema.safeParse(d.name);
        if (!parsed.success)
          throw new Error(`하네스 ${sub}/${d.name}: 이름 규칙에 맞지 않습니다`);
        return parsed.data;
      })
      .sort();
  const json = async <T>(relative: string, schema: z.ZodType<T>) => {
    const file = await read(relative);
    const parsed = schema.safeParse(JSON.parse(file.content));
    if (!parsed.success)
      throw new Error(`하네스 ${relative}: ${z.prettifyError(parsed.error)}`);
    return { ...file, value: parsed.data };
  };

  const skills = new Map<string, InstructionSourceFile>();
  for (const name of await names("skills")) {
    const relative = `skills/${name}/SKILL.md`;
    const file = await read(relative);
    try {
      if (parseSkillFrontmatter(file.content).name !== name)
        throw new Error("frontmatter name이 디렉터리 이름과 다릅니다");
    } catch (error) {
      throw new Error(`하네스 ${relative}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    skills.set(name, { ...file, path: instructionPaths.skill(name) });
  }

  const roles: HarnessLibraryContents["roles"] = new Map();
  for (const name of await names("roles")) {
    const { value: manifest } = await json(
      `roles/${name}/role.json`,
      roleManifestSchema
    );
    const files: InstructionSourceFile[] = [
      {
        ...(await read(`roles/${name}/AGENTS.md`)),
        path: instructionPaths.role,
      },
      { ...(await read(`roles/${name}/SOUL.md`)), path: instructionPaths.soul },
    ];
    for (const skill of manifest.skills) {
      const file = skills.get(skill);
      if (!file)
        throw new Error(`하네스 roles/${name}/role.json: 없는 Skill ${skill}`);
      files.push(file);
    }
    roles.set(name, { ...manifest, files });
  }

  const templates: HarnessLibraryContents["templates"] = new Map();
  for (const name of await names("templates")) {
    const { value, source, sourceDigest } = await json(
      `templates/${name}/template.json`,
      flowTemplateDefinitionSchema
    );
    templates.set(name, { ...value, name, source, sourceDigest });
  }
  return { roles, templates };
}

/** Lead가 보는 라이브러리 목록. 파일 내용은 담지 않는다. */
export function listHarnessLibrary(
  contents: HarnessLibraryContents
): HarnessLibrary {
  return {
    roles: [...contents.roles].map(([name, role]) => ({
      name,
      label: role.label,
      agent: role.agent,
      skills: role.skills,
    })),
    templates: [...contents.templates.values()].map(
      ({ source: _source, sourceDigest: _digest, ...template }) => template
    ),
  };
}

/** 새 Lead가 받을 Role·Soul(·Skill) 원본과 기본 heartbeat 간격. 라이브러리에 Lead Role이 없으면 조직을 만들지 않는다. */
export function leadRoleOf(contents: HarnessLibraryContents): AgentRoleSource {
  const role = contents.roles.get(leadHarnessRole);
  if (!role || role.agent !== "lead")
    throw new Error(`하네스 roles/${leadHarnessRole}: Lead Role이 없습니다`);
  return { files: role.files, heartbeatMinutes: role.heartbeatMinutes };
}
