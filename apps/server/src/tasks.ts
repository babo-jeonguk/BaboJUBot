import { randomUUID } from "node:crypto";
import {
  insertOwnerTaskComment,
  type Database,
  type OwnerCommentResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 사용자의 작업 댓글. 댓글·담당자 깨우기·Event를 한 transaction으로 저장한 뒤 알리고 담당자를 깨운다.
 * 담당자가 실행 중이면 댓글은 다음 실행 시도에 반영된다.
 */
export async function addOwnerTaskComment(
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
  taskId: string,
  body: string
): Promise<OwnerCommentResult> {
  const result = await insertOwnerTaskComment(
    db,
    organizationId,
    taskId,
    body,
    {
      newId: randomUUID,
      now,
    }
  );
  if (result.kind !== "ok") return result;
  try {
    hub.publish(result.event);
  } catch (error) {
    console.error("[tasks] publish after commit failed", error);
  }
  dispatcher.kick(result.wake.agentId);
  return result;
}
