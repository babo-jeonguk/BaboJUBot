import { randomUUID } from "node:crypto";
import type {
  CreateOrganizationInput,
  OrganizationDetail,
  UpdateApprovalPolicyInput,
} from "@babojubot/contracts";
import { planOrganizationCreation } from "@babojubot/core";
import {
  insertOrganizationCreation,
  updateApprovalPolicy as storePolicy,
  type Database,
  type PolicyChange,
} from "@babojubot/db";
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
  hub.publish(event);
  return { ...creation.organization, agents: creation.agents };
}

/**
 * 사용자의 승인 정책 변경 제어 명령. 정책과 Event를 한 transaction으로 저장한 뒤에만 알린다.
 * 조직 도구에는 이 명령이 없다. 이미 결정을 기다리는 승인 요청은 바꾸지 않는다.
 */
export async function updateApprovalPolicy(
  { db, hub }: { db: Database; hub: EventHub },
  organizationId: string,
  input: UpdateApprovalPolicyInput
): Promise<PolicyChange> {
  const result = await storePolicy(db, organizationId, input);
  if (result.kind !== "changed") return result;
  hub.publish(result.event);
  return result;
}
