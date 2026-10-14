// PROTOTYPE (#50) — Variant B: 사이드바 없음. 상단 바의 조직 switcher + 전역 탭(홈·Inbox·설정),
// 조직 헤더 아래 가로 탭(좁으면 select). Inbox = 전체 폭 목록 → 별도 상세 화면. 홈 = 조직 카드.
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
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
import { GlobalSettings } from "./A";

export function VariantB() {
  const r = useRouteInfo();
  return (
    <div className="min-h-screen pb-20">
      <TopBar />
      <div className="mx-auto max-w-6xl">
        {r.orgId ? <OrgPage /> : r.global === "inbox" ? (r.inboxId ? <InboxItemPage /> : <Inbox />) : r.global === "settings" ? <GlobalSettings /> : <Home />}
      </div>
    </div>
  );
}

function TopBar() {
  const r = useRouteInfo();
  const c = useInboxCounts();
  const tab = (to: string, on: boolean, label: React.ReactNode) => (
    <L to={to} aria-current={on ? "page" : undefined} className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm ${on ? "bg-white/15 text-white" : "text-zinc-300 hover:text-white"}`}>
      {label}
    </L>
  );
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 bg-zinc-900 px-3 text-white">
      <span className="hidden text-sm font-bold sm:inline">BaboJUBot</span>
      <span className="hidden text-zinc-600 sm:inline">/</span>
      <OrgSwitcher />
      <nav className="ml-auto flex shrink-0 items-center">
        {tab("/", r.global === "home", "홈")}
        {tab(
          "/inbox",
          r.global === "inbox",
          <>
            Inbox <Count n={c.attention} tone="amber" label="주의 필요" />
          </>,
        )}
        {tab("/settings", r.global === "settings", <span title="전역 설정">⚙</span>)}
      </nav>
    </header>
  );
}

function OrgSwitcher() {
  const r = useRouteInfo();
  const { orgs, orgById, status } = useStore();
  const nav = useNavigate();
  const keep = useKeep();
  const cur = orgById(r.orgId);
  return (
    <Menu.Root>
      <Menu.Trigger className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-white/10 sm:max-w-md">
        {cur ? (
          <>
            <span className="truncate font-medium">{cur.name}</span>
            <StageBadge stage={cur.stage} short />
          </>
        ) : (
          <span className="text-zinc-300">연구 조직 선택</span>
        )}
        <span className="text-zinc-400">▾</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="start" sideOffset={6} className="z-50 max-h-[70vh] w-80 overflow-auto rounded-lg bg-white p-1 text-sm shadow-xl ring-1 ring-zinc-200">
          {status === "loading" && <div className="p-3 text-zinc-500">불러오는 중…</div>}
          {status === "error" && <div className="p-3 text-rose-700">조직 목록 조회 실패</div>}
          {status === "ok" && !orgs.length && <div className="p-3 text-zinc-500">조직 없음</div>}
          {orgs.map((o) => (
            <Menu.Item
              key={o.id}
              onSelect={() => nav(keep(`/orgs/${o.id}/${r.tab && r.orgId ? r.tab : "dashboard"}`))}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-zinc-100 ${o.id === r.orgId ? "font-semibold" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate" title={o.name}>
                {o.name}
              </span>
              {liveRuns(o) > 0 && <span className="text-[11px] text-emerald-700">● {liveRuns(o)}</span>}
              <StageBadge stage={o.stage} short />
            </Menu.Item>
          ))}
          <Menu.Separator className="my-1 h-px bg-zinc-200" />
          <Menu.Item className="cursor-pointer rounded px-2 py-1.5 text-zinc-600 outline-none data-[highlighted]:bg-zinc-100">＋ 새 연구 조직</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function OrgPage() {
  const r = useRouteInfo();
  const { orgById, status } = useStore();
  const nav = useNavigate();
  const keep = useKeep();
  const org = orgById(r.orgId);
  if (status !== "ok") return <DataGate>{null}</DataGate>;
  if (!org) return <NotFound what={`조직 (${r.orgId})`} />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-4 pt-5">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-zinc-500">{org.goal}</div>
        </div>
        <span className="text-xs text-zinc-500">실행 중 {liveRuns(org)}</span>
        <OrgControls org={org} />
      </div>
      <nav className="mx-4 mt-3 hidden gap-1 rounded-lg bg-zinc-200/60 p-1 md:flex" aria-label="조직 화면">
        {ORG_TABS.map((t) => {
          const on = r.tab === t.slug || (!!r.runId && t.slug === "activity");
          return (
            <L key={t.slug} to={`/orgs/${org.id}/${t.slug}`} aria-current={on ? "page" : undefined} className={`flex-1 rounded-md px-2 py-1.5 text-center text-sm whitespace-nowrap ${on ? "bg-white font-medium shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}>
              {t.label}
            </L>
          );
        })}
      </nav>
      <label className="mx-4 mt-3 block md:hidden">
        <span className="sr-only">조직 화면</span>
        <select className="w-full rounded border border-zinc-300 bg-white px-2 py-2 text-sm" value={r.runId ? "activity" : r.tab} onChange={(e) => nav(keep(`/orgs/${org.id}/${e.target.value}`))}>
          {ORG_TABS.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <OrgBody org={org} />
    </>
  );
}

