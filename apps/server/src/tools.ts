import { randomUUID } from "node:crypto";
import {
  orgToolPaths,
  recordGoalInputSchema,
  requestInitialApprovalInputSchema,
  sendAgentMessageInputSchema,
  type Event,
  type OrgToolErrorCode,
  type OrgToolName,
  type PublicActivity,
  type ToolRefusalReason,
} from "@babojubot/contracts";
import {
  appendRunActivity,
  authenticateRun,
  findMessage,
  gateToolCall,
  insertAgentMessage,
  insertInitialApprovalRequest,
  loadRunContext,
  recordGoal,
  type ActiveRun,
  type Database,
  type ToolWrite,
} from "@babojubot/db";
import express from "express";
import type { EventHub } from "./event-hub.ts";
import { listHarnessLibrary, loadHarnessLibrary } from "./harness.ts";
import { digestRunToken } from "./run-token.ts";

/**
 * 조직 도구 HTTP. 사용자 API와 따로 실행 시도별 토큰으로만 인증하고, 조직·에이전트·실행 시도는 토큰에서만 정한다.
 * 실행 중이 아닌 실행 시도의 토큰은 읽기까지 모두 거부한다. 모든 도구는 먼저 Role·생애주기 단계 규칙(core `checkToolCall`)을
 * 통과해야 하며, 거부한 호출은 Event log에 남는다. 성공한 호출은 그 실행 시도의 공개 활동에 요약을 남긴다.
 */
export function orgToolsRouter({
  db,
  hub,
  now,
  harnessDir,
}: {
  db: Database;
  hub: EventHub;
  now: () => Date;
  harnessDir: string;
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

  /** 도구 handler 앞의 Role·단계 검사. 거부는 Event로 남기고 알린다. */
  const tool =
    (
      name: OrgToolName,
      handler: (
        req: express.Request,
        res: express.Response,
        run: ActiveRun
      ) => Promise<unknown>
    ): express.RequestHandler =>
    async (req, res) => {
      const run = res.locals.run as ActiveRun;
      const gate = await gateToolCall(db, run, name);
      if (!gate) return refuse(res, 401, "invalid_token");
      if (!gate.ok) {
        publish([gate.event]);
        return refuseByRule(res, gate.reason);
      }
      await handler(req, res, run);
    };
  const refuseByRule = (res: express.Response, reason: ToolRefusalReason) =>
    reason === "role"
      ? refuse(res, 403, "forbidden")
      : refuse(res, 409, "stage_closed");
  /** 조직 도구 쓰기 결과를 응답으로. 저장 때 단계가 바뀌어 거부됐어도 그 거부를 알린다. */
  const respondWrite = <T>(res: express.Response, result: ToolWrite<T>) => {
    switch (result.kind) {
      case "ok":
        publish(result.events);
        return res.status(201).json(result.value);
      case "run_finished":
        return refuse(res, 401, "invalid_token");
      case "refused":
        publish(result.events);
        return refuseByRule(res, result.reason);
      case "invalid":
        return refuse(res, 422, "invalid_input");
    }
  };

  router.get(
    orgToolPaths.get_run_context,
    tool("get_run_context", async (_req, res, run) => {
      const context = await loadRunContext(db, run.id);
      if (!context) return refuse(res, 401, "invalid_token");
      const recorded = await recordRead(
        run,
        "get_run_context",
        `실행 맥락 조회: 깨우기 ${context.wakeReasons.length}개, 대화 ${context.context.conversation.length}개`
      );
      if (!recorded) return refuse(res, 401, "invalid_token");
      res.json(context);
    })
  );

  router.get(
    orgToolPaths.get_message,
    tool("get_message", async (req, res, run) => {
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
    })
  );

  router.post(
    orgToolPaths.send_message,
    tool("send_message", async (req, res, run) => {
      const input = sendAgentMessageInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
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
    })
  );

  router.get(
    orgToolPaths.get_harness_library,
    tool("get_harness_library", async (_req, res, run) => {
      const library = listHarnessLibrary(await loadHarnessLibrary(harnessDir));
      const recorded = await recordRead(
        run,
        "get_harness_library",
        `하네스 라이브러리 조회: Role ${library.roles.length}개, 템플릿 ${library.templates.length}개`
      );
      if (!recorded) return refuse(res, 401, "invalid_token");
      res.json(library);
    })
  );

  router.post(
    orgToolPaths.record_goal,
    tool("record_goal", async (req, res, run) => {
      const input = recordGoalInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      respondWrite(
        res,
        await recordGoal(
          db,
          run,
          input.data,
          toolActivity("record_goal", "연구 목표와 완료 기준 기록")
        )
      );
    })
  );

  router.post(
    orgToolPaths.request_initial_approval,
    tool("request_initial_approval", async (req, res, run) => {
      const input = requestInitialApprovalInputSchema.safeParse(req.body);
      if (!input.success) return refuse(res, 422, "invalid_input");
      const heads = input.data.team.reduce((n, m) => n + m.count, 0);
      respondWrite(
        res,
        await insertInitialApprovalRequest(db, run, input.data, {
          library: await loadHarnessLibrary(harnessDir),
          source: { newId: randomUUID, now },
          activity: toolActivity(
            "request_initial_approval",
            `초기 연구 승인 요청: 작업자 ${heads}명, 템플릿 ${input.data.template}`
          ),
        })
      );
    })
  );

  // 작업(#55)과 작업자 추가(#58)는 아직 없다. 단계 규칙은 지금부터 적용한다.
  for (const name of ["create_task", "add_worker"] as const)
    router.post(
      orgToolPaths[name],
      tool(name, async (_req, res) => refuse(res, 501, "not_implemented"))
    );

  router.use((_req, res) => refuse(res, 404, "not_found"));
  return router;
}
