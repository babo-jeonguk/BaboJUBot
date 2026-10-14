// PROTOTYPE (#50) — throwaway. Shared mock store + screen bodies. Layout (shell, nav, Inbox
// arrangement, Home) lives in each variant; only the content inside a destination is shared.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import {
  buildInbox,
  buildOrgs,
  inProgress,
  needsAttention,
  ORG_TABS,
  SCENARIOS,
  type Decision,
  type InboxItem,
  type Org,
  type Scenario,
  type Stage,
} from "./data";

// ---------- store ----------

type Toast = { id: number; text: string; tone: "ok" | "error" };
type Store = {
  scenario: Scenario;
  status: "loading" | "error" | "ok";
  orgs: Org[];
  inbox: InboxItem[];
  orgById: (id?: string) => Org | undefined;
  setRead: (id: string, read: boolean) => void;
  setArchived: (id: string, archived: boolean) => void;
  decide: (id: string, outcome: Decision) => void;
  togglePolicy: (orgId: string) => void;
  policy: Record<string, boolean>;
  toasts: Toast[];
  notify: (text: string, tone?: Toast["tone"]) => void;
};
const Ctx = createContext<Store | null>(null);
export const useStore = () => useContext(Ctx)!;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [sp] = useSearchParams();
  const raw = sp.get("data") as Scenario | null;
  const scenario: Scenario = raw && SCENARIOS.includes(raw) ? raw : "normal";
  const fail = sp.get("fail") === "1";
  const orgs = useMemo(() => buildOrgs(scenario), [scenario]);
  const [inbox, setInbox] = useState<InboxItem[]>(() => buildInbox(orgs));
  const [policy, setPolicy] = useState<Record<string, boolean>>({ "llm-eval": true });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(0);
  // Reset inbox when the scenario changes (render-phase, so it can't clobber child effects).
  const [seed, setSeed] = useState(orgs);
  if (seed !== orgs) {
    setSeed(orgs);
    setInbox(buildInbox(orgs));
  }

  const patch = (id: string, p: Partial<InboxItem>) =>
    setInbox((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const notify = (text: string, tone: Toast["tone"] = "ok") => {
    const id = ++nextToast.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  };

  const store: Store = {
    scenario,
    status: scenario === "loading" ? "loading" : scenario === "error" ? "error" : "ok",
    orgs,
    inbox,
    orgById: (id) => orgs.find((o) => o.id === id),
    setRead: (id, read) => patch(id, { read }),
    setArchived: (id, archived) => {
      patch(id, { archived });
      notify(archived ? "보관했습니다 · 결정 상태는 그대로입니다" : "보관을 해제했습니다");
    },
    decide: (id, outcome) => {
      patch(id, { decision: "전송 중", read: true });
      setTimeout(() => {
        patch(id, { decision: fail ? "전송 실패" : outcome });
        notify(fail ? "결정을 반영하지 못했습니다 · 다시 시도하세요" : `${outcome} · 제어 명령 기록 (stub)`, fail ? "error" : "ok");
      }, 900);
    },
    togglePolicy: (orgId) => setPolicy((p) => ({ ...p, [orgId]: !p[orgId] })),
    policy,
    toasts,
    notify,
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function Toaster() {
  const { toasts } = useStore();
  return (
    <div className="pointer-events-none fixed right-4 bottom-20 z-[90] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`animate-toast-in flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm shadow-pop ring-1 ${t.tone === "error" ? "bg-rose-600 text-white ring-rose-700" : "bg-slate-900 text-white ring-black/10"}`}
        >
          <span>{t.tone === "error" ? "⚠" : "✓"}</span>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useInboxCounts(orgId?: string) {
  const { inbox } = useStore();
  const xs = orgId ? inbox.filter((i) => i.orgId === orgId) : inbox;
  return {
    attention: xs.filter(needsAttention).length,
    unread: xs.filter((i) => !i.read && !i.archived).length,
    working: xs.filter(inProgress).length,
  };
}

// ---------- routing helpers ----------

/** Link that keeps the prototype's ?variant/&data/&fail params. */
export function useKeep() {
  const [sp] = useSearchParams();
  return (to: string) => {
    const keep = new URLSearchParams();
    for (const k of ["variant", "data", "fail"]) {
      const v = sp.get(k);
      if (v) keep.set(k, v);
    }
    const q = keep.toString();
    return q ? `${to}${to.includes("?") ? "&" : "?"}${q}` : to;
  };
}
export function L({ to, ...rest }: { to: string } & Omit<React.ComponentProps<typeof Link>, "to">) {
  const keep = useKeep();
  return <Link to={keep(to)} {...rest} />;
}

export function useRouteInfo() {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/orgs\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
  return {
    pathname,
    orgId: m?.[1],
    tab: m?.[2] === "runs" ? undefined : (m?.[2] ?? "dashboard"),
    runId: m?.[2] === "runs" ? m?.[3] : undefined,
    inboxId: pathname.match(/^\/inbox\/([^/]+)/)?.[1],
    global: pathname === "/" ? "home" : pathname.startsWith("/inbox") ? "inbox" : pathname.startsWith("/settings") ? "settings" : undefined,
  };
}

// ---------- content width tiers ----------
// 정보가 많은 화면은 전체 폭, 읽고 쓰는 화면은 좁게. 좁은 창에서는 모두 창 폭을 따른다.

export type Width = "reading" | "standard" | "full";
export const WIDTH_LABEL: Record<Width, string> = { reading: "좁게 768px", standard: "중간 1024px", full: "전체 폭" };
const WIDTH_CLASS: Record<Width, string> = { reading: "max-w-3xl", standard: "max-w-5xl", full: "max-w-none" };
const TAB_WIDTH: Record<string, Width> = {
  dashboard: "full",
  activity: "full",
  map: "full",
  agents: "full",
  tasks: "standard",
  review: "standard",
  chat: "reading",
  settings: "reading",
};
export function widthFor(r: ReturnType<typeof useRouteInfo>): Width {
  if (r.runId) return "reading";
  if (r.orgId) return TAB_WIDTH[r.tab ?? ""] ?? "standard";
  if (r.inboxId) return "standard";
  if (r.global === "settings") return "reading";
  return "full";
}
export function Page({ width, children, className = "" }: { width: Width; children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full px-4 py-5 sm:px-6 ${WIDTH_CLASS[width]} ${className}`}>{children}</div>;
}

// ---------- small pieces ----------

const stageStyle: Record<Stage, [string, string]> = {
  "목표 설정": ["bg-sky-50 text-sky-700", "bg-sky-500"],
  "계획 수립": ["bg-brand-50 text-brand-700", "bg-brand-500"],
  "승인 대기": ["bg-amber-50 text-amber-800", "bg-amber-500"],
  "연구 진행": ["bg-emerald-50 text-emerald-700", "bg-emerald-500"],
  일시정지: ["bg-slate-100 text-slate-600", "bg-slate-400"],
  "결과 검토 중": ["bg-fuchsia-50 text-fuchsia-700", "bg-fuchsia-500"],
  "최종 완료": ["bg-slate-50 text-slate-500", "bg-slate-300"],
  중단됨: ["bg-rose-50 text-rose-700", "bg-rose-400"],
};
/** Stage is always readable text, never colour only. */
export function StageBadge({ stage, short }: { stage: Stage; short?: boolean }) {
  const [c, dot] = stageStyle[stage];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${c}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {short ? stage.replace(" 중", "").replace("최종 ", "") : stage}
    </span>
  );
}

export const liveRuns = (o: Org) => o.runs.filter((r) => r.status === "실행 중").length;

export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-flex h-2 w-2 ${className}`}>
      <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-60" />
      <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

export function Count({ n, tone = "zinc", label }: { n: number; tone?: "zinc" | "amber" | "sky"; label?: string }) {
  if (!n) return null;
  const c = { zinc: "bg-slate-200 text-slate-700", amber: "bg-amber-500 text-white shadow-sm shadow-amber-500/40", sky: "bg-brand-600 text-white" }[tone];
  return (
    <span title={label} className={`animate-pop-in inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${c}`}>
      {n}
    </span>
  );
}

/** D08: loading / error / empty are never shown as "0". */
export function DataGate({ children, empty }: { children: ReactNode; empty?: ReactNode }) {
  const { status, orgs } = useStore();
  const keep = useKeep();
  if (status === "loading")
    return (
      <div className="space-y-2 p-4" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-xl bg-slate-200/70" />
        ))}
        <p className="text-xs text-slate-400">불러오는 중… (숫자를 0으로 표시하지 않음)</p>
      </div>
    );
  if (status === "error")
    return (
      <div className="animate-fade-up m-4 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">
        조직 목록을 불러오지 못했습니다. 조직이 없다는 뜻이 아닙니다.{" "}
        <Link className="font-semibold underline underline-offset-2" to={keep("/").replace(/data=error&?/, "")}>
          다시 시도
        </Link>
      </div>
    );
  if (!orgs.length && empty) return <>{empty}</>;
  return <>{children}</>;
}

export function NoOrgs() {
  return (
    <div className="card animate-fade-up mx-auto mt-10 max-w-md p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">🧭</div>
      <div className="font-semibold">아직 연구 조직이 없습니다</div>
      <p className="mt-1 text-sm text-slate-500">연구 목표 하나가 조직 하나가 됩니다.</p>
      <button className="btn-primary mt-4">＋ 새 연구 조직</button>
    </div>
  );
}

export function NotFound({ what }: { what: string }) {
  return (
    <div className="card animate-fade-up m-4 max-w-lg p-6 text-sm">
      <div className="font-semibold">찾을 수 없는 {what}</div>
      <p className="mt-1 text-slate-500">다른 조직으로 자동 이동하지 않습니다. 직접 고르세요.</p>
      <L to="/" className="btn-soft mt-4">
        홈으로
      </L>
    </div>
  );
}

export function OrgControls({ org, compact }: { org: Org; compact?: boolean }) {
  const { notify } = useStore();
  if (org.stage === "최종 완료" || org.stage === "중단됨") return null;
  const stub = (what: string) => notify(`${what} · 제어 명령 stub`);
  return (
    <div className="flex shrink-0 gap-1.5">
      {org.stage === "일시정지" ? (
        <button className="btn-soft px-2.5 py-1 text-xs" onClick={() => stub("재개")}>
          ▶ 재개
        </button>
      ) : (
        <button className="btn-soft px-2.5 py-1 text-xs" onClick={() => stub("일시정지")}>
          ❚❚ 일시정지
        </button>
      )}
      {!compact && (
        <button className="btn-danger px-2.5 py-1 text-xs" onClick={() => stub("중단")}>
          ■ 중단
        </button>
      )}
    </div>
  );
}

// ---------- org destination bodies ----------

export function OrgBody({ org }: { org: Org }) {
  const r = useRouteInfo();
  const body = (() => {
    if (r.runId) return <RunDetail org={org} runId={r.runId} />;
    switch (r.tab) {
      case "dashboard":
        return <OrgDashboard org={org} />;
      case "chat":
        return <LeadChat org={org} />;
      case "activity":
        return <ActivityStream org={org} />;
      case "tasks":
        return <Tasks org={org} />;
      case "map":
        return <MapStub org={org} />;
      case "agents":
        return <Agents org={org} />;
      case "review":
        return <Review org={org} />;
      case "settings":
        return <OrgSettings org={org} />;
      default:
        return <NotFound what="화면" />;
    }
  })();
  return (
    <Page width={widthFor(r)} className={r.tab === "chat" && !r.runId ? "flex flex-1 flex-col" : ""}>
      {body}
    </Page>
  );
}

function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      {title && <h3 className="mb-3 text-[13px] font-semibold text-slate-500">{title}</h3>}
      {children}
    </section>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-[13px] text-slate-500">
        {label}
        {accent}
      </div>
      <div className="mt-1 text-[28px] leading-none font-semibold text-slate-900">{value}</div>
    </div>
  );
}

/** Single series, one hue; today emphasised in the darker validated step. Hover = per-bar tooltip. */
function DailyRunsChart({ daily }: { daily: number[] }) {
  const max = Math.max(...daily, 1);
  return (
    <figure>
      <div className="flex h-32 items-end gap-[2px] border-b border-slate-200">
        {daily.map((d, i) => {
          const today = i === daily.length - 1;
          const ago = daily.length - 1 - i;
          return (
            <div key={i} className="group relative flex h-full flex-1 cursor-default items-end">
              <div
                className={`w-full rounded-t-[4px] transition-[filter,height] duration-300 group-hover:brightness-90 ${today ? "bg-brand-700" : "bg-brand-400"}`}
                style={{ height: `${Math.max((d / max) * 100, d ? 3 : 0)}%` }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-lg bg-slate-900 px-2 py-1 text-[11px] whitespace-nowrap text-white opacity-0 shadow-lift transition group-hover:opacity-100">
                {today ? "오늘" : `${ago}일 전`} · {d}회
              </div>
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-slate-400">
        <span>14일 전</span>
        <span className="font-medium text-slate-600">오늘 {daily[daily.length - 1]}회</span>
      </figcaption>
    </figure>
  );
}

function OrgDashboard({ org }: { org: Org }) {
  const counts = useInboxCounts(org.id);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="grid grid-cols-2 gap-3 lg:col-span-3 lg:grid-cols-4">
        <StatTile label="실행 중 실행 시도" value={liveRuns(org)} accent={liveRuns(org) > 0 && <LiveDot />} />
        <StatTile label="진행 중 작업" value={org.tasks.filter((t) => t.status === "진행 중").length} />
        <StatTile label="주의 필요 (이 조직)" value={counts.attention} />
        <StatTile label="산출물" value={org.artifacts} />
      </div>
      <Card title="최근 14일 실행 시도" className="lg:col-span-2">
        <DailyRunsChart daily={org.daily} />
      </Card>
      <Card title="실행 중인 에이전트">
        {liveRuns(org) ? (
          <ul className="space-y-1 text-sm">
            {org.runs
              .filter((r) => r.status === "실행 중")
              .map((r) => (
                <li key={r.id}>
                  <L className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-slate-50" to={`/orgs/${org.id}/runs/${r.id}`}>
                    <LiveDot />
                    <span className="font-medium">{r.agent}</span>
                    <span className="ml-auto text-xs text-slate-400">
                      {r.wake} · {r.started}
                    </span>
                  </L>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">지금 실행 중인 실행 시도 없음</p>
        )}
      </Card>
      <Card title="연구 목표">
        <p className="text-sm leading-relaxed">{org.goal}</p>
      </Card>
      <Card title="최근 활동" className="lg:col-span-2">
        <ActivityList org={org} limit={4} />
      </Card>
    </div>
  );
}

function ActivityList({ org, limit, agent }: { org: Org; limit?: number; agent?: string }) {
  const xs = org.activity.filter((a) => !agent || a.agent === agent).slice(0, limit);
  return (
    <ul className="text-sm">
      {xs.map((a) => (
        <li key={a.id} className="flex gap-3 border-b border-slate-100 py-2.5 last:border-0">
          <span className="w-16 shrink-0 text-xs text-slate-400">{a.at}</span>
          <span className="w-24 shrink-0 truncate font-medium">{a.agent}</span>
          <span className="min-w-0 flex-1 text-slate-600">
            {a.text}{" "}
            {a.runId && (
              <L className="text-xs font-medium text-brand-600 hover:underline" to={`/orgs/${org.id}/runs/${a.runId}`}>
                실행 시도 {a.runId.split("-").pop()} →
              </L>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityStream({ org }: { org: Org }) {
  const [agent, setAgent] = useState("");
  const agents = [...new Set(org.activity.map((a) => a.agent))];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {["", ...agents].map((a) => (
          <button key={a || "all"} onClick={() => setAgent(a)} className={`chip ${agent === a ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
            {a || "모든 에이전트"}
          </button>
        ))}
      </div>
      <Card>
        <ActivityList org={org} agent={agent || undefined} />
      </Card>
      <Card title="실행 시도">
        <ul className="text-sm">
          {org.runs.map((r) => (
            <li key={r.id}>
              <L className="flex gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50" to={`/orgs/${org.id}/runs/${r.id}`}>
                <span className="w-36 shrink-0 font-medium text-brand-600">{r.id}</span>
                <span className="w-28 shrink-0">{r.agent}</span>
                <span className={r.status === "실패" ? "font-medium text-rose-600" : r.status === "실행 중" ? "text-emerald-600" : ""}>{r.status}</span>
                <span className="truncate text-slate-400">{r.summary}</span>
              </L>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LeadChat({ org }: { org: Org }) {
  const [msgs, setMsgs] = useState(org.chat);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const closed = org.stage === "최종 완료" || org.stage === "중단됨";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false); // don't jump on first open
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs.length, typing]);
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3">
        {msgs.map((m, i) => (
          <div key={i} className={`animate-fade-up flex ${m.from === "사용자" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${m.from === "사용자" ? "rounded-br-md bg-brand-600 text-white shadow-sm shadow-brand-600/25" : "card rounded-bl-md"}`}>
              <div className={`mb-0.5 text-[11px] ${m.from === "사용자" ? "text-white/70" : "text-slate-400"}`}>
                {m.from} · {m.at}
              </div>
              {m.text}
            </div>
          </div>
        ))}
        {typing && (
          <div className="animate-fade-up card inline-flex gap-1 rounded-2xl rounded-bl-md px-4 py-3">
            {[0, 150, 300].map((d) => (
              <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
            ))}
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="card sticky bottom-20 mt-4 p-3 transition focus-within:shadow-lift focus-within:ring-brand-200"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setMsgs((x) => [...x, { from: "사용자", text: draft, at: "방금" }]);
          setDraft("");
          setTyping(true);
          setTimeout(() => {
            setTyping(false);
            setMsgs((x) => [...x, { from: "Lead", text: "확인했습니다. 다음 실행 시도에 반영하겠습니다. (가짜 응답)", at: "방금" }]);
          }, 1400);
        }}
      >
        <div className="mb-1 text-[11px] text-slate-400">
          쓰기 대상 · <b className="font-medium text-slate-700">{org.name}</b>의 Research Lead
        </div>
        <textarea
          disabled={closed}
          className="w-full resize-none bg-transparent p-1 text-[15px] outline-none placeholder:text-slate-400"
          rows={2}
          placeholder={closed ? "종료된 조직입니다 (읽기 전용)" : "Lead에게 메시지…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex items-center justify-between text-xs">
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-500">
            <input type="checkbox" className="accent-brand-600" /> 중단하고 반영
          </label>
          <button disabled={closed || !draft.trim()} className="btn-primary">
            보내기 ↑
          </button>
        </div>
      </form>
    </div>
  );
}

function Tasks({ org }: { org: Org }) {
  if (!org.tasks.length) return <p className="card p-6 text-sm text-slate-500">작업이 아직 없습니다. (초기 연구 승인 전에는 작업이 생기지 않음)</p>;
  const tone: Record<string, string> = { "진행 중": "text-brand-600", 완료: "text-emerald-600", 막힘: "text-rose-600", "할 일": "text-slate-500" };
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50/80 text-left text-xs text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">ID</th>
            <th className="px-4 py-2.5 font-medium">제목</th>
            <th className="px-4 py-2.5 font-medium">상태</th>
            <th className="px-4 py-2.5 font-medium">담당</th>
            <th className="hidden px-4 py-2.5 font-medium md:table-cell">연구 노드</th>
          </tr>
        </thead>
        <tbody>
          {org.tasks.map((t) => (
            <tr key={t.id} className="border-t border-slate-100 transition hover:bg-slate-50/70">
              <td className="px-4 py-3 text-slate-400">{t.id}</td>
              <td className="px-4 py-3 font-medium">{t.title}</td>
              <td className={`px-4 py-3 ${tone[t.status]}`}>{t.status}</td>
              <td className="px-4 py-3">{t.assignee}</td>
              <td className="hidden px-4 py-3 text-slate-400 md:table-cell">{t.node ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapStub({ org }: { org: Org }) {
  const rows = [
    [0, "문제", "P1 한국어 평가셋 부족"],
    [1, "가설", "H1 번역셋으로 충분"],
    [1, "가설", "H2 원어민 작성셋이 필요"],
    [2, "검증 방법", "M1 두 셋의 순위 상관 비교"],
    [3, "실험", "E1 채점 프롬프트 비교"],
  ] as const;
  const [sel, setSel] = useState<string>();
  return (
    <div>
      <div className="mb-3 text-xs text-slate-400">연구 지도 배치·라이브러리는 #51에서 정합니다. 여기서는 공간만 확인합니다. ({org.name})</div>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card className="min-h-96">
          {rows.map(([d, k, t]) => (
            <button key={t} onClick={() => setSel(t)} className={`my-0.5 flex w-full items-center rounded-xl py-1.5 pr-2 text-left text-sm transition ${sel === t ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-slate-50"}`} style={{ paddingLeft: 8 + d * 28 }}>
              <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{k}</span>
              {t}
            </button>
          ))}
        </Card>
        <Card title="노드 상세 패널">
          {sel ? <p className="animate-fade-up text-sm font-medium">{sel}</p> : <p className="text-sm text-slate-500">노드를 고르면 계획·지표·연결 작업이 여기 보입니다.</p>}
        </Card>
      </div>
    </div>
  );
}

function Agents({ org }: { org: Org }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {org.agents.map((a) => (
        <div key={a.id} className="card card-hover p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-sm font-semibold text-white">{a.name.slice(0, 1)}</div>
            <div className="min-w-0">
              <div className="truncate font-medium">{a.name}</div>
              <div className="text-xs text-slate-400">
                {a.role} · heartbeat {a.heartbeat}
              </div>
            </div>
          </div>
          <div className={`mt-3 flex items-center gap-1.5 text-sm ${a.status === "실행 중" ? "text-emerald-600" : "text-slate-500"}`}>
            {a.status === "실행 중" && <LiveDot />}
            {a.status}
          </div>
        </div>
      ))}
    </div>
  );
}

function Review({ org }: { org: Org }) {
  const { inbox } = useStore();
  const item = inbox.find((i) => i.orgId === org.id && i.kind === "결과 제출");
  if (!item) return <p className="card p-6 text-sm text-slate-500">제출된 결과가 없습니다.</p>;
  return <InboxDetail item={item} />;
}

function OrgSettings({ org }: { org: Org }) {
  const { policy, togglePolicy } = useStore();
  const on = !!policy[org.id];
  return (
    <div className="space-y-4 text-sm">
      <Card title="승인 정책">
        <button onClick={() => togglePolicy(org.id)} className="flex w-full items-center gap-3 text-left" role="switch" aria-checked={on}>
          <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-brand-600" : "bg-slate-300"}`}>
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-5" : ""}`} />
          </span>
          작업자 추가에 승인 필요
        </button>
        <p className="mt-3 text-xs text-slate-400">초기 연구 승인과 최종 완료는 항상 사용자 결정입니다(끌 수 없음).</p>
      </Card>
      <Card title="Heartbeat">
        {org.agents.map((a) => (
          <div key={a.id} className="flex justify-between py-1">
            <span>{a.name}</span>
            <span className="text-slate-400">{a.heartbeat}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function RunDetail({ org, runId }: { org: Org; runId: string }) {
  const run = org.runs.find((r) => r.id === runId);
  if (!run) return <NotFound what={`실행 시도 (${org.name} 안에서)`} />;
  return (
    <div className="space-y-3">
      <L to={`/orgs/${org.id}/activity`} className="btn-ghost -ml-2 px-2 py-1 text-xs">
        ← 활동
      </L>
      <h2 className="text-xl font-semibold">
        실행 시도 {run.id} <span className="text-sm font-normal text-slate-400">· {run.agent} · {run.status}</span>
      </h2>
      <Card title="깨우기 사유">{run.wake}</Card>
      <Card title="Transcript">
        <pre className="rounded-xl bg-slate-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-200">{`> 맥락: 작업 T-12, 조직 기억 3건\n> tool: org.tasks.get(T-12)\n> tool: web.fetch(...) — ${run.summary}\n(도구 결과는 접힘)`}</pre>
      </Card>
    </div>
  );
}

// ---------- Inbox pieces ----------

export function KindTag({ item }: { item: InboxItem }) {
  const c =
    item.kind === "실패한 실행 시도" ? "text-rose-700 bg-rose-50" : item.kind === "결과 제출" ? "text-fuchsia-700 bg-fuchsia-50" : "text-amber-800 bg-amber-50";
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${c}`}>{item.kind}</span>;
}

export function DecisionTag({ d }: { d: Decision }) {
  if (d === "해당 없음") return null;
  const c =
    d === "미결" ? "text-amber-700" : d === "전송 중" ? "text-brand-600" : d === "전송 실패" ? "text-rose-600 font-semibold" : "text-slate-400";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${c}`}>
      {d === "전송 중" && <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />}
      결정: {d}
    </span>
  );
}

export type InboxFilter = "attention" | "unread" | "working" | "all" | "archived";
export const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "attention", label: "주의 필요" },
  { key: "unread", label: "안 읽음" },
  { key: "working", label: "작업 중" },
  { key: "all", label: "전체" },
  { key: "archived", label: "보관됨" },
];
export function applyFilter(xs: InboxItem[], f: InboxFilter) {
  if (f === "attention") return xs.filter(needsAttention);
  if (f === "unread") return xs.filter((i) => !i.read && !i.archived);
  if (f === "working") return xs.filter(inProgress);
  if (f === "archived") return xs.filter((i) => i.archived);
  return xs.filter((i) => !i.archived);
}
export function useInboxFilter(): [InboxFilter, (f: InboxFilter) => void] {
  const [sp, setSp] = useSearchParams();
  const f = (sp.get("f") as InboxFilter) || "attention";
  return [
    f,
    (nf) => {
      const n = new URLSearchParams(sp);
      n.set("f", nf);
      setSp(n, { replace: true });
    },
  ];
}

/** Read/archive (notification hygiene) vs domain decision are separate controls. */
export function InboxDetail({ item, onBack }: { item: InboxItem; onBack?: () => void }) {
  const { orgById, setRead, setArchived, decide } = useStore();
  const org = orgById(item.orgId)!;
  useEffect(() => {
    if (!item.read) setRead(item.id, true);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = item.decision === "미결" || item.decision === "전송 실패";
  const busy = item.decision === "전송 중";
  return (
    <article className="animate-fade-up space-y-4">
      {onBack && (
        <button onClick={onBack} className="btn-ghost -ml-2 px-2 py-1 text-xs">
          ← Inbox 목록
        </button>
      )}
      <header>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <L to={`/orgs/${org.id}`} className="font-medium text-slate-700 hover:text-brand-600">
            {org.name}
          </L>
          <StageBadge stage={org.stage} />
          <KindTag item={item} />
          <span>
            {item.from} · {item.at}
          </span>
        </div>
        <h2 className="mt-2 text-xl font-semibold text-slate-900">{item.title}</h2>
        <p className="mt-0.5 text-sm text-slate-500">{item.reason}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-100/80 px-3 py-2 text-xs text-slate-500">
        <span className="mr-auto">알림 정리 — 도메인 결정과 무관</span>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRead(item.id, !item.read)}>
          {item.read ? "안 읽음으로" : "읽음으로"}
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setArchived(item.id, !item.archived)}>
          {item.archived ? "보관 해제" : "보관"}
        </button>
      </div>

      {item.kind === "초기 연구 승인" && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card title="초기 연구 계획">
            <ol className="list-decimal space-y-0.5 pl-4 text-sm">
              <li>자기대국 데이터 생성</li>
              <li>정책망 학습 반복</li>
              <li>기존 엔진과 Elo 평가</li>
            </ol>
          </Card>
          <Card title="팀 구성">
            <ul className="space-y-0.5 text-sm">
              <li>시뮬레이션 엔지니어</li>
              <li>학습 실험자</li>
              <li>평가자</li>
            </ul>
          </Card>
          <Card title="연구 환경 명세">
            <ul className="space-y-0.5 text-sm">
              <li>GPU 1장 (24GB)</li>
              <li>로컬 저장소 50GB</li>
              <li>사용자 할 일: 클라우드 계정</li>
            </ul>
          </Card>
        </div>
      )}
      {item.kind === "작업자 추가 승인" && (
        <Card title="제안">
          <p className="text-sm">역할: 통계 검토 · 이유: 채점 결과의 유의성 검정 필요</p>
        </Card>
      )}
      {item.kind === "결과 제출" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card title="완료 기준">
            <ul className="space-y-0.5 text-sm">
              <li>✔ 오류 유형 분류 5종 이상</li>
              <li>✔ 재현 스크립트</li>
              <li>△ 개선안 효과 측정 (부분)</li>
            </ul>
          </Card>
          <Card title="산출물">
            <ul className="space-y-0.5 text-sm font-medium text-brand-600">
              <li>report-v1.md</li>
              <li>error-taxonomy.csv</li>
            </ul>
          </Card>
        </div>
      )}
      {item.kind === "실패한 실행 시도" && (
        <Card title="실패">
          <p className="text-sm">{item.reason}</p>
          {item.runId && (
            <L to={`/orgs/${org.id}/runs/${item.runId}`} className="btn-soft mt-3">
              원 실패 실행 시도 {item.runId} 보기 →
            </L>
          )}
        </Card>
      )}

      {item.decision !== "해당 없음" && (
        <div className={`card p-4 transition ${item.decision === "전송 실패" ? "ring-rose-300" : ""}`}>
          <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
            도메인 결정 (제어 명령) · <DecisionTag d={item.decision} />
          </div>
          {item.decision === "전송 실패" && (
            <p className="animate-fade-up mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">결정이 반영되지 않았습니다. 상태는 그대로 미결입니다. 다시 시도하세요.</p>
          )}
          {pending || busy ? (
            <div className="flex flex-wrap gap-2">
              {item.kind === "결과 제출" ? (
                <>
                  <button disabled={busy} className="btn-primary" onClick={() => decide(item.id, "최종 완료")}>
                    최종 완료
                  </button>
                  <button disabled={busy} className="btn-soft" onClick={() => decide(item.id, "수정 요청됨")}>
                    수정 요청
                  </button>
                </>
              ) : (
                <>
                  <button disabled={busy} className="btn-primary" onClick={() => decide(item.id, "승인됨")}>
                    승인
                  </button>
                  <button disabled={busy} className="btn-soft" onClick={() => decide(item.id, "수정 요청됨")}>
                    수정 요청
                  </button>
                  <button disabled={busy} className="btn-danger" onClick={() => decide(item.id, "반려됨")}>
                    반려
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="animate-fade-up text-sm text-slate-500">이미 결정됨 — 다시 결정할 수 없습니다.</p>
          )}
        </div>
      )}
    </article>
  );
}

export function useOrgParam() {
  const { orgId } = useParams();
  const { orgById } = useStore();
  return { orgId, org: orgById(orgId) };
}

export const tabLabel = (slug?: string) => ORG_TABS.find((t) => t.slug === slug)?.label;