function Inbox() {
  const { inbox, orgById } = useStore();
  const [f, setF] = useInboxFilter();
  return (
    <DataGate>
      <div className="p-4">
        <h1 className="mb-3 text-lg font-semibold">Inbox · 전체 조직</h1>
        <div className="mb-3 flex gap-4 overflow-x-auto border-b border-zinc-200 text-sm">
          {FILTERS.map((x) => (
            <button key={x.key} onClick={() => setF(x.key)} className={`-mb-px shrink-0 border-b-2 pb-2 ${f === x.key ? "border-zinc-900 font-medium" : "border-transparent text-zinc-500"}`}>
              {x.label} <span className="text-zinc-400">{applyFilter(inbox, x.key).length}</span>
            </button>
          ))}
        </div>
        {!applyFilter(inbox, f).length && <p className="p-6 text-sm text-zinc-500">이 필터에 항목이 없습니다.</p>}
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200">
          {applyFilter(inbox, f).map((i) => (
            <li key={i.id}>
              <L to={`/inbox/${i.id}?f=${f}`} className="grid grid-cols-[12px_1fr] gap-x-2 px-3 py-3 hover:bg-zinc-50 md:grid-cols-[12px_200px_120px_1fr_150px_90px] md:items-center">
                <span className={`mt-1.5 h-2 w-2 rounded-full md:mt-0 ${i.read ? "" : "bg-sky-600"}`} />
                <span className="truncate text-xs font-medium text-zinc-700">{orgById(i.orgId)?.name}</span>
                <span className="col-start-2 md:col-start-auto">
                  <KindTag item={i} />
                </span>
                <span className="col-start-2 min-w-0 md:col-start-auto">
                  <span className={`block truncate text-sm ${i.read ? "" : "font-semibold"}`}>{i.title}</span>
                  <span className="block truncate text-xs text-zinc-500">{i.reason}</span>
                </span>
                <span className="col-start-2 md:col-start-auto">
                  <DecisionTag d={i.decision} />
                </span>
                <span className="col-start-2 text-xs text-zinc-400 md:col-start-auto md:text-right">{i.at}</span>
              </L>
            </li>
          ))}
        </ul>
      </div>
    </DataGate>
  );
}

function InboxItemPage() {
  const r = useRouteInfo();
  const { inbox, status } = useStore();
  const [f] = useInboxFilter();
  const nav = useNavigate();
  const keep = useKeep();
  if (status !== "ok") return <DataGate>{null}</DataGate>;
  const item = inbox.find((i) => i.id === r.inboxId);
  if (!item) return <NotFound what="Inbox 항목" />;
  return (
    <div className="p-4">
      <InboxDetail key={item.id} item={item} onBack={() => nav(keep(`/inbox?f=${f}`))} />
    </div>
  );
}

function Home() {
  const { orgs } = useStore();
  const [showDone, setShowDone] = useState(false);
  const total = orgs.reduce((s, o) => s + liveRuns(o), 0);
  const active = orgs.filter((o) => o.stage !== "최종 완료" && o.stage !== "중단됨");
  const done = orgs.filter((o) => !active.includes(o));
  return (
    <div className="p-4">
      <DataGate empty={<NoOrgs />}>
        <div className="mb-6 flex items-end gap-6">
          <div>
            <div className="text-5xl font-semibold tabular-nums">{total}</div>
            <div className="text-sm text-zinc-500">지금 실행 중인 실행 시도 · 전체 {orgs.length}개 조직</div>
          </div>
          <button className="ml-auto rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">＋ 새 연구 조직</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((o) => (
            <OrgCard key={o.id} o={o} />
          ))}
        </div>
        {done.length > 0 && (
          <div className="mt-6">
            <button onClick={() => setShowDone((x) => !x)} className="text-sm text-zinc-500 hover:underline">
              {showDone ? "▾" : "▸"} 완료·중단된 조직 {done.length}
            </button>
            {showDone && (
              <div className="mt-3 grid gap-3 opacity-80 sm:grid-cols-2 lg:grid-cols-3">
                {done.map((o) => (
                  <OrgCard key={o.id} o={o} />
                ))}
              </div>
            )}
          </div>
        )}
      </DataGate>
    </div>
  );
}

function OrgCard({ o }: { o: Org }) {
  const c = useInboxCounts(o.id);
  const max = Math.max(...o.daily, 1);
  return (
    <L to={`/orgs/${o.id}`} className="block rounded-xl bg-white p-4 ring-1 ring-zinc-200 hover:ring-zinc-400">
      <div className="flex items-start gap-2">
        <div className="line-clamp-2 min-w-0 flex-1 font-medium">{o.name}</div>
        <StageBadge stage={o.stage} />
      </div>
      <div className="mt-3 flex h-8 items-end gap-0.5">
        {o.daily.map((d, i) => (
          <div key={i} className="flex-1 rounded-sm bg-zinc-300" style={{ height: `${(d / max) * 100}%` }} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
        <span className={liveRuns(o) ? "text-emerald-700" : ""}>실행 중 {liveRuns(o)}</span>
        {c.attention > 0 && <span className="font-medium text-amber-700">주의 필요 {c.attention}</span>}
        <span className="ml-auto">{o.lastActivity}</span>
      </div>
    </L>
  );
}
