// PROTOTYPE (#50) — Variant A: 항상 보이는 조직 목록·단계 사이드바 + 조직 헤더 + 가로 탭(scroll).
// Inbox = 목록 + 오른쪽 상세 패널. 홈 = 조직 개요 표.
import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ORG_TABS, type Org } from "../data";
import {
  applyFilter,
  Count,
  DataGate,
  DecisionTag,
  FILTERS,
  InboxDetail,
  KindTag,
  L,
  liveRuns,
  NoOrgs,
  NotFound,
  OrgBody,
  OrgControls,
  StageBadge,
  useInboxCounts,
  useInboxFilter,
  useKeep,
  useRouteInfo,
  useStore,
} from "../shared";

export function VariantA() {
  const [open, setOpen] = useState(false);
  const r = useRouteInfo();
  const { orgById } = useStore();
  return (
    <div className="flex h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white md:block">
        <Sidebar />
      </aside>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-72 bg-white shadow-xl" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
            <Dialog.Title className="sr-only">탐색</Dialog.Title>
            <Sidebar />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <main className="flex min-w-0 flex-1 flex-col overflow-auto pb-16">
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 md:hidden">
          <button aria-label="탐색 열기" onClick={() => setOpen(true)} className="rounded border border-zinc-300 px-2 py-1">
            ☰
          </button>
          <span className="truncate text-sm font-medium">{r.orgId ? (orgById(r.orgId)?.name ?? "찾을 수 없는 조직") : r.global === "inbox" ? "Inbox" : r.global === "settings" ? "설정" : "홈"}</span>
        </div>
        {r.orgId ? <OrgPage /> : r.global === "inbox" ? <Inbox /> : r.global === "settings" ? <GlobalSettings /> : <Home />}
      </main>
    </div>
  );
}

function NavItem({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <L
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${active ? "bg-zinc-900 text-white" : "hover:bg-zinc-100"}`}
    >
      {children}
    </L>
  );
}

function Sidebar() {
  const r = useRouteInfo();
  const { orgs } = useStore();
  const c = useInboxCounts();
  const [showDone, setShowDone] = useState(false);
  const active = orgs.filter((o) => o.stage !== "최종 완료" && o.stage !== "중단됨");
  const done = orgs.filter((o) => !active.includes(o));
  return (
    <nav className="flex h-full flex-col gap-4 overflow-auto p-3 pb-20">
      <div className="px-2 text-sm font-bold">BaboJUBot</div>
      <div className="space-y-0.5">
        <NavItem to="/" active={r.global === "home"}>
          홈
        </NavItem>
        <NavItem to="/inbox" active={r.global === "inbox"}>
          <span className="flex-1">Inbox</span>
          <Count n={c.attention} tone="amber" label="주의 필요" />
          <Count n={c.unread} tone="sky" label="안 읽음" />
        </NavItem>
        <NavItem to="/settings" active={r.global === "settings"}>
          전역 설정
        </NavItem>
      </div>
      <div>
        <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500">
          연구 조직 <button title="새 연구 조직" className="rounded px-1 hover:bg-zinc-100">＋</button>
        </div>
        <DataGate empty={<p className="px-2 text-xs text-zinc-500">조직 없음</p>}>
          <ul className="space-y-0.5">
            {active.map((o) => (
              <OrgRow key={o.id} o={o} selected={r.orgId === o.id} />
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <button onClick={() => setShowDone((x) => !x)} className="mt-2 px-2 text-[11px] text-zinc-500 hover:underline">
                {showDone ? "▾" : "▸"} 완료·중단 ({done.length})
              </button>
              {(showDone || done.some((o) => o.id === r.orgId)) && (
                <ul className="space-y-0.5 opacity-80">
                  {done.map((o) => (
                    <OrgRow key={o.id} o={o} selected={r.orgId === o.id} />
                  ))}
                </ul>
              )}
            </>
          )}
        </DataGate>
      </div>
    </nav>
  );
}

function OrgRow({ o, selected }: { o: Org; selected: boolean }) {
  const c = useInboxCounts(o.id);
  const n = liveRuns(o);
  return (
    <li>
      <L
        to={`/orgs/${o.id}`}
        aria-current={selected ? "page" : undefined}
        className={`block rounded px-2 py-1.5 ${selected ? "bg-sky-50 ring-1 ring-sky-300" : "hover:bg-zinc-100"}`}
      >
        <div className="truncate text-sm" title={o.name}>
          {o.name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
          <StageBadge stage={o.stage} />
          {n > 0 && <span className="text-emerald-700">● 실행 중 {n}</span>}
          <span className="ml-auto">
            <Count n={c.attention} tone="amber" label="주의 필요" />
          </span>
        </div>
      </L>
    </li>
  );
}

function OrgPage() {
  const r = useRouteInfo();
  const { orgById, status } = useStore();
  const org = orgById(r.orgId);
  if (status !== "ok") return <DataGate>{null}</DataGate>;
  if (!org) return <NotFound what={`조직 (${r.orgId})`} />;
  return (
    <>
      <header className="border-b border-zinc-200 bg-white px-4 pt-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg leading-tight font-semibold">{org.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
              <StageBadge stage={org.stage} /> 실행 중 실행 시도 {liveRuns(org)}
            </div>
          </div>
          <OrgControls org={org} />
        </div>
        <nav className="scrollbar-thin -mb-px mt-3 flex gap-1 overflow-x-auto" aria-label="조직 화면">
          {ORG_TABS.map((t) => {
            const on = r.tab === t.slug || (r.runId && t.slug === "activity");
            return (
              <L
                key={t.slug}
                to={`/orgs/${org.id}/${t.slug}`}
                aria-current={on ? "page" : undefined}
                className={`shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${on ? "border-zinc-900 font-medium" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}
              >
                {t.label}
              </L>
            );
          })}
        </nav>
      </header>
      <OrgBody org={org} />
    </>
  );
}

