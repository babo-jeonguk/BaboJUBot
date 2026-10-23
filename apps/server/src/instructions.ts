import { randomUUID } from "node:crypto";
import type { EditInstructionCopyInput } from "@babojubot/contracts";
import {
  editInstructionCopy,
  type Database,
  type InstructionEditResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 사용자의 Role·Soul·Skill 사본 편집. 바뀐 사본·revision·Lead 깨우기·Event를 한 transaction으로 저장한 뒤에만 알리고 Lead를 깨운다.
 * 진행 중 실행 시도는 시작할 때 받은 지침으로 끝까지 가고, 그 에이전트의 다음 실행 시도가 새 내용을 받는다.
 */
export async function editInstructionCopyAsOwner(
  {
    db,
    hub,
    dispatcher,
    now,
  }: {
    db: Database;
    hub: EventHub;
    dispatcher: RunDispatcher;
    now: () => Date;
  },
  ref: { organizationId: string; agentId: string; copyId: string },
  input: EditInstructionCopyInput
): Promise<InstructionEditResult> {
  const result = await editInstructionCopy(db, ref, input, {
    newId: randomUUID,
    now,
  });
  if (result.kind !== "ok") return result;
  hub.publish(result.event);
  dispatcher.kick(result.wake.agentId);
  return result;
}
