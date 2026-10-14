// PROTOTYPE (#50) — Variant C: 왼쪽 조직 레일(약칭+단계 텍스트) + 선택 조직의 세로 섹션 목록 + 본문.
// Inbox는 하나의 패널뿐이다: 넓은 화면(≥1280px)에서는 오른쪽에 붙고, 좁으면 오른쪽 drawer로 연다.
// 본문 폭은 화면마다 3단계(좁게/중간/전체) 중 하나. 홈 = 생애주기 보드.
// 2차: 섹션 목록을 묶음으로 나누고(이후 판 화면은 흐리게), 상세(에이전트·작업·산출물)는 섹션 아래 경로의 페이지.
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { SECTION_GROUPS, STAGES, type Org } from "../data";
import { CreateOrgDialog, useCrumbs } from "../details";
import {
  applyFilter,
  Count,
  DataGate,
  DecisionTag,
  FILTERS,
  InboxDetail,
  KindTag,
  L,
  LiveDot,
  liveRuns,
  NoOrgs,
  NotFound,
  OrgBody,
  OrgControls,
  Page,
  StageBadge,
  useInboxCounts,
  useKeep,
  useRouteInfo,
  useStore,
  type InboxFilter,
} from "../shared";

const abbr = (name: string) => name.replace(/^새 연구:\s*/, "").slice(0, 2);
const hue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function useMedia(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(q).matches,
  );
}

type Panel = { open: boolean; setOpen: (v: boolean) => void; scope?: string; setScope: (id?: string) => void; docked: boolean };
const PanelCtx = createContext<Panel>(null!);
const usePanel = () => useContext(PanelCtx);

export function VariantC() {
  const r = useRouteInfo();
  const { orgById } = useStore();
  const docked = useMedia("(min-width: 1280px)");
  const [open, setOpen] = useState(docked);
  const [scope, setScope] = useState<string>();
  const [sheet, setSheet] = useState(false);
  const org = orgById(r.orgId);
  const counts = useInboxCounts();

  useEffect(() => setOpen(docked), [docked]);
  useEffect(() => {
    if (r.global === "inbox" && !r.inboxId) setOpen(true);
  }, [r.global, r.inboxId]);

  return (
    <PanelCtx.Provider value={{ open, setOpen, scope, setScope, docked }}>
      <Tooltip.Provider delayDuration={150}>
        <div className="flex h-screen overflow-hidden">
          <div className="hidden md:flex">
            <Rail />
            {org && <Sections org={org} />}
          </div>
          <Dialog.Root open={sheet} onOpenChange={setSheet}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
              <Dialog.Content
                className="fixed inset-y-0 left-0 z-50 flex shadow-pop data-[state=closed]:animate-slide-out-left data-[state=open]:animate-slide-in-left"
                onClick={(e) => (e.target as HTMLElement).closest("a") && setSheet(false)}
              >
                <Dialog.Title className="sr-only">탐색</Dialog.Title>
                <Rail />
                {org && <Sections org={org} />}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <main className="flex min-w-0 flex-1 flex-col overflow-auto pb-20">
            <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200/70 bg-white/80 px-3 py-2 backdrop-blur md:hidden">
              <button aria-label="탐색 열기" onClick={() => setSheet(true)} className="btn-ghost px-2">
                ☰
              </button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{org ? <MobileCrumb org={org} /> : r.global === "inbox" ? "Inbox" : r.global === "settings" ? "설정" : "홈"}</span>
              <button onClick={() => setOpen(true)} className="btn-soft px-2.5 py-1 text-xs">
                Inbox <Count n={counts.attention} tone="amber" />
              </button>
            </div>
            <div key={r.pathname} className="animate-fade-up flex flex-1 flex-col">
              {r.orgId ? (
                org ? (
                  <>
                    <OrgTitle org={org} />
                    <OrgBody org={org} />
                  </>
                ) : (
                  <DataGate>
                    <NotFound what={`조직 (${r.orgId})`} />
                  </DataGate>
                )
              ) : r.global === "inbox" ? (
                <InboxMain />
              ) : r.global === "settings" ? (
                <Page width="reading">
                  <h1 className="mb-2 text-xl font-semibold">전역 설정</h1>
                  <div className="card p-5 text-sm text-slate-500">실행기 adapter · 연구 환경 템플릿 · 비밀값 · 메시지 앱 연결 (판 1에서는 자리만)</div>
                </Page>
              ) : (
                <Home />
              )}
            </div>
          </main>

          <CreateOrgDialog />
          {docked ? (
            open && (
              <aside className="animate-slide-in-right flex w-[340px] shrink-0 flex-col border-l border-slate-200/70 bg-white/70 backdrop-blur">
                <InboxPanel />
              </aside>
            )
          ) : (
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
                <Dialog.Content
                  className="fixed inset-y-0 right-0 z-50 flex w-[min(380px,100vw)] flex-col bg-white shadow-pop data-[state=closed]:animate-slide-out-right data-[state=open]:animate-slide-in-right"
                  onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}
                >
                  <Dialog.Title className="sr-only">Inbox</Dialog.Title>
                  <InboxPanel />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          )}
        </div>
      </Tooltip.Provider>
    </PanelCtx.Provider>
  );
}

