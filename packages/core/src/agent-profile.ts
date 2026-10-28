import type {
  AgentAppearance,
  NewEvent,
  UpdateAgentProfileInput,
} from "@babojubot/contracts";

type ProfileAgent = {
  id: string;
  organizationId: string;
  name: string;
  /** 지금 보이는 얼굴(저장한 얼굴이 없으면 기본 얼굴). */
  appearance: AgentAppearance;
};

/**
 * 같은 이름인가를 정하는 열쇠. 앞뒤 공백을 지운 뒤(이름 입력 계약과 같음) 대소문자만 다른 이름은 같은 이름이다.
 * 조직 안에서 이름이 하나의 팀원을 가리켜야 하므로(Lead가 이름으로 팀원을 부름) 이름을 바꾸는 길과 만드는 길이 모두 이 규칙을 쓴다.
 * DB의 `agents_organization_name_unique`(조직, `lower(name)`)는 경합의 마지막 방어선이다.
 */
export const agentNameKey = (name: string) =>
  name.trim().toLocaleLowerCase("und");

/** `names` 가운데 `name`과 같은 이름(`agentNameKey`)이 있는가. */
export const isAgentNameTaken = (name: string, names: Iterable<string>) => {
  const key = agentNameKey(name);
  for (const other of names) if (agentNameKey(other) === key) return true;
  return false;
};

const sameAppearance = (a: AgentAppearance, b: AgentAppearance) =>
  a.color === b.color &&
  a.eyes === b.eyes &&
  a.mouth === b.mouth &&
  a.accessory === b.accessory;

/**
 * 사용자의 에이전트 이름·얼굴 변경. 단계와 상관없이 바꿀 수 있다(제어 명령이 아니며 연구 진행에 닿지 않는다).
 * `otherNames`는 같은 조직의 다른 에이전트 이름이며, 대소문자만 다른 이름도 겹친다(`name_taken`).
 * 바뀐 항목만 저장·Event에 담고, 모두 그대로면 `unchanged`다. 자기 이름의 대소문자만 바꾸는 것은 변경이다.
 */
export function planAgentProfileChange(
  agent: ProfileAgent,
  input: UpdateAgentProfileInput,
  otherNames: string[]
):
  | {
      update: { name?: string; appearance?: AgentAppearance };
      event: NewEvent;
    }
  | "unchanged"
  | "name_taken" {
  const name =
    input.name !== undefined && input.name !== agent.name
      ? input.name
      : undefined;
  if (name !== undefined && isAgentNameTaken(name, otherNames))
    return "name_taken";
  const appearance =
    input.appearance && !sameAppearance(input.appearance, agent.appearance)
      ? input.appearance
      : undefined;
  if (name === undefined && appearance === undefined) return "unchanged";
  return {
    update: {
      ...(name !== undefined && { name }),
      ...(appearance && { appearance }),
    },
    event: {
      organizationId: agent.organizationId,
      type: "agent.profile_changed",
      payload: {
        by: "owner",
        agentId: agent.id,
        name: name === undefined ? null : { from: agent.name, to: name },
        appearance: appearance ?? null,
      },
    },
  };
}
