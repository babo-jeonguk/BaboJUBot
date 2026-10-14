// PROTOTYPE (#50 2차) — throwaway. 목록에서 들어가는 상세 페이지(에이전트·작업·산출물), 이후 판 자리,
// 조직 생성 dialog. 상세는 모두 별도 경로의 페이지이고 오른쪽 패널은 Inbox만 쓴다.
import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { Agent, InstrDoc, Org, Section } from "./data";
import { ActivityList, Card, L, LiveDot, NotFound, TASK_TONE, tabLabel, useKeep, useRouteInfo, useStore } from "./shared";

const closed = (o: Org) => o.stage === "최종 완료" || o.stage === "중단됨";

function Back({ to, label }: { to: string; label: string }) {
  return (
    <L to={to} className="btn-ghost -ml-2 px-2 py-1 text-xs">
      ← {label}
    </L>
  );
}

/** 조직 › 섹션 › 항목. 마지막을 뺀 단계는 링크. */
export function useCrumbs(org: Org): { label: string; to?: string }[] {
  const r = useRouteInfo();
  const base = `/orgs/${org.id}`;
  if (r.runId) return [{ label: "활동", to: `${base}/activity` }, { label: `실행 시도 ${r.runId}` }];
  const sec = { label: tabLabel(r.tab) ?? r.tab ?? "", to: `${base}/${r.tab}` };
  if (!r.itemId) return [{ label: sec.label }];
  const item =
    r.tab === "agents"
      ? org.agents.find((a) => a.id === r.itemId)?.name
      : r.tab === "tasks"
        ? org.tasks.find((t) => t.id === r.itemId)?.title
        : r.tab === "artifacts"
          ? org.artifacts.find((a) => a.id === r.itemId)?.name
          : undefined;
  return [sec, { label: item ?? r.itemId }];
}

function usePatch(org: Org) {
  const { updateOrg } = useStore();
  return (fn: (o: Org) => Org, activity?: string) =>
    updateOrg(org.id, (o) => {
      const n = fn(o);
      return activity ? { ...n, activity: [{ id: `u${Date.now()}`, at: "방금", agent: "사용자", text: activity }, ...n.activity] } : n;
    });
}

// ---------- 에이전트 상세 ----------

