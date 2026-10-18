import type { Agent, Event } from "@babojubot/contracts";
import { useState } from "react";
import { Link } from "react-router";
import { useEvents } from "./api.ts";
import {
  formatTime,
  Loading,
  LoadError,
  runLabel,
  runStatusLabel,
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
