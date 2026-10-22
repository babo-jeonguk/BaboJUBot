import { randomUUID } from "node:crypto";
import {
  editResearchMap,
  type Database,
  type MapCommand,
  type MapCommandValue,
  type OwnerMapEditResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 사용자의 연구 지도 편집. 변경·편집 기록·Lead 깨우기·Event를 한 transaction으로 저장한 뒤에만 알리고 Lead를 깨운다.
 * Lead가 실행 중이면 편집은 다음 실행 시도에 반영된다. 지금과 같은 값의 편집은 아무것도 남기거나 깨우지 않는다.
 */
export async function editResearchMapAsOwner<C extends MapCommand>(
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
  organizationId: string,
  command: C
): Promise<OwnerMapEditResult<MapCommandValue<C>>> {
  const result = await editResearchMap(db, organizationId, command, {
    newId: randomUUID,
    now,
  });
  if (result.kind !== "ok") return result;
  if (result.event) hub.publish(result.event);
  if (result.wake) dispatcher.kick(result.wake.agentId);
  return result;
}