// ---------- rail ----------

function Tip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={10} className="animate-pop-in z-[60] max-w-64 rounded-xl bg-slate-900 px-3 py-2 text-xs text-white shadow-pop">
          {content}
          <Tooltip.Arrow className="fill-slate-900" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const railItem = (on: boolean) =>
  `group relative flex w-14 flex-col items-center gap-1 rounded-xl py-1.5 transition duration-150 active:scale-95 ${on ? "bg-white/12" : "hover:bg-white/8"}`;
function ActiveBar({ on }: { on: boolean }) {
  return <span className={`absolute top-1/2 -left-1 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all duration-200 ${on ? "h-7 opacity-100" : "h-2 opacity-0 group-hover:opacity-50"}`} />;
}

function Rail() {
  const r = useRouteInfo();
  const { orgs } = useStore();
  const c = useInboxCounts();
  const p = usePanel();
  const { setCreating } = useStore();
  return (
    <nav className="scrollbar-thin flex w-[72px] shrink-0 flex-col items-center gap-1 overflow-y-auto bg-gradient-to-b from-brand-950 to-slate-950 py-3 pb-24 text-white">
      <Tip content="홈 · 전체 조직 개요">
        <L to="/" className={railItem(r.global === "home")} aria-current={r.global === "home" ? "page" : undefined}>
          <ActiveBar on={r.global === "home"} />
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-lg">⌂</span>
          <span className="text-[10px] text-white/60">홈</span>
        </L>
      </Tip>
      <Tip content={`Inbox · 주의 필요 ${c.attention} · 안 읽음 ${c.unread}`}>
        <button onClick={() => p.setOpen(!p.open)} className={railItem(p.open)} aria-pressed={p.open}>
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-lg">✉</span>
          <span className="text-[10px] text-white/60">Inbox</span>
          {c.attention > 0 && (
            <span className="absolute top-0.5 right-1.5">
              <Count n={c.attention} tone="amber" />
            </span>
          )}
        </button>
      </Tip>
      <div className="my-2 h-px w-8 bg-white/15" />
      <DataGate empty={null}>
        {orgs.map((o) => (
          <RailOrg key={o.id} o={o} on={r.orgId === o.id} />
        ))}
      </DataGate>
      <Tip content="새 연구 조직">
        <button onClick={() => setCreating(true)} aria-label="새 연구 조직" className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl border border-dashed border-white/25 text-white/60 transition hover:border-white/60 hover:text-white active:scale-95">＋</button>
      </Tip>
      <div className="flex-1" />
      <Tip content="전역 설정">
        <L to="/settings" className={railItem(r.global === "settings")}>
          <ActiveBar on={r.global === "settings"} />
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-lg">⚙</span>
          <span className="text-[10px] text-white/60">설정</span>
        </L>
      </Tip>
    </nav>
  );
}

