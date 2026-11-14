import type {
  Approval,
  Conversation,
  ConversationMessage,
  DecideApprovalInput,
  DecideResultInput,
  OrganizationDetail,
  ResultSubmission,
  SendOwnerMessageInput,
} from "@babojubot/contracts";
import { planOwnerMessage, type RecordSource } from "@babojubot/core";
import {
  decideApproval,
  decideResult,
  insertOwnerMessage,
  settleSteer,
  type Database,
  type DecisionRefusal,
  type ResultDecisionRefusal,
  type Stored,
} from "@babojubot/db";
import {
  completeStored,
  type AfterCommitDeps,
  type Outcome,
} from "./after-commit.ts";
import type { RunDispatcher } from "./dispatcher.ts";
import type { ProviderRegistry } from "./providers.ts";

type SentOwnerMessage = Outcome<
  { conversation: Conversation | null; message: ConversationMessage },
  "organization_closed" | "queue_full"
>;

/**
 * 웹과 채널이 함께 쓰는 사용자 행동 셋: 사용자 메시지, 승인 결정, 결과 검토. 저장 전 모델 목록 조회, 기존 저장 규칙 호출, commit마다
 * 한 번의 commit 뒤 처리를 이 순서로 하고 처리를 마친 결과만 돌려준다. 받는 쪽(HTTP 경로·채널 입구)은 입력 해석·대상 찾기·응답 변환만 하고
 * 받은 결과에 commit 뒤 처리를 다시 하지 않는다.
 * 결정 규칙(이미 결정한 요청이 먼저, 종류별 결정, 조직 단계, 정책, 선택 검사)과 transaction은 core/DB가 그대로 맡는다.
 */
export type UserActions = {
  /**
   * Lead 대화에 사용자 메시지를 남긴다. `conversation`은 같은 조직의 대화(호출한 쪽이 조직 안에서 찾은 것)이고, `new`면 이 메시지로
   * 새 대화를 시작한다. 새 대화는 메시지와 같은 transaction에 남으므로 메시지를 받지 않으면 대화도 남지 않는다.
   * Lead가 실행 중이면 메시지는 다음 실행 시도에 반영된다. `중단하고 보내기`면 commit 뒤 진행 중 실행 시도에 취소를 보내고,
   * 그 실행 시도가 정리를 끝내면 다음 실행 시도가 메시지를 받는다. `실행 중 끼워 넣기`면 저장 → commit 뒤 처리 → 진행 중 실행 시도의
   * 프로바이더에 넣기 → 그 결과(받음, 거절이면 줄 세우기) 저장 → commit 뒤 처리 순서로 하고 결과를 남긴 메시지를 돌려준다.
   * 두 저장은 서로 다른 commit이며 하나로 합치지 않는다. 넣을 실행 시도가 없었으면 처음부터 줄 세운 메시지다.
   */
  sendOwnerMessage: (
    organization: OrganizationDetail,
    conversation: Pick<Conversation, "id"> | "new",
    input: Required<SendOwnerMessageInput>
  ) => Promise<SentOwnerMessage>;
  /**
   * 승인 결정. 작업자마다 고른 프로바이더·모델의 목록은 조직 잠금 밖에서 미리 받아 오고, 그 확인은 이미 결정한 요청인지 본 뒤 결정 규칙 안에서 한다.
   */
  decideApproval: (
    organizationId: string,
    approvalId: string,
    input: DecideApprovalInput
  ) => Promise<Outcome<Approval, DecisionRefusal>>;
  /** 결과 검토(수정 요청 또는 최종 완료). */
  decideResult: (
    organizationId: string,
    submissionId: string,
    input: DecideResultInput
  ) => Promise<Outcome<ResultSubmission, ResultDecisionRefusal>>;
};

export function createUserActions({
  db,
  source,
  providers,
  dispatcher,
  afterCommit,
}: {
  db: Database;
  source: RecordSource;
  providers: Pick<ProviderRegistry, "modelsFor" | "steerable">;
  dispatcher: Pick<RunDispatcher, "steer">;
  afterCommit: AfterCommitDeps;
}): UserActions {
  /** commit 하나의 저장 결과에 commit 뒤 처리를 한 번 한다. 이 모듈만 부르고 결과를 받는 쪽은 다시 하지 않는다. */
  const complete = async <T, R extends string>(stored: Promise<Stored<T, R>>) =>
    completeStored(afterCommit, await stored);

  return {
    async sendOwnerMessage(organization, conversation, input) {
      const sent = await complete(
        insertOwnerMessage(
          db,
          planOwnerMessage(
            { organizationId: organization.id, agents: organization.agents },
            conversation,
            input,
            source
          ),
          { steerable: providers.steerable }
        )
      );
      if (sent.kind !== "ok") return sent;
      const { steerRunId, ...value } = sent.value;
      if (!steerRunId) return { kind: "ok", value };
      const { message } = value;
      const outcome = await dispatcher.steer({
        runId: steerRunId,
        messageId: message.id,
        conversationId: message.conversationId,
        body: message.body,
      });
      const settled = await complete(
        settleSteer(
          db,
          {
            organizationId: message.organizationId,
            messageId: message.id,
            runId: steerRunId,
            outcome,
          },
          source
        )
      );
      return {
        kind: "ok",
        value: {
          ...value,
          message: (settled.kind === "ok" && settled.value) || message,
        },
      };
    },

    async decideApproval(organizationId, approvalId, input) {
      const connections = await providers.modelsFor(input.choices ?? []);
      return complete(
        decideApproval(
          db,
          organizationId,
          approvalId,
          input,
          source,
          connections
        )
      );
    },

    decideResult: (organizationId, submissionId, input) =>
      complete(decideResult(db, organizationId, submissionId, input, source)),
  };
}
