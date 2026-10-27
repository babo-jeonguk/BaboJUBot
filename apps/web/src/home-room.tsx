// 홈의 방 하나 = 연구 조직 하나. Lead는 왼쪽 큰 책상, 작업자는 들어온 순서로 고정 자리에 앉는다(한 줄에 여섯까지).
// 쉬는 에이전트는 라운지 소파로 가고 책상에는 이름표와 빈 의자만 남는다. 자리는 상태를 보지 않으므로 움직이지 않는다.
import type { OverviewAgent } from "@babojubot/contracts";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { AgentFace, faceColorStyle } from "./agent-face.tsx";
import {
  columnsOf,
  isWideRoom,
  placeOf,
  relativeTime,
  roomModeOf,
  workingCount,
  type HomeRoom,
  type Place,
  type RoomMode,
  type Screen,
} from "./home-model.ts";
import { abbr, avatarStyle, formatTime, hue, StageBadge, Tip } from "./ui.tsx";

/** 자리 크기. 작은 화면은 한 줄에 Lead + 작업자 셋이 들어가게 줄인다. */
const dims = {
  worker: { w: 90, face: 48, faceX: 6, monW: 34, monH: 24, front: 28 },
  lead: { w: 140, face: 60, faceX: 12, monW: 46, monH: 30, front: 30 },
  workerSmall: { w: 68, face: 36, faceX: 3, monW: 26, monH: 18, front: 24 },
  leadSmall: { w: 100, face: 44, faceX: 7, monW: 34, monH: 23, front: 26 },
};
type Dims = (typeof dims)["worker"];