function RailOrg({ o, on }: { o: Org; on: boolean }) {
  const c = useInboxCounts(o.id);
  const n = liveRuns(o);
  const dim = o.stage === "최종 완료" || o.stage === "중단됨";
  const h = hue(o.id);
  return (
    <Tip
      content={
        <div className="space-y-1">
          <div className="font-semibold">{o.name}</div>
          <div className="text-white/70">
            {o.stage}
            {n > 0 && ` · 실행 중 ${n}`}
            {c.attention > 0 && ` · 주의 필요 ${c.attention}`}
          </div>
        </div>
      }
    >
      <L to={`/orgs/${o.id}`} className={railItem(on)} aria-current={on ? "page" : undefined} aria-label={`${o.name} · ${o.stage}`}>
        <ActiveBar on={on} />
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl text-[13px] font-semibold shadow-sm transition ${on ? "ring-2 ring-white" : ""} ${dim ? "opacity-45 grayscale" : ""}`}
          style={{ background: `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 40) % 360} 65% 48%))` }}
        >
          {abbr(o.name)}
        </span>
        <span className={`w-full truncate px-0.5 text-center text-[10px] ${on ? "text-white" : "text-white/55"}`}>{o.stage.replace(" 중", "").replace("최종 ", "")}</span>
        {n > 0 && <LiveDot className="absolute top-1 left-2" />}
        {c.attention > 0 && (
          <span className="absolute top-0 right-1">
            <Count n={c.attention} tone="amber" />
          </span>
        )}
      </L>
    </Tip>
  );
}

// ---------- org sections ----------

function Sections({ org }: { org: Org }) {
  const r = useRouteInfo();
  const c = useInboxCounts(org.id);
  const p = usePanel();
  const extra: Record<string, ReactNode> = {
    activity: liveRuns(org) > 0 ? <LiveDot /> : null,
    tasks: <span className="text-[11px] text-slate-400">{org.tasks.length || ""}</span>,
    review: org.stage === "결과 검토 중" ? <Count n={1} tone="amber" /> : null,
  };
  const [sp] = useSearchParams();
  const showLater = sp.get("later") !== "0";
  const [shut, setShut] = useState<Record<string, boolean>>({});
  return (
    <nav className="scrollbar-thin flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-200/70 bg-white/60 p-3 pb-24 backdrop-blur" aria-label="조직 화면">
      <div className="card p-3">
        <div className="text-[15px] leading-snug font-semibold text-slate-900">{org.name}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StageBadge stage={org.stage} />
          {c.attention > 0 && (
            <button
              onClick={() => {
                p.setScope(org.id);
                p.setOpen(true);
              }}
              className="chip bg-amber-50 py-0.5 text-amber-800 hover:bg-amber-100"
            >
              주의 {c.attention} →
            </button>
          )}
        </div>
        <div className="mt-3">
          <OrgControls org={org} />
        </div>
      </div>
      {SECTION_GROUPS.map((g, gi) => {
        const items = g.items.filter((t) => showLater || !t.later);
        const isOn = (slug: string) => r.tab === slug || (!!r.runId && slug === "activity");
        const closed = g.label && shut[g.label];
        const shown = closed ? items.filter((t) => isOn(t.slug)) : items;
        return (
          <div key={gi}>
            {g.label && (
              <button
                onClick={() => setShut((x) => ({ ...x, [g.label!]: !x[g.label!] }))}
                aria-expanded={!closed}
                className="group mb-0.5 flex w-full items-center gap-1 rounded-lg px-3 py-1 text-[11px] font-semibold tracking-wide text-slate-400 transition hover:text-slate-600"
              >
                {g.label}
                <span className={`ml-auto text-[10px] transition-transform duration-200 ${closed ? "-rotate-90" : ""}`}>▾</span>
              </button>
            )}
            <ul className="space-y-0.5">
              {shown.map((t) => {
                const on = isOn(t.slug);
                return (
                  <li key={t.slug} className="animate-fade-in">
                    <L
                      to={`/orgs/${org.id}/${t.slug}`}
                      aria-current={on ? "page" : undefined}
                      title={t.later ? `이후 판: ${t.later}` : undefined}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition duration-150 active:scale-[0.98] ${on ? "bg-white font-semibold text-slate-900 shadow-card ring-1 ring-slate-900/5" : t.later ? "text-slate-400 hover:bg-white/60" : "text-slate-600 hover:bg-white/80 hover:text-slate-900"}`}
                    >
                      <span className={`h-4 w-1 rounded-full transition-colors ${on ? "bg-brand-500" : "bg-transparent"}`} />
                      <span className="flex-1">{t.label}</span>
                      {t.later ? <span className="rounded-full border border-dashed border-slate-300 px-1.5 text-[10px] text-slate-400">이후</span> : extra[t.slug]}
                    </L>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function MobileCrumb({ org }: { org: Org }) {
  const cs = useCrumbs(org);
  return <>{`${org.name} › ${cs[cs.length - 1].label}`}</>;
}

