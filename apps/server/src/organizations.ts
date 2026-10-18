import { randomUUID } from "node:crypto";
import type {
  CreateOrganizationInput,
  OrganizationDetail,
} from "@babojubot/contracts";
import { planOrganizationCreation } from "@babojubot/core";
import { insertOrganizationCreation, type Database } from "@babojubot/db";
import type { EventHub } from "./event-hub.ts";
import { leadInstructionsOf, loadHarnessLibrary } from "./harness.ts";

/**
 * 조직 생성. 조직·Lead·Lead의 Role·Soul 사본·Event를 한 transaction으로 저장한 뒤에만 Event를 알린다.
 * Lead 사본은 지금의 하네스 라이브러리에서 복사한다.
 * 알림이 실패해도 이미 저장된 생성은 성공으로 돌려준다. 화면은 다시 조회해 맞춘다.
 */
export async function createOrganization(
  { db, hub, harnessDir }: { db: Database; hub: EventHub; harnessDir: string },
  input: CreateOrganizationInput
): Promise<OrganizationDetail> {
  const library = await loadHarnessLibrary(harnessDir);
  const creation = planOrganizationCreation(
    input,
    leadInstructionsOf(library),
    { newId: randomUUID, now: () => new Date() }
  );
  const event = await insertOrganizationCreation(db, creation);
  try {
    hub.publish(event);
  } catch (error) {
    console.error("[organizations] publish after commit failed", error);
  }
  return { ...creation.organization, agents: creation.agents };
}