function Inbox() {
  const { inbox, orgById } = useStore();
  const r = useRouteInfo();
  const [f, setF] = useInboxFilter();
  const keep = useKeep();
  const nav = useNavigate();
  const xs = applyFilter(inbox, f);
  const sel = inbox.find((i) => i.id === r.inboxId);
  return (
    <DataGate>
      <div className="flex min-h-0 flex-1">
        <section className={`w-full shrink-0 border-r border-zinc-200 bg-white md:w-96 ${sel ? "hidden md:block" : ""}`}>
          <div className="flex flex-wrap gap-1 border-b border-zinc-200 p-2">
            {FILTERS.map((x) => {
              const n = applyFilter(inbox, x.key).length;
              return (
                <button key={x.key} onClick={() => setF(x.key)} className={`rounded-full px-2.5 py-1 text-xs ${f === x.key ? "bg-zinc-900 text-white" : "bg-zinc-100"}`}>
                  {x.label} {n}
                </button>
              );
            })}
          </div>
          {!xs.length && <p className="p-6 text-sm text-zinc-500">이 필터에 항목이 없습니다.</p>}
          <ul>
            {xs.map((i) => (
              <li key={i.id}>
                <L
                  to={`/inbox/${i.id}?f=${f}`}
                  className={`block border-b border-zinc-100 px-3 py-2.5 ${sel?.id === i.id ? "bg-sky-50" : "hover:bg-zinc-50"}`}
                >
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                    {!i.read && <span className="h-2 w-2 rounded-full bg-sky-600" aria-label="안 읽음" />}
                    <span className="truncate font-medium text-zinc-700">{orgById(i.orgId)?.name}</span>
                    <span className="ml-auto shrink-0">{i.at}</span>
                  </div>
                  <div className={`mt-0.5 truncate text-sm ${i.read ? "" : "font-semibold"}`}>{i.title}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <KindTag item={i} />
                    <DecisionTag d={i.decision} />
                  </div>
                </L>
              </li>
            ))}
          </ul>
        </section>
        <section className={`min-w-0 flex-1 p-4 ${sel ? "" : "hidden md:block"}`}>
          {sel ? (
            <InboxDetail key={sel.id} item={sel} onBack={() => nav(keep(`/inbox?f=${f}`))} />
          ) : r.inboxId ? (
            <NotFound what="Inbox 항목" />
          ) : (
            <p className="mt-20 text-center text-sm text-zinc-400">왼쪽에서 항목을 고르세요</p>
          )}
        </section>
      </div>
    </DataGate>
  );
}

function Home() {
  const { orgs } = useStore();
  const c = useInboxCounts();
  const total = orgs.reduce((s, o) => s + liveRuns(o), 0);
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">전체 개요</h1>
      <DataGate empty={<NoOrgs />}>
        <div className="grid grid-cols-3 gap-3 sm:max-w-2xl">
          <Stat n={total} label="실행 중 실행 시도 (전체 조직 합계)" />
          <Stat n={c.attention} label="주의 필요" />
          <Stat n={orgs.filter((o) => o.stage === "연구 진행").length} label="연구 진행 중 조직" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] overflow-hidden rounded-lg bg-white text-sm ring-1 ring-zinc-200">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="p-2">연구 조직</th>
                <th className="p-2">단계</th>
                <th className="p-2 text-right">실행 중</th>
                <th className="p-2 text-right">주의 필요</th>
                <th className="p-2">최근 활동</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <HomeRow key={o.id} o={o} />
              ))}
            </tbody>
          </table>
        </div>
      </DataGate>
    </div>
  );
}
function HomeRow({ o }: { o: Org }) {
  const c = useInboxCounts(o.id);
  return (
    <tr className="border-t border-zinc-100 hover:bg-zinc-50">
      <td className="p-2">
        <L className="font-medium hover:underline" to={`/orgs/${o.id}`}>
          {o.name}
        </L>
      </td>
      <td className="p-2">
        <StageBadge stage={o.stage} />
      </td>
      <td className="p-2 text-right tabular-nums">{liveRuns(o)}</td>
      <td className="p-2 text-right tabular-nums">{c.attention || ""}</td>
      <td className="p-2 text-zinc-500">{o.lastActivity}</td>
    </tr>
  );
}
function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-2xl font-semibold tabular-nums">{n}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

export function GlobalSettings() {
  return (
    <div className="p-6 text-sm text-zinc-600">
      <h1 className="mb-2 text-lg font-semibold text-zinc-900">전역 설정</h1>
      실행기 adapter · 연구 환경 템플릿 · 비밀값 · 메시지 앱 연결 (판 1에서는 자리만)
    </div>
  );
}
