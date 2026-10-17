// 공통 셸: 왼쪽 조직 레일 + 선택 조직의 세로 섹션 목록 + 본문(#50 결정 C).
// 768px 미만에서는 레일과 섹션 목록이 왼쪽 시트로 바뀐다.
import type { Organization } from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useMatch } from "react-router";
import { useOrganization, useOrganizations } from "./api.ts";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import {
  abbr,
  avatarStyle,
  StageBadge,
  stageLabel,
  stageShortLabel,
  type Width,
} from "./ui.tsx";

export type Section = { slug: string; label: string; width: Width };
export const defaultSection = "dashboard";
export const sectionGroups: { label?: string; items: Section[] }[] = [
  {
    items: [
      { slug: "dashboard", label: "대시보드", width: "full" },
      { slug: "chat", label: "Lead 대화", width: "reading" },
    ],
  },
  {
    label: "연구",
    items: [
      { slug: "tasks", label: "작업", width: "standard" },
      { slug: "map", label: "연구 지도", width: "full" },
      { slug: "review", label: "결과 검토", width: "standard" },
    ],
  },
  {
    label: "팀과 실행",
    items: [
      { slug: "agents", label: "에이전트", width: "full" },
      { slug: "activity", label: "활동", width: "full" },
    ],
  },
  {
    label: "운영",
    items: [{ slug: "settings", label: "설정", width: "reading" }],
  },
];
export const findSection = (slug: string) =>
  sectionGroups.flatMap((g) => g.items).find((s) => s.slug === slug);

function useCurrent() {
  const org = useMatch("/orgs/:orgId/*")?.params.orgId;
  const section =
    useMatch("/orgs/:orgId/:section/*")?.params.section ??
    (org ? defaultSection : undefined);
  return { orgId: org, section, home: useLocation().pathname === "/" };
}

export function Shell() {
  const { orgId } = useCurrent();
  const [sheet, setSheet] = useState(false);
  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="flex h-screen overflow-hidden">
        <div className="hidden md:flex">
          <Rail />
          {orgId && <Sections orgId={orgId} />}
        </div>
        <Dialog.Root open={sheet} onOpenChange={setSheet}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
            <Dialog.Content
              className="fixed inset-y-0 left-0 z-50 flex shadow-pop data-[state=closed]:animate-slide-out-left data-[state=open]:animate-slide-in-left"
              onClick={(e) =>
                (e.target as HTMLElement).closest(
                  "a, button[data-closes-sheet]"
                ) && setSheet(false)
              }
            >
              <Dialog.Title className="sr-only">탐색</Dialog.Title>
              <Rail />
              {orgId && <Sections orgId={orgId} />}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <main className="flex min-w-0 flex-1 flex-col overflow-auto pb-20">
          <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200/70 bg-white/80 px-3 py-2 backdrop-blur md:hidden">
            <button
              aria-label="탐색 열기"
              onClick={() => setSheet(true)}
              className="btn-ghost px-2"
            >
              ☰
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {orgId ? <Crumbs orgId={orgId} compact /> : "홈"}
            </span>
          </div>
          {orgId && (
            <div className="hidden truncate border-b border-slate-200/70 bg-white/60 px-6 py-2.5 text-xs text-slate-400 backdrop-blur md:block">
              <Crumbs orgId={orgId} />
            </div>
          )}
          <div
            key={useLocation().pathname}
            className="animate-fade-up flex flex-1 flex-col"
          >
            <Outlet />
          </div>
        </main>
      </div>
    </Tooltip.Provider>
  );
}

