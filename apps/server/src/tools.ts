import { randomUUID } from "node:crypto";
import {
  orgToolPaths,
  sendAgentMessageInputSchema,
  type Event,
  type OrgToolErrorCode,
  type OrgToolName,
  type PublicActivity,
} from "@babojubot/contracts";
import { canMessageOwner } from "@babojubot/core";
import {
  appendRunActivity,
  authenticateRun,
  findMessage,
  insertAgentMessage,
  loadRunContext,
  type ActiveRun,
  type Database,
} from "@babojubot/db";
import express from "express";
import type { EventHub } from "./event-hub.ts";
import { digestRunToken } from "./run-token.ts";

/**
 * 조직 도구 HTTP. 사용자 API와 따로 실행 시도별 토큰으로만 인증하고, 조직·에이전트·실행 시도는 토큰에서만 정한다.
 * 실행 중이 아닌 실행 시도의 토큰은 읽기까지 모두 거부한다. 성공한 호출은 그 실행 시도의 공개 활동에 요약을 남긴다.
 */
export function orgToolsRouter({
  db,
  hub,
  now,
}: {
  db: Database;
  hub: EventHub;
  now: () => Date;
}): express.Router {
  const router = express.Router();
  const refuse = (
    res: express.Response,
    status: number,
    code: OrgToolErrorCode
  ) => res.status(status).json({ error: { code } });
  /** commit 뒤 알림. 알림이 실패해도 저장된 도구 호출은 성공으로 돌려준다(재시도로 중복 저장하지 않게). */
  const publish = (events: Event[]) => {
    try {
      for (const event of events) hub.publish(event);
    } catch (error) {
      console.error("[tools] publish after commit failed", error);
    }
  };
  const toolActivity = (
    tool: OrgToolName,
    summary: string
  ): PublicActivity => ({
    source: "control_plane",
    activity: { type: "org_tool", tool, summary },
  });
  /** 읽기 도구의 요약을 남긴다. 그 사이 실행 시도가 끝났으면 false. */
  const recordRead = async (
    run: ActiveRun,
    tool: OrgToolName,
    summary: string
  ) => {
    const event = await appendRunActivity(
      db,
      run.id,
      toolActivity(tool, summary)
    );
    if (event) publish([event]);
    return event !== undefined;
  };

  router.use(async (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    const run = token && (await authenticateRun(db, digestRunToken(token)));
    if (!run) return refuse(res, 401, "invalid_token");
    res.locals.run = run;
    next();
  });
  const runOf = (res: express.Response) => res.locals.run as ActiveRun;

  router.get(orgToolPaths.get_run_context, async (_req, res) => {
    const run = runOf(res);
    const context = await loadRunContext(db, run.id);
    if (!context) return refuse(res, 401, "invalid_token");
    const recorded = await recordRead(
      run,
      "get_run_context",
      `실행 맥락 조회: 깨우기 ${context.wakeReasons.length}개, 대화 ${context.context.conversation.length}개`
    );
    if (!recorded) return refuse(res, 401, "invalid_token");
    res.json(context);
  });

  router.get(orgToolPaths.get_message, async (req, res) => {
    const run = runOf(res);
    const message = await findMessage(
      db,
      run.organizationId,
      String(req.params.messageId)
    );
    // 다른 조직의 메시지와 없는 메시지는 같은 응답이다.
    if (!message) return refuse(res, 404, "not_found");
    if (!(await recordRead(run, "get_message", "메시지 하나 조회")))
      return refuse(res, 401, "invalid_token");
    res.json(message);
  });

  router.post(orgToolPaths.send_message, async (req, res) => {
    const run = runOf(res);
    const input = sendAgentMessageInputSchema.safeParse(req.body);
    if (!input.success) return refuse(res, 422, "invalid_input");
    if (!canMessageOwner({ role: run.agentRole }))
      return refuse(res, 403, "forbidden");
    const saved = await insertAgentMessage(db, run.id, input.data.body, {
      source: { newId: randomUUID, now },
      activity: toolActivity(
        "send_message",
        `Lead 대화에 답장 (${[...input.data.body].length}자)`
      ),
    });
    if (!saved) return refuse(res, 401, "invalid_token");
    publish(saved.events);
    res.status(201).json(saved.message);
  });

  router.use((_req, res) => refuse(res, 404, "not_found"));
  return router;
}