export function Room({
  room: { org, attention },
  small,
  now,
}: {
  room: HomeRoom;
  small: boolean;
  now: number;
}) {
  const mode = roomModeOf(org);
  const [lead, ...workers] = org.agents;
  const places = new Map(org.agents.map((a) => [a.id, placeOf(a, org)]));
  const resting = org.agents.filter((a) => places.get(a.id)!.lounge);
  const h = hue(org.organizationId);
  const seat = small ? dims.workerSmall : dims.worker;
  const leadSeat = small ? dims.leadSmall : dims.lead;
  const orgPath = `/orgs/${org.organizationId}`;

  return (
    <section
      className="room"
      aria-label={org.name}
      data-org-id={org.organizationId}
      data-mode={mode}
      data-attention={(mode !== "closed" && attention > 0) || undefined}
      data-wide={isWideRoom(org) || undefined}
      style={
        {
          "--wall": `hsl(${h} 70% 95%)`,
          "--wall-deep": `hsl(${h} 45% 88%)`,
          "--wall-base": `hsl(${h} 30% 80%)`,
        } as CSSProperties
      }
    >
      <Link to={orgPath} className="room-head">
        <span
          className="room-avatar"
          style={avatarStyle(org.organizationId)}
          aria-hidden
        >
          {abbr(org.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="room-name truncate font-semibold text-slate-900">
              {org.name}
            </span>
            <StageBadge stage={org.stage} />
            {attention > 0 && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 tabular-nums"
                data-testid="organization-attention"
              >
                주의 {attention}
              </span>
            )}
          </span>
          {org.goal && (
            <span className="mt-0.5 block truncate text-[13px] text-slate-500">
              {org.goal}
            </span>
          )}
        </span>
        <span className="room-meta">
          <Headcount
            working={workingCount(org)}
            total={org.agents.length}
            closed={mode === "closed"}
          />
          {org.lastActivityAt && (
            <time
              dateTime={org.lastActivityAt}
              title={`마지막 활동 ${formatTime(org.lastActivityAt)}`}
              className="whitespace-nowrap text-slate-400 tabular-nums"
              data-testid="organization-last-activity"
            >
              {relativeTime(org.lastActivityAt, now)}
            </time>
          )}
        </span>
      </Link>
      <div className="room-scene">
        <Wall night={mode !== "active"} />
        <div className="room-floor">
          {lead && (
            <div className="room-lead">
              <Seat
                orgPath={orgPath}
                agent={lead}
                place={places.get(lead.id)!}
                mode={mode}
                d={leadSeat}
              />
            </div>
          )}
          {workers.length > 0 && (
            <div
              className="room-desks"
              style={{
                // 셋까지는 한 줄을 지키고(모자라면 라운지가 아래로 내려간다), 그보다 많으면 고르게 줄을 나눈다.
                minWidth: Math.min(workers.length, 3) * seat.w,
                maxWidth: columnsOf(workers.length) * seat.w,
              }}
            >
              {workers.map((a) => (
                <Seat
                  key={a.id}
                  orgPath={orgPath}
                  agent={a}
                  place={places.get(a.id)!}
                  mode={mode}
                  d={seat}
                />
              ))}
            </div>
          )}
          {mode === "active" && (
            <Lounge orgPath={orgPath} agents={resting} face={small ? 34 : 38} />
          )}
        </div>
      </div>
    </section>
  );
}

function Headcount({
  working,
  total,
  closed,
}: {
  working: number;
  total: number;
  closed: boolean;
}) {
  if (closed)
    return (
      <span
        className="text-slate-400 tabular-nums"
        data-testid="room-headcount"
      >
        {total}명
      </span>
    );
  return (
    <span
      className="flex items-center gap-1.5 whitespace-nowrap tabular-nums"
      data-testid="room-headcount"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${working ? "home-pulse bg-brand-500" : "bg-slate-300"}`}
      />
      <span
        className={working ? "font-medium text-brand-700" : "text-slate-500"}
      >
        작업 중 {working}
      </span>
      <span className="text-slate-400">/ {total}명</span>
    </span>
  );
}

// ---------- 벽 ----------

function Wall({ night }: { night: boolean }) {
  return (
    <div className="wall" aria-hidden>
      <span className="wall-window" data-night={night || undefined}>
        <span className="wall-sun" />
      </span>
      <span className="wall-board">
        <i />
        <i />
        <i />
      </span>
      <span className="wall-clock" />
      <span
        className="wall-window wall-window-2"
        data-night={night || undefined}
      >
        <span className="wall-sun" />
      </span>
    </div>
  );
}

// ---------- 자리 ----------

function Seat({
  orgPath,
  agent,
  place,
  mode,
  d,
}: {
  orgPath: string;
  agent: OverviewAgent;
  place: Place;
  mode: RoomMode;
  d: Dims;
}) {
  const { pose, screen, mood, state, saying, asking, lounge } = place;
  const lead = agent.role === "lead";
  const color = faceColorStyle[agent.appearance.color];
  const deskTop = 6 + d.front + 7;
  const faceBottom =
    pose === "standing"
      ? deskTop + 8
      : pose === "doze"
        ? deskTop - 10
        : deskTop - Math.round(d.face * 0.09);
  const chairW = Math.round(d.face * 0.92);
  const seed = hashOf(agent.id);
  const style = {
    width: d.w,
    height: deskTop + d.face + 14,
    "--stagger": `-${(seed % 1100) / 1000}s`,
    "--bob": `${1 + (seed % 5) / 20}s`,
  } as CSSProperties;
  const inner = (
    <>
      {lead && <span className="seat-rug" aria-hidden />}
      <span
        className="seat-chair"
        aria-hidden
        style={
          {
            left: d.faceX + (d.face - chairW) / 2,
            width: chairW,
            bottom: deskTop - 12,
            height: Math.round(d.face * 0.95),
            "--seat-color": color.fill,
          } as CSSProperties
        }
      />
      {pose !== "away" && (
        <span
          className="seat-face"
          style={{ left: d.faceX, bottom: faceBottom }}
        >
          <AgentFace
            appearance={agent.appearance}
            mood={mood}
            size={d.face}
            seed={agent.id}
            track={mode === "active"}
          />
        </span>
      )}
      {asking && (
        <span
          className="ask"
          data-testid="decision-bubble"
          style={{
            left: Math.max(0, d.faceX + d.face / 2 - 16),
            bottom: faceBottom + d.face - 2,
          }}
        >
          <b aria-hidden>?</b>
          {asking}
        </span>
      )}
      <span className="seat-desk" aria-hidden style={{ height: d.front }}>
        <span className="seat-nameplate">
          {lead && <span className="text-brand-500">★ </span>}
          {lead ? "리드" : agent.name}
        </span>
      </span>
      <Monitor
        kind={screen}
        w={d.monW}
        h={d.monH}
        seed={seed}
        style={{ right: lead ? 12 : 7, bottom: deskTop - 1 }}
      />
    </>
  );
  const to = `${orgPath}/agents/${agent.id}`;
  const data = {
    "data-agent-id": agent.id,
    "data-pose": pose,
    "data-lead": lead || undefined,
  };
  // 라운지에 간 에이전트의 빈 책상: 누르면 같은 화면으로 가지만, 접근 이름은 소파의 캐릭터 하나만 가진다.
  if (lounge)
    return (
      <Link
        to={to}
        className="seat"
        style={style}
        tabIndex={-1}
        aria-hidden
        data-empty
        {...data}
      >
        {inner}
      </Link>
    );
  const link = (
    <Link
      to={to}
      className="seat"
      style={style}
      aria-label={`${agent.name} · ${state}`}
      {...data}
    >
      {inner}
    </Link>
  );
  // 늘 떠 있는 물음표가 있거나 끝난 방이면 hover 말풍선을 따로 띄우지 않는다.
  return asking || mode === "closed" ? link : <Say text={saying}>{link}</Say>;
}

/** hover·keyboard focus 때 머리 위 말풍선. */
function Say({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tip tone="speech" content={text}>
      {children}
    </Tip>
  );
}

const lineColors = ["#8b92ff", "#7fe0b8", "#ffd27a", "#ff9fb5", "#aab4c6"];

function Monitor({
  kind,
  w,
  h,
  seed,
  style,
}: {
  kind: Screen;
  w: number;
  h: number;
  seed: number;
  style: CSSProperties;
}) {
  const lines = Array.from({ length: 8 }, (_, i) => {
    const r = hashOf(`${seed}-${i}`);
    return {
      indent: (r % 3) * 3,
      width: 30 + (r % 55),
      color: lineColors[r % lineColors.length]!,
    };
  });
  return (
    <span
      className="mon"
      data-kind={kind}
      style={{ ...style, width: w }}
      aria-hidden
    >
      <span className="mon-screen" style={{ height: h }}>
        {kind === "code" && (
          <span
            className="mon-code"
            style={{ animationDelay: `-${(seed % 30) / 10}s` }}
          >
            {[...lines, ...lines].map((l, i) => (
              <i
                key={i}
                style={{
                  marginLeft: `${l.indent}px`,
                  width: `${l.width}%`,
                  background: l.color,
                }}
              />
            ))}
          </span>
        )}
        {kind === "doc" && (
          <span className="mon-doc">
            <i style={{ width: "60%" }} />
            <i />
            <i style={{ width: "80%" }} />
            <i style={{ width: "45%" }} />
          </span>
        )}
        {kind === "error" && <span className="mon-error">✕</span>}
      </span>
      <span className="mon-neck" />
      <span className="mon-base" />
    </span>
  );
}

// ---------- 라운지 ----------

const perSofa = 3;

function Lounge({
  orgPath,
  agents,
  face,
}: {
  orgPath: string;
  agents: OverviewAgent[];
  face: number;
}) {
  const sofas = Math.max(1, Math.ceil(agents.length / perSofa));
  return (
    <div className="room-lounge" role="group" aria-label="라운지">
      <span className="lounge-rug" aria-hidden />
      <div className="lounge-sofas">
        {Array.from({ length: sofas }, (_, s) => (
          <div
            className="sofa"
            key={s}
            style={{ "--face": `${face}px` } as CSSProperties}
          >
            <span className="sofa-back" aria-hidden />
            <div className="sofa-spots">
              {Array.from({ length: perSofa }, (_, i) => {
                const a = agents[s * perSofa + i];
                return (
                  <span className="sofa-spot" key={a?.id ?? i}>
                    {a && (
                      <Say text="쉬는 중">
                        <Link
                          to={`${orgPath}/agents/${a.id}`}
                          className="sofa-sitter"
                          aria-label={`${a.name} · 쉬는 중`}
                          data-agent-id={a.id}
                          style={
                            {
                              "--stagger": `-${(hashOf(a.id) % 900) / 300}s`,
                            } as CSSProperties
                          }
                        >
                          <AgentFace
                            appearance={a.appearance}
                            mood="idle"
                            size={face}
                            seed={a.id}
                          />
                        </Link>
                      </Say>
                    )}
                  </span>
                );
              })}
            </div>
            <span className="sofa-seat" aria-hidden />
            <span className="sofa-arm sofa-arm-l" aria-hidden />
            <span className="sofa-arm sofa-arm-r" aria-hidden />
          </div>
        ))}
      </div>
      <span className="lounge-plant" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function hashOf(seed: string) {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