function Tip({
  children,
  content,
}: {
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={10}
          className="animate-pop-in z-[60] max-w-64 rounded-xl bg-slate-900 px-3 py-2 text-xs text-white shadow-pop"
        >
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
  return (
    <span
      className={`absolute top-1/2 -left-1 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all duration-200 ${on ? "h-7 opacity-100" : "h-2 opacity-0 group-hover:opacity-50"}`}
    />
  );
}

function Rail() {
  const { orgId, home } = useCurrent();
  const orgs = useOrganizations();
  const openCreate = useOpenCreateOrganization();
  return (
    <nav
      aria-label="연구 조직"
      className="scrollbar-thin flex w-[72px] shrink-0 flex-col items-center gap-1 overflow-y-auto bg-gradient-to-b from-brand-950 to-slate-950 py-3 pb-24 text-white"
    >
      <Tip content="홈 · 전체 조직 개요">
        <Link
          to="/"
          className={railItem(home)}
          aria-current={home ? "page" : undefined}
        >
          <ActiveBar on={home} />
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-lg">
            ⌂
          </span>
          <span className="text-[10px] text-white/60">홈</span>
        </Link>
      </Tip>
      <div className="my-2 h-px w-8 bg-white/15" />
      {orgs.isPending && (
        <div
          className="h-9 w-9 animate-pulse rounded-xl bg-white/10"
          aria-busy
        />
      )}
      {orgs.isError && (
        <Tip content="조직 목록을 불러오지 못했습니다">
          <button
            onClick={() => void orgs.refetch()}
            className="text-xs text-rose-300"
            aria-label="조직 목록 다시 불러오기"
          >
            ⚠
          </button>
        </Tip>
      )}
      {orgs.data?.map((o) => (
        <RailOrganization key={o.id} org={o} on={orgId === o.id} />
      ))}
      <Tip content="새 연구 조직">
        <button
          onClick={openCreate}
          data-closes-sheet
          aria-label="새 연구 조직"
          className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl border border-dashed border-white/25 text-white/60 transition hover:border-white/60 hover:text-white active:scale-95"
        >
          ＋
        </button>
      </Tip>
    </nav>
  );
}

function RailOrganization({ org, on }: { org: Organization; on: boolean }) {
  const stage = stageLabel[org.stage];
  const dim = org.stage === "completed" || org.stage === "stopped";
  return (
    <Tip
      content={
        <div className="space-y-1">
          <div className="font-semibold">{org.name}</div>
          <div className="text-white/70">{stage}</div>
        </div>
      }
    >
      <Link
        to={`/orgs/${org.id}`}
        className={railItem(on)}
        aria-current={on ? "page" : undefined}
        aria-label={`${org.name} · ${stage}`}
      >
        <ActiveBar on={on} />
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl text-[13px] font-semibold shadow-sm transition ${on ? "ring-2 ring-white" : ""} ${dim ? "opacity-45 grayscale" : ""}`}
          style={avatarStyle(org.id)}
        >
          {abbr(org.name)}
        </span>
        <span
          className={`w-full truncate px-0.5 text-center text-[10px] ${on ? "text-white" : "text-white/55"}`}
        >
          {stageShortLabel[org.stage]}
        </span>
      </Link>
    </Tip>
  );
}

function Sections({ orgId }: { orgId: string }) {
  const { section } = useCurrent();
  const org = useOrganization(orgId);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  if (!org.data) return null;
  return (
    <nav
      className="scrollbar-thin flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-200/70 bg-white/60 p-3 pb-24 backdrop-blur"
      aria-label="조직 화면"
    >
      <div className="card p-3">
        <div className="text-[15px] leading-snug font-semibold text-slate-900">
          {org.data.name}
        </div>
        <div className="mt-2">
          <StageBadge stage={org.data.stage} />
        </div>
      </div>
      {sectionGroups.map((g, gi) => {
        const closed = g.label && shut[g.label];
        const shown = closed
          ? g.items.filter((s) => s.slug === section)
          : g.items;
        return (
          <div key={gi}>
            {g.label && (
              <button
                onClick={() =>
                  setShut((x) => ({ ...x, [g.label!]: !x[g.label!] }))
                }
                aria-expanded={!closed}
                className="group mb-0.5 flex w-full items-center gap-1 rounded-lg px-3 py-1 text-[11px] font-semibold tracking-wide text-slate-400 transition hover:text-slate-600"
              >
                {g.label}
                <span
                  className={`ml-auto text-[10px] transition-transform duration-200 ${closed ? "-rotate-90" : ""}`}
                >
                  ▾
                </span>
              </button>
            )}
            <ul className="space-y-0.5">
              {shown.map((s) => {
                const on = s.slug === section;
                return (
                  <li key={s.slug}>
                    <Link
                      to={`/orgs/${orgId}/${s.slug}`}
                      aria-current={on ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition duration-150 active:scale-[0.98] ${on ? "bg-white font-semibold text-slate-900 shadow-card ring-1 ring-slate-900/5" : "text-slate-600 hover:bg-white/80 hover:text-slate-900"}`}
                    >
                      <span
                        className={`h-4 w-1 rounded-full transition-colors ${on ? "bg-brand-500" : "bg-transparent"}`}
                      />
                      {s.label}
                    </Link>
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

/** 조직 › 섹션. 앞 단계는 링크. */
function Crumbs({ orgId, compact }: { orgId: string; compact?: boolean }) {
  const { section } = useCurrent();
  const org = useOrganization(orgId);
  const name = org.data?.name ?? "…";
  const label = (section && findSection(section)?.label) ?? section;
  if (compact) return <>{`${name} › ${label}`}</>;
  return (
    <>
      <Link to={`/orgs/${orgId}`} className="transition hover:text-slate-700">
        {name}
      </Link>
      <span className="mx-1.5">›</span>
      <span className="font-medium text-slate-700">{label}</span>
    </>
  );
}
