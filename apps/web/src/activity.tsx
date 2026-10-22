import type { Agent, Event } from "@babojubot/contracts";
import { useState } from "react";
import { Link } from "react-router";
import { useEvents } from "./api.ts";
import {
  decisionLabel,
  formatTime,
  Loading,
  LoadError,
  mapOperationLabel,
  runLabel,
  runStatusLabel,
  resultDecisionLabel,
  stageLabel,
} from "./ui.tsx";

type Described = { icon: string; title: string; detail?: string };

/** Event 하나를 화면 문장으로. 공개 기록에 있는 값만 보이며 내용을 추측하지 않는다. */
export function describeEvent(event: Event, agentName: string): Described {
  switch (event.type) {
    case "organization.created":
      return {
        icon: "🧭",
        title: `조직 “${event.payload.name}”을 만들었습니다`,
      };
    case "message.created":
      return event.payload.author === "owner"
        ? { icon: "💬", title: `사용자가 ${agentName}에게 메시지를 보냈습니다` }
        : { icon: "↩", title: `${agentName}가 Lead 대화에 답장했습니다` };
    case "run.started":
      return {
        icon: "▶",
        title: `${agentName} 실행 시도 시작`,
        detail: `깨우기 ${event.payload.wakeIds.length}개를 묶었습니다`,
      };
    case "run.activity": {
      const { activity } = event.payload;
      if (activity.source === "control_plane")
        return {
          icon: "🛠",
          title: `조직 도구 ${activity.activity.tool}`,
          detail: activity.activity.summary,
        };
      return activity.activity.type === "progress"
        ? { icon: "·", title: activity.activity.text }
        : {
            icon: "⚙",
            title: `도구 ${activity.activity.tool}`,
            detail: activity.activity.summary,
          };
    }
    case "run.finished":
      return {
        icon: event.payload.stopReason === "completed" ? "■" : "⚠",
        title: `${agentName} 실행 시도 ${runStatusLabel[event.payload.stopReason]}`,
        detail: event.payload.error ?? event.payload.summary ?? undefined,
      };
    case "organization.goal_recorded":
      return {
        icon: "🎯",
        title: `${agentName}가 연구 목표와 완료 기준을 기록했습니다 → ${stageLabel[event.payload.stage]}`,
        detail: `목표: ${event.payload.goal}\n완료 기준: ${event.payload.completionCriteria}`,
      };
    case "organization.approval_policy_changed":
      return {
        icon: "⚙",
        title: `사용자가 승인 정책 “작업자 추가”를 ${event.payload.policy.addWorker ? "켰습니다" : "껐습니다"}`,
      };
    case "worker.added":
      return {
        icon: "➕",
        title: `${agentName}가 작업자를 추가했습니다`,
        detail: `Role: ${event.payload.role}`,
      };
    case "approval.requested":
      return {
        icon: "📝",
        title:
          event.payload.kind === "add_worker"
            ? `${agentName}가 작업자 추가 승인을 요청했습니다`
            : `${agentName}가 초기 연구 승인을 요청했습니다 → ${stageLabel[event.payload.stage]}`,
      };
    case "approval.decided":
      return {
        icon: event.payload.decision === "approve" ? "✅" : "↺",
        title:
          event.payload.kind === "add_worker"
            ? `사용자가 작업자 추가 승인 요청을 ${decisionLabel[event.payload.decision]}했습니다`
            : `사용자가 초기 연구 승인 요청을 ${decisionLabel[event.payload.decision]}했습니다 → ${stageLabel[event.payload.stage]}`,
        detail:
          [
            event.payload.note && `사유: ${event.payload.note}`,
            event.payload.createdAgentIds.length &&
              `작업자 ${event.payload.createdAgentIds.length}명 생성`,
          ]
            .filter(Boolean)
            .join("\n") || undefined,
      };
    case "result.submitted":
      return {
        icon: "📦",
        title: `${agentName}가 결과를 제출했습니다 → ${stageLabel[event.payload.stage]}`,
        detail: `근거 산출물 ${event.payload.artifactIds.length}개`,
      };
    case "result.decided":
      return {
        icon: event.payload.decision === "complete" ? "🏁" : "↺",
        title: `사용자가 제출된 결과를 ${resultDecisionLabel[event.payload.decision]}했습니다 → ${stageLabel[event.payload.stage]}`,
        detail:
          [
            event.payload.note && `의견: ${event.payload.note}`,
            event.payload.wokenAgentId && "Lead를 깨웠습니다",
          ]
            .filter(Boolean)
            .join("\n") || undefined,
      };
    case "task.created":
      return {
        icon: "📌",
        title: `${agentName}가 작업을 만들었습니다`,
        detail: event.payload.parentTaskId ? "하위 작업" : undefined,
      };
    case "task.started":
      return { icon: "▶", title: `${agentName}가 작업에 착수했습니다` };
    case "task.completed":
      return {
        icon: "☑",
        title: `${agentName}가 작업을 완료했습니다`,
        detail: "자기 보고와 함께 완료했습니다. 검증된 결과가 아닙니다.",
      };
    case "task.commented":
      return event.payload.author === "owner"
        ? { icon: "💬", title: "사용자가 작업에 댓글을 남겼습니다" }
        : { icon: "↩", title: `${agentName}가 작업에 댓글을 남겼습니다` };
    case "artifact.recorded":
      return { icon: "📄", title: `${agentName}가 산출물을 기록했습니다` };
    case "agent_to_agent_message.created":
      return {
        icon: "✉",
        title: `${agentName}가 같은 조직 에이전트에게 메시지를 보냈습니다`,
      };
    case "research_map.edited":
      return {
        icon: "🗺",
        title:
          event.payload.author === "owner"
            ? "사용자가 연구 지도를 편집했습니다"
            : `${agentName}가 연구 지도를 편집했습니다`,
        detail: `${mapOperationLabel[event.payload.operation]}${event.payload.wokenAgentId ? " · Lead를 깨웠습니다" : ""}`,
      };
    case "tool.refused":
      return {
        icon: "⛔",
        title: `조직 도구 ${event.payload.tool} 거부`,
        detail:
          event.payload.reason === "stage"
            ? `${stageLabel[event.payload.stage]} 단계에서는 쓸 수 없습니다`
            : `${agentName}의 역할로는 쓸 수 없습니다`,
      };
  }
}