export function AgentDetail({ org, agentId, sub }: { org: Org; agentId: string; sub?: string }) {
  const a = org.agents.find((x) => x.id === agentId);
  if (!a) return <NotFound what={`에이전트 (${org.name} 안에서)`} />;
  const base = `/orgs/${org.id}/agents/${a.id}`;
  const tabs = [
    { to: base, label: "개요", on: sub !== "instructions" },
    { to: `${base}/instructions`, label: "Role·Soul·Skill", on: sub === "instructions" },
  ];
  return (
    <div className="space-y-4">
      <Back to={`/orgs/${org.id}/agents`} label="에이전트" />
      <AgentHeader org={org} a={a} />
      <nav className="inline-flex rounded-xl bg-slate-200/60 p-0.5 text-sm" aria-label="에이전트 상세">
        {tabs.map((t) => (
          <L
            key={t.label}
            to={t.to}
            aria-current={t.on ? "page" : undefined}
            className={`rounded-[10px] px-3.5 py-1.5 transition duration-200 ${t.on ? "bg-white font-medium text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
          </L>
        ))}
      </nav>
      {sub === "instructions" ? <InstructionEditor key={a.id} org={org} a={a} /> : <AgentOverview org={org} a={a} />}
    </div>
  );
}

function AgentHeader({ org, a }: { org: Org; a: Agent }) {
  const { notify } = useStore();
  const patch = usePatch(org);
  const paused = a.status === "일시정지";
  const orgHeld = org.stage === "일시정지" || closed(org);
  const toggle = () => {
    patch(
      (o) => ({ ...o, agents: o.agents.map((x) => (x.id === a.id ? { ...x, status: paused ? "대기" : "일시정지" } : x)) }),
      `${a.name} ${paused ? "재개" : "일시정지"} (제어 명령)`,
    );
    notify(paused ? `${a.name} 재개 · 쌓인 깨우기를 실행 시도 하나로 전달 (stub)` : `${a.name} 일시정지 · 진행 중 실행 시도 취소, 깨우기는 쌓아 둠 (stub)`);
  };
  return (
    <header className="card flex flex-wrap items-center gap-4 p-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-lg font-semibold text-white shadow-sm">{a.name.slice(0, 1)}</div>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold text-slate-900">{a.name}</h2>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs">Role {a.role}</span>
          <span className={`flex items-center gap-1.5 ${a.status === "실행 중" ? "text-emerald-600" : paused ? "text-amber-700" : ""}`}>
            {a.status === "실행 중" && <LiveDot />}
            {a.status}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {a.role === "Lead" ? (
          <L to={`/orgs/${org.id}/chat`} className="btn-soft">
            Lead 대화 →
          </L>
        ) : (
          <span className="text-xs text-slate-400" title="연구 방향은 Lead와 이야기합니다">
            작업자에게는 작업 댓글로 말합니다
          </span>
        )}
        <button className={paused ? "btn-primary" : "btn-soft"} disabled={orgHeld} onClick={toggle} title={orgHeld ? "조직이 일시정지·종료 상태입니다" : undefined}>
          {paused ? "▶ 에이전트 재개" : "❚❚ 에이전트 일시정지"}
        </button>
      </div>
    </header>
  );
}

const EVERY = ["15분", "30분", "1시간", "6시간"];

function AgentOverview({ org, a }: { org: Org; a: Agent }) {
  const { notify } = useStore();
  const patch = usePatch(org);
  const setHb = (hb: Agent["hb"], what: string) => {
    patch((o) => ({ ...o, agents: o.agents.map((x) => (x.id === a.id ? { ...x, hb } : x)) }), `${a.name} heartbeat ${what}`);
    notify(`heartbeat ${what} · 즉시 반영 (stub)`);
  };
  const runs = org.runs.filter((r) => r.agent === a.name);
  const tasks = org.tasks.filter((t) => t.assignee === a.name);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Heartbeat">
        <button
          onClick={() => setHb({ ...a.hb, on: !a.hb.on }, a.hb.on ? "끔" : `켬 (${a.hb.every})`)}
          disabled={closed(org)}
          className="flex w-full items-center gap-3 text-left text-sm disabled:opacity-50"
          role="switch"
          aria-checked={a.hb.on}
        >
          <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${a.hb.on ? "bg-brand-600" : "bg-slate-300"}`}>
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${a.hb.on ? "translate-x-5" : ""}`} />
          </span>
          사건이 없어도 주기적으로 깨우기
        </button>
        <div className={`mt-3 flex items-center gap-2 text-sm transition ${a.hb.on ? "" : "pointer-events-none opacity-40"}`}>
          간격
          <div className="flex gap-1">
            {EVERY.map((e) => (
              <button key={e} onClick={() => setHb({ ...a.hb, every: e }, `간격 ${e}`)} className={`chip ${a.hb.every === e ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          {!a.hb.on
            ? "꺼짐 — 작업 할당·메시지 같은 사건이 있을 때만 깨어납니다."
            : a.status === "일시정지"
              ? "일시정지 중에는 heartbeat로 깨우지 않습니다."
              : `다음 heartbeat 약 ${a.hb.every === "15분" ? "6분" : "12분"} 후 · 다른 깨우기와 합쳐 실행 시도 하나가 됩니다.`}
          <br />
          Role 기본값 30분
        </p>
      </Card>
      <Card title="맡은 작업">
        {tasks.length ? (
          <ul className="space-y-0.5 text-sm">
            {tasks.map((t) => (
              <li key={t.id}>
                <L to={`/orgs/${org.id}/tasks/${t.id}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-slate-50">
                  <span className="text-xs text-slate-400">{t.id}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                  <span className={`text-xs ${TASK_TONE[t.status]}`}>{t.status}</span>
                </L>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">맡은 작업 없음</p>
        )}
      </Card>
      <Card title="최근 실행 시도" className="md:col-span-2">
        {runs.length ? (
          <ul className="text-sm">
            {runs.map((r) => (
              <li key={r.id}>
                <L className="flex gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50" to={`/orgs/${org.id}/runs/${r.id}`}>
                  <span className="w-12 shrink-0 font-medium text-brand-600">{r.id.split("-").pop()}</span>
                  <span className={`w-14 shrink-0 ${r.status === "실패" ? "font-medium text-rose-600" : r.status === "실행 중" ? "text-emerald-600" : ""}`}>{r.status}</span>
                  <span className="hidden w-24 shrink-0 text-slate-500 sm:block">{r.wake}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">{r.summary}</span>
                  <span className="shrink-0 text-xs text-slate-400">{r.started}</span>
                </L>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">아직 실행 시도 없음</p>
        )}
      </Card>
      <Card title="최근 활동" className="md:col-span-2">
        {org.activity.some((x) => x.agent === a.name) ? <ActivityList org={org} agent={a.name} limit={5} /> : <p className="text-sm text-slate-500">아직 활동 없음</p>}
      </Card>
    </div>
  );
}

function InstructionEditor({ org, a }: { org: Org; a: Agent }) {
  const { notify } = useStore();
  const patch = usePatch(org);
  const [key, setKey] = useState(a.docs[0].key);
  const [view, setView] = useState<number>(); // undefined = 현재 revision
  const [draft, setDraft] = useState<string | null>(null); // null = 편집 중 아님
  const doc = a.docs.find((d) => d.key === key)!;
  const cur = doc.revs[doc.revs.length - 1];
  const shown = doc.revs.find((r) => r.n === view) ?? cur;
  const dirty = draft !== null && draft !== cur.text;
  const sameRole = org.agents.filter((x) => x.id !== a.id && x.role === a.role);

  const leaveEdit = () => !dirty || confirm("저장하지 않은 변경을 버릴까요?");
  const pick = (d: InstrDoc) => {
    if (d.key === key || !leaveEdit()) return;
    setKey(d.key);
    setView(undefined);
    setDraft(null);
  };
  const save = () => {
    const n = cur.n + 1;
    patch(
      (o) => ({
        ...o,
        agents: o.agents.map((x) =>
          x.id !== a.id ? x : { ...x, docs: x.docs.map((d) => (d.key !== key ? d : { ...d, revs: [...d.revs, { n, by: "사용자", at: "방금", text: draft! }] })) },
        ),
      }),
      `${a.name}의 ${doc.kind} 사본 편집 (revision ${n}) → Lead 깨우기`,
    );
    setDraft(null);
    notify(`저장 · revision ${n} · 즉시 반영, Lead를 깨웠습니다 (stub)`);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_230px]">
      <section className="card min-w-0 p-4">
        <div className="flex flex-wrap gap-1.5">
          {a.docs.map((d) => (
            <button key={d.key} onClick={() => pick(d)} className={`chip ${d.key === key ? "bg-slate-900 text-white shadow-sm" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
              <b className="font-semibold">{d.kind}</b>
              <span className={d.key === key ? "text-white/60" : "text-slate-400"}>{d.kind === "Skill" ? d.title : d.file}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 rounded-xl bg-brand-50/70 px-3 py-2 text-xs text-brand-900">
          <b className="font-semibold">{a.name}</b>만의 사본입니다.
          {sameRole.length > 0 && ` 같은 Role '${a.role}'의 ${sameRole.map((x) => x.name).join(", ")}에게는 반영되지 않습니다.`} 하네스 라이브러리도 바뀌지 않습니다.
        </p>
        {view !== undefined && view !== cur.n && (
          <div className="animate-fade-up mt-2 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            revision {view} 보기 (읽기 전용) · 현재는 revision {cur.n}
            <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => setView(undefined)}>
              현재로
            </button>
          </div>
        )}
        <div className="mt-3 text-[11px] text-slate-400">{doc.file}</div>
        {draft !== null ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="mt-1 min-h-80 w-full resize-y rounded-xl bg-slate-50 p-3 font-mono text-[13px] leading-relaxed ring-1 ring-brand-200 outline-none focus:ring-2 focus:ring-brand-400"
          />
        ) : (
          <pre key={`${key}-${shown.n}`} className="animate-fade-in mt-1 min-h-80 rounded-xl bg-slate-50 p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-slate-700 ring-1 ring-slate-900/5">
            {shown.text}
          </pre>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {draft !== null ? (
            <>
              <button className="btn-primary" disabled={!dirty} onClick={save}>
                저장
              </button>
              <button className="btn-soft" onClick={() => leaveEdit() && setDraft(null)}>
                취소
              </button>
            </>
          ) : (
            <button
              className="btn-primary"
              disabled={closed(org)}
              onClick={() => {
                setView(undefined);
                setDraft(cur.text);
              }}
            >
              편집
            </button>
          )}
          <span className="text-xs text-slate-400">저장하면 즉시 반영됩니다 · 다음 실행 시도는 새 세션으로 시작 · Lead를 깨웁니다</span>
        </div>
      </section>
      <aside className="card h-fit p-4">
        <h3 className="mb-2 text-[13px] font-semibold text-slate-500">Revision</h3>
        <ol className="space-y-1">
          {[...doc.revs].reverse().map((r) => {
            const on = shown.n === r.n && draft === null;
            return (
              <li key={r.n}>
                <button
                  disabled={draft !== null}
                  onClick={() => setView(r.n === cur.n ? undefined : r.n)}
                  className={`w-full rounded-xl px-2.5 py-2 text-left text-sm transition disabled:opacity-50 ${on ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-slate-50"}`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    revision {r.n}
                    {r.n === cur.n && <span className="rounded-full bg-emerald-50 px-1.5 text-[10px] text-emerald-700">현재</span>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {r.by} · {r.at}
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-[11px] text-slate-400">되돌리기·diff는 이후 판</p>
      </aside>
    </div>
  );
}

// ---------- 작업 상세 ----------

export function TaskDetail({ org, taskId }: { org: Org; taskId: string }) {
  const { notify } = useStore();
  const patch = usePatch(org);
  const [draft, setDraft] = useState("");
  const t = org.tasks.find((x) => x.id === taskId);
  if (!t) return <NotFound what={`작업 (${org.name} 안에서)`} />;
  const owner = org.agents.find((a) => a.name === t.assignee);
  const arts = org.artifacts.filter((a) => a.taskId === t.id);
  const send = () => {
    patch((o) => ({ ...o, tasks: o.tasks.map((x) => (x.id === t.id ? { ...x, comments: [...x.comments, { from: "사용자", text: draft, at: "방금" }] } : x)) }), `작업 ${t.id}에 댓글 → ${t.assignee} 깨우기`);
    setDraft("");
    notify(`댓글 · ${t.assignee}를 깨웠습니다 (stub)`);
  };
  return (
    <div className="space-y-4">
      <Back to={`/orgs/${org.id}/tasks`} label="작업" />
      <header>
        <div className="text-xs text-slate-400">
          {t.id} · 만든 에이전트 {t.createdBy}
        </div>
        <h2 className="mt-1 flex flex-wrap items-center gap-3 text-xl font-semibold text-slate-900">
          {t.title}
          <span className={`rounded-full bg-white px-2 py-0.5 text-xs font-medium ring-1 ring-slate-200 ${TASK_TONE[t.status]}`}>{t.status}</span>
        </h2>
      </header>
      <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0 space-y-4">
          <Card title="자기 보고 요약">
            {t.summary ? (
              <>
                <p className="text-sm leading-relaxed">{t.summary}</p>
                <p className="mt-2 text-[11px] text-slate-400">작업자의 자기 보고입니다. 확인된 결과가 아닙니다.</p>
              </>
            ) : (
              <p className="text-sm text-slate-500">아직 완료 보고가 없습니다.</p>
            )}
          </Card>
          <Card title={`댓글 ${t.comments.length || ""}`}>
            <ul className="space-y-3">
              {t.comments.map((c, i) => (
                <li key={i} className="animate-fade-up flex gap-3 text-sm">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${c.from === "사용자" ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{c.from.slice(0, 1)}</span>
                  <div className="min-w-0">
                    <div className="text-xs text-slate-400">
                      <b className="font-medium text-slate-700">{c.from}</b> · {c.at}
                    </div>
                    <p className="mt-0.5 leading-relaxed">{c.text}</p>
                  </div>
                </li>
              ))}
              {!t.comments.length && <li className="text-sm text-slate-400">아직 댓글이 없습니다.</li>}
            </ul>
            <form
              className="mt-4 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-900/5 transition focus-within:bg-white focus-within:ring-brand-200"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) send();
              }}
            >
              <div className="mb-1 text-[11px] text-slate-400">
                쓰기 대상 · 작업 {t.id} · 보내면 담당 <b className="font-medium text-slate-700">{t.assignee}</b>를 깨웁니다
              </div>
              <textarea
                disabled={closed(org)}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={closed(org) ? "종료된 조직입니다 (읽기 전용)" : "댓글…"}
                className="w-full resize-none bg-transparent p-1 text-sm outline-none placeholder:text-slate-400"
              />
              <div className="flex justify-end">
                <button className="btn-primary px-3 py-1 text-xs" disabled={closed(org) || !draft.trim()}>
                  댓글 달기
                </button>
              </div>
            </form>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="속성">
            <dl className="grid grid-cols-[72px_1fr] gap-y-2 text-sm">
              <dt className="text-slate-400">상태</dt>
              <dd className={TASK_TONE[t.status]}>{t.status}</dd>
              <dt className="text-slate-400">담당</dt>
              <dd>
                {owner ? (
                  <L to={`/orgs/${org.id}/agents/${owner.id}`} className="font-medium text-brand-600 hover:underline">
                    {t.assignee}
                  </L>
                ) : (
                  t.assignee
                )}
              </dd>
              <dt className="text-slate-400">연구 노드</dt>
              <dd>
                {t.node ? (
                  <L to={`/orgs/${org.id}/map`} className="font-medium text-brand-600 hover:underline">
                    {t.node}
                  </L>
                ) : (
                  "—"
                )}
              </dd>
            </dl>
          </Card>
          <Card title="산출물">
            {arts.length ? (
              <ul className="space-y-1 text-sm">
                {arts.map((x) => (
                  <li key={x.id}>
                    <L to={`/orgs/${org.id}/artifacts/${x.id}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 font-medium text-brand-600 transition hover:bg-slate-50">
                      📄 {x.name}
                    </L>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">없음</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------- 산출물 단건 보기 ----------

export function ArtifactView({ org, artifactId }: { org: Org; artifactId: string }) {
  const x = org.artifacts.find((a) => a.id === artifactId);
  if (!x) return <NotFound what={`산출물 (${org.name} 안에서)`} />;
  const task = org.tasks.find((t) => t.id === x.taskId);
  const by = org.agents.find((a) => a.name === x.by);
  const csv = x.name.endsWith(".csv") ? x.content.split("\n").map((l) => l.split(",")) : null;
  return (
    <div className="space-y-4">
      {task ? <Back to={`/orgs/${org.id}/tasks/${task.id}`} label={`작업 ${task.id}`} /> : <Back to={`/orgs/${org.id}/review`} label="결과 검토" />}
      <header>
        <h2 className="text-xl font-semibold text-slate-900">📄 {x.name}</h2>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
          <span>
            기록{" "}
            {by ? (
              <L to={`/orgs/${org.id}/agents/${by.id}`} className="font-medium text-slate-600 hover:text-brand-600">
                {x.by}
              </L>
            ) : (
              x.by
            )}{" "}
            · {x.at}
          </span>
          {task && (
            <L to={`/orgs/${org.id}/tasks/${task.id}`} className="hover:text-brand-600">
              작업 {task.id} {task.title}
            </L>
          )}
          {x.runId && (
            <L to={`/orgs/${org.id}/runs/${x.runId}`} className="hover:text-brand-600">
              실행 시도 {x.runId.split("-").pop()}
            </L>
          )}
        </div>
      </header>
      <section className="card overflow-hidden">
        {csv ? (
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 text-left text-xs text-slate-500">
              <tr>
                {csv[0].map((h) => (
                  <th key={h} className="px-4 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csv.slice(1).map((row, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {row.map((c, j) => (
                    <td key={j} className="px-4 py-2.5">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="p-5 font-sans text-[15px] leading-relaxed whitespace-pre-wrap text-slate-700">{x.content}</pre>
        )}
      </section>
      <p className="text-xs text-slate-400">산출물이 있다고 결과가 확인된 것은 아닙니다.</p>
    </div>
  );
}

// ---------- 이후 판 자리 ----------

export function LaterStub({ section }: { section: Section }) {
  return (
    <div className="card animate-fade-up p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{section.label}</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">이후 판</span>
      </div>
      <p className="mt-2 text-sm text-slate-600">{section.later}</p>
      <p className="mt-4 text-xs text-slate-400">판 1 구현에서는 섹션 목록에 나오지 않습니다. 프로토타입에서는 묶음 규모를 확인하려고 보여 줍니다.</p>
    </div>
  );
}

// ---------- 조직 생성 ----------

export function CreateOrgDialog({ trigger }: { trigger?: ReactNode }) {
  const { creating, setCreating, createOrg, notify } = useStore();
  const [name, setName] = useState("");
  const nav = useNavigate();
  const keep = useKeep();
  return (
    <Dialog.Root
      open={creating}
      onOpenChange={(v) => {
        setCreating(v);
        if (!v) setName("");
      }}
    >
      {trigger}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content className="animate-pop-in fixed top-[18vh] left-1/2 z-[71] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-white p-6 shadow-pop">
          <Dialog.Title className="text-lg font-semibold">새 연구 조직</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-slate-500">연구 목표 하나가 조직 하나가 됩니다. 이름만 정하면 전용 Research Lead가 함께 생기고, 목표와 완료 기준은 Lead 대화에서 정합니다.</Dialog.Description>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n) return;
              const id = createOrg(n);
              setCreating(false);
              setName("");
              nav(keep(`/orgs/${id}/chat`));
              notify(`'${n}' 조직을 만들었습니다 · Lead와 연구 목표를 정하세요`);
            }}
          >
            <label className="text-xs font-medium text-slate-600" htmlFor="org-name">
              조직 이름
            </label>
            <input
              id="org-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 한국어 음성 인식 오류 분석"
              className="mt-1 w-full rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="btn-soft">취소</Dialog.Close>
              <button className="btn-primary" disabled={!name.trim()}>
                만들고 Lead 대화로
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