function OrgTitle({ org }: { org: Org }) {
  const cs = useCrumbs(org);
  return (
    <div className="hidden truncate border-b border-slate-200/70 bg-white/60 px-6 py-2.5 text-xs text-slate-400 backdrop-blur md:block">
      <L to={`/orgs/${org.id}`} className="transition hover:text-slate-700">
        {org.name}
      </L>
      {cs.map((c, i) => (
        <span key={i}>
          <span className="mx-1.5">›</span>
          {c.to ? (
            <L to={c.to} className="transition hover:text-slate-700">
              {c.label}
            </L>
          ) : (
            <span className="font-medium text-slate-700">{c.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

// ---------- the one Inbox ----------

function InboxPanel() {
  const { inbox, orgById } = useStore();
  const r = useRouteInfo();
  const p = usePanel();
  const [f, setF] = useState<InboxFilter>("attention");
  const scopeOrg = orgById(p.scope ?? r.orgId);
  const scoped = p.scope ? inbox.filter((i) => i.orgId === p.scope) : inbox;
  const xs = applyFilter(scoped, f);
  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <h2 className="flex-1 text-base font-semibold">Inbox</h2>
        <button onClick={() => p.setOpen(false)} className="btn-ghost px-2 py-1 text-xs" aria-label="Inbox 닫기">
          ✕
        </button>
      </div>
      {scopeOrg && (
        <div className="mx-4 mb-2 grid grid-cols-2 rounded-xl bg-slate-100 p-0.5 text-xs">
          {[
            [undefined, "전체 조직"],
            [scopeOrg.id, scopeOrg.name],
          ].map(([id, label]) => (
            <button
              key={label}
              onClick={() => p.setScope(id)}
              className={`truncate rounded-[10px] px-2 py-1.5 transition duration-200 ${p.scope === id ? "bg-white font-medium text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        {FILTERS.map((x) => {
          const n = applyFilter(scoped, x.key).length;
          return (
            <button key={x.key} onClick={() => setF(x.key)} className={`chip ${f === x.key ? "bg-slate-900 text-white shadow-sm" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
              {x.label}
              <span className={f === x.key ? "text-white/60" : "text-slate-400"}>{n}</span>
            </button>
          );
        })}
      </div>
      <DataGate>
        <ul className="scrollbar-thin flex-1 space-y-1.5 overflow-auto px-3 pb-24">
          {!xs.length && (
            <li className="animate-fade-up mt-8 text-center text-sm text-slate-400">
              <div className="mb-1 text-2xl">✓</div>이 필터에 항목이 없습니다
            </li>
          )}
          {xs.map((i) => {
            const sel = r.inboxId === i.id;
            return (
              <li key={i.id} className="animate-fade-up">
                <L
                  to={`/inbox/${i.id}`}
                  className={`relative block rounded-xl px-3 py-2.5 transition duration-150 active:scale-[0.99] ${sel ? "bg-brand-50 ring-1 ring-brand-200" : "bg-white shadow-card ring-1 ring-slate-900/5 hover:-translate-y-px hover:shadow-lift"}`}
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    {!i.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" aria-label="안 읽음" />}
                    {!p.scope && <span className="truncate">{orgById(i.orgId)?.name}</span>}
                    <span className="ml-auto shrink-0">{i.at}</span>
                  </div>
                  <div className={`mt-0.5 truncate text-sm ${i.read ? "text-slate-700" : "font-semibold text-slate-900"}`}>{i.title}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <KindTag item={i} />
                    <DecisionTag d={i.decision} />
                  </div>
                </L>
              </li>
            );
          })}
        </ul>
      </DataGate>
    </>
  );
}

/** /inbox and /inbox/:id show the item in the main area; the list itself is only the panel. */
function InboxMain() {
  const { inbox, status } = useStore();
  const r = useRouteInfo();
  const p = usePanel();
  const nav = useNavigate();
  const keep = useKeep();
  const c = useInboxCounts();
  if (status !== "ok") return <DataGate>{null}</DataGate>;
  const item = inbox.find((i) => i.id === r.inboxId);
  if (r.inboxId)
    return (
      <Page width="standard">
        {item ? <InboxDetail key={item.id} item={item} onBack={p.docked ? undefined : () => p.setOpen(true)} /> : <NotFound what="Inbox 항목" />}
      </Page>
    );
  const first = applyFilter(inbox, "attention")[0];
  return (
    <Page width="reading" className="flex flex-1 items-center justify-center">
      <div className="card animate-fade-up w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">✉</div>
        <div className="font-semibold">{c.attention ? `주의 필요 ${c.attention}건` : "주의할 항목이 없습니다"}</div>
        <p className="mt-1 text-sm text-slate-500">{p.docked ? "오른쪽 Inbox에서 항목을 고르면 여기서 검토합니다." : "Inbox를 열어 항목을 고르세요."}</p>
        <div className="mt-4 flex justify-center gap-2">
          {!p.docked && (
            <button className="btn-soft" onClick={() => p.setOpen(true)}>
              Inbox 열기
            </button>
          )}
          {first && (
            <button className="btn-primary" onClick={() => nav(keep(`/inbox/${first.id}`))}>
              첫 항목 검토
            </button>
          )}
        </div>
      </div>
    </Page>
  );
}

// ---------- home ----------

function Home() {
  const { orgs, setCreating } = useStore();
  const c = useInboxCounts();
  const p = usePanel();
  const total = orgs.reduce((s, o) => s + liveRuns(o), 0);
  return (
    <Page width="full">
      <DataGate empty={<NoOrgs />}>
        <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              {total > 0 && <LiveDot />} 지금 실행 중인 실행 시도 · 전체 조직 합계
            </div>
            <div className="mt-1 text-5xl font-semibold text-slate-900">{total}</div>
          </div>
          <button onClick={() => p.setOpen(true)} className="card card-hover px-4 py-3 text-left">
            <div className="text-[13px] text-slate-500">주의 필요</div>
            <div className="text-2xl font-semibold text-amber-600">{c.attention}</div>
          </button>
          <div className="card px-4 py-3">
            <div className="text-[13px] text-slate-500">연구 조직</div>
            <div className="text-2xl font-semibold">{orgs.length}</div>
          </div>
          <button className="btn-primary ml-auto" onClick={() => setCreating(true)}>
            ＋ 새 연구 조직
          </button>
        </div>
        <div className="scrollbar-thin flex gap-3 overflow-x-auto pb-4">
          {STAGES.map((s) => {
            const xs = orgs.filter((o) => o.stage === s);
            if (!xs.length)
              return (
                <div key={s} className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 py-3 text-[11px] text-slate-400" title={`${s} · 0`}>
                  <span className="[writing-mode:vertical-rl]">{s}</span>
                  <span>0</span>
                </div>
              );
            return (
              <section key={s} className="w-60 shrink-0 rounded-2xl bg-slate-200/40 p-2">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <StageBadge stage={s} />
                  <span className="text-xs text-slate-400">{xs.length}</span>
                </div>
                <div className="space-y-2">
                  {xs.map((o) => (
                    <BoardCard key={o.id} o={o} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DataGate>
    </Page>
  );
}

function BoardCard({ o }: { o: Org }) {
  const c = useInboxCounts(o.id);
  const h = hue(o.id);
  return (
    <L to={`/orgs/${o.id}`} className="card card-hover block p-3 text-sm">
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white" style={{ background: `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 40) % 360} 65% 48%))` }}>
          {abbr(o.name)}
        </span>
        <div className="line-clamp-3 font-medium text-slate-800">{o.name}</div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
        {liveRuns(o) > 0 && (
          <span className="flex items-center gap-1 text-emerald-600">
            <LiveDot /> 실행 중 {liveRuns(o)}
          </span>
        )}
        {c.attention > 0 && <span className="font-medium text-amber-600">주의 {c.attention}</span>}
        <span className="ml-auto">{o.lastActivity}</span>
      </div>
    </L>
  );
}