const runIdOf = (event: Event) =>
  "runId" in event.payload ? (event.payload.runId ?? undefined) : undefined;
const agentIdOf = (event: Event) =>
  "agentId" in event.payload ? event.payload.agentId : undefined;

export function EventRow({
  event,
  orgId,
  agents,
  showRunLink = true,
}: {
  event: Event;
  orgId: string;
  agents: Agent[];
  showRunLink?: boolean;
}) {
  const agentId = agentIdOf(event);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? "에이전트";
  const { icon, title, detail } = describeEvent(event, agentName);
  const runId = runIdOf(event);
  return (
    <li className="flex gap-3 px-4 py-2.5 text-sm" data-event-type={event.type}>
      <span className="mt-0.5 w-5 shrink-0 text-center text-slate-400">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-slate-800">{title}</div>
        {detail && (
          <div className="mt-0.5 text-xs break-words whitespace-pre-wrap text-slate-500">
            {detail}
          </div>
        )}
        {"artifactId" in event.payload ? (
          <Link
            to={`/orgs/${orgId}/artifacts/${event.payload.artifactId}`}
            className="mt-0.5 mr-3 inline-block text-xs text-brand-600 hover:underline"
          >
            산출물 보기
          </Link>
        ) : (
          "taskId" in event.payload && (
            <Link
              to={`/orgs/${orgId}/tasks/${event.payload.taskId}`}
              className="mt-0.5 mr-3 inline-block text-xs text-brand-600 hover:underline"
            >
              작업 보기
            </Link>
          )
        )}
        {"approvalId" in event.payload && (
          <Link
            to={`/orgs/${orgId}/approvals/${event.payload.approvalId}`}
            className="mt-0.5 mr-3 inline-block text-xs text-brand-600 hover:underline"
          >
            승인 요청 보기
          </Link>
        )}
        {showRunLink && runId && (
          <Link
            to={`/orgs/${orgId}/runs/${runId}`}
            className="mt-0.5 inline-block text-xs text-brand-600 hover:underline"
          >
            {runLabel(runId)}
          </Link>
        )}
      </div>
      <time
        dateTime={event.createdAt}
        className="shrink-0 text-xs text-slate-400 tabular-nums"
      >
        {formatTime(event.createdAt)}
      </time>
    </li>
  );
}

/** 조직 › 활동: 실행 시도·도구 호출 요약·메시지·상태 변화 stream. 최근 것이 위. */
export function ActivityScreen({
  orgId,
  agents,
}: {
  orgId: string;
  agents: Agent[];
}) {
  const [agentId, setAgentId] = useState<string>("");
  const events = useEvents(orgId, agentId || undefined);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">활동</h1>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-500">
          에이전트
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded-xl bg-white px-2 py-1.5 text-sm ring-1 ring-slate-200"
          >
            <option value="">전체</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <LoadError what="활동" onRetry={() => void events.refetch()} />
      ) : !events.data.length ? (
        <div className="card p-6 text-sm text-slate-500">
          아직 활동이 없습니다.
        </div>
      ) : (
        <ol className="card divide-y divide-slate-100" aria-label="활동 stream">
          {[...events.data].reverse().map((e) => (
            <EventRow key={e.id} event={e} orgId={orgId} agents={agents} />
          ))}
        </ol>
      )}
    </>
  );
}
