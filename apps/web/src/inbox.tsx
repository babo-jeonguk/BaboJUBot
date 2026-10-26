// Inbox 패널 하나(#50 결정): 1280px 이상에서는 본문 오른쪽에 340px로 붙고, 그보다 좁으면 오른쪽 drawer로 열려
// 항목을 고르면 닫힌다. 범위는 전체 조직 / 현재 조직, 필터는 주의 필요·전체·읽지 않음·보관됨이다.
// 항목을 열면(Inbox 상세) 읽음이 된다. 패널에서는 체크한 항목을 한꺼번에 읽음으로 하고, 읽은 항목을 읽지 않음으로 되돌리거나 보관한다.
// 도메인 결정(승인·반려·수정 요청·최종 완료)은 항목 상세(Inbox 상세 또는 원래 상세)에서 한다.
// 행에는 결정 버튼을 두지 않는다(docs/research/inbox-detail-references.md D07).
import {
  canArchiveInboxItem,
  inboxDetailPath,
  inboxFilters,
  inboxItemTime,
  inboxOrganizationId,
  inboxSourceId,
  needsAttention,
  type InboxFilter,
  type InboxItem,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Link, Navigate, useMatch } from "react-router";
import {
  useInbox,
  useMarkInboxItemsRead,
  useUpdateInboxItem,
  type InboxItemRef,
} from "./api.ts";
import {
  abbr,
  approvalKindLabel,
  avatarStyle,
  formatTime,
  Loading,
  LoadError,
} from "./ui.tsx";

type Scope = "all" | "organization";
type Panel = {
  open: boolean;
  scope: Scope;
  /** 패널을 연다. 조직을 주면 그 조직 범위로 연다. */
  show: (organizationId?: string) => void;
  toggle: () => void;
  close: () => void;
  setScope: (scope: Scope) => void;
};
const PanelContext = createContext<Panel | null>(null);

export function InboxPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  // 여닫는 함수는 바뀌지 않는다. 열기 효과(`InboxRedirect`)가 상태 변화마다 다시 돌지 않게 한다.
  const actions = useMemo(
    () => ({
      show: (organizationId?: string) => {
        setScope(organizationId ? "organization" : "all");
        setOpen(true);
      },
      toggle: () => setOpen((o) => !o),
      close: () => setOpen(false),
      setScope,
    }),
    []
  );
  const panel = useMemo<Panel>(
    () => ({ open, scope, ...actions }),
    [open, scope, actions]
  );
  return (
    <PanelContext.Provider value={panel}>{children}</PanelContext.Provider>
  );
}

export function useInboxPanel() {
  const panel = useContext(PanelContext);
  if (!panel) throw new Error("InboxPanelProvider가 없습니다");
  return panel;
}

/** 예전 Inbox 주소. 패널을 열고 홈으로 간다. */
export function InboxRedirect() {
  const { show } = useInboxPanel();
  useEffect(() => show(), [show]);
  return <Navigate to="/" replace />;
}

const docked = "(min-width: 1280px)";
function useDocked() {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(docked);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => matchMedia(docked).matches
  );
}

/**
 * 주의 필요 수. 레일·조직 카드·패널이 같은 판정(`needsAttention`)을 쓴다. 조직을 주면 그 조직만 센다.
 * 불러오는 중·오류는 0이 아니라 `undefined`다.
 */
export function useAttention(organizationId?: string) {
  const inbox = useInbox();
  const count = inbox.data?.filter(
    (item) =>
      needsAttention(item) &&
      (!organizationId || inboxOrganizationId(item) === organizationId)
  ).length;
  return { count, isError: inbox.isError };
}

const itemKey = (item: InboxItem) => `${item.kind}:${inboxSourceId(item)}`;
const refOf = (item: InboxItem): InboxItemRef => ({
  organizationId: inboxOrganizationId(item),
  kind: item.kind,
  sourceId: inboxSourceId(item),
});

const filterLabel: Record<InboxFilter, string> = {
  attention: "주의 필요",
  all: "전체",
  unread: "읽지 않음",
  archived: "보관됨",
};
const filterOrder = ["attention", "all", "unread", "archived"] as const;
const emptyText: Record<InboxFilter, string> = {
  attention: "주의가 필요한 항목이 없습니다.",
  unread: "읽지 않은 항목이 없습니다.",
  all: "항목이 없습니다.",
  archived: "보관한 항목이 없습니다.",
};

export function InboxPanel() {
  const panel = useInboxPanel();
  const isDocked = useDocked();
  // 붙어 있던 패널은 창이 좁아져도 본문을 가리는 drawer로 바뀌지 않고 닫힌다.
  const wasDocked = useRef(isDocked);
  const { close } = panel;
  useEffect(() => {
    if (wasDocked.current && !isDocked) close();
    wasDocked.current = isDocked;
  }, [isDocked, close]);
  if (isDocked)
    return panel.open ? (
      <aside
        aria-label="Inbox"
        className="animate-slide-in-right flex w-[340px] shrink-0 flex-col border-l border-slate-200/70 bg-white/80 backdrop-blur"
      >
        <InboxContent onPick={() => {}} inDialog={false} />
      </aside>
    ) : null;
  return (
    <Dialog.Root
      open={panel.open}
      onOpenChange={(open) => (open ? panel.show() : panel.close())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[340px] max-w-full flex-col bg-white shadow-pop data-[state=closed]:animate-slide-out-right data-[state=open]:animate-slide-in-right"
        >
          <InboxContent onPick={panel.close} inDialog />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InboxContent({
  onPick,
  inDialog,
}: {
  onPick: () => void;
  inDialog: boolean;
}) {
  const panel = useInboxPanel();
  const inbox = useInbox();
  // Inbox 상세도 그 항목의 조직을 현재 조직으로 본다.
  const orgPageOrg = useMatch("/orgs/:orgId/*")?.params.orgId;
  const inboxDetailOrg = useMatch("/inbox/:orgId/*")?.params.orgId;
  const currentOrg = orgPageOrg ?? inboxDetailOrg;
  const [filter, setFilter] = useState<InboxFilter>("attention");
  const scoped = panel.scope === "organization" && currentOrg;
  const inScope = (inbox.data ?? []).filter(
    (item) => !scoped || inboxOrganizationId(item) === currentOrg
  );
  const shown = inScope
    .filter(inboxFilters[filter])
    .sort((a, b) => inboxItemTime(b).localeCompare(inboxItemTime(a)));
  // 체크한 항목. 지금 보이는 항목 중에서만 센다(필터·범위를 바꾸면 보이지 않는 항목은 빠진다).
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const checkedShown = shown.filter((item) => checked.has(itemKey(item)));
  const toggle = (item: InboxItem) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(itemKey(item))) next.add(itemKey(item));
      return next;
    });
  const markRead = useMarkInboxItemsRead();
  return (
    <>
      <div className="flex items-center gap-2 border-b border-slate-200/70 px-4 py-3">
        {inDialog ? (
          <Dialog.Title className="flex-1 text-base font-semibold">
            Inbox
          </Dialog.Title>
        ) : (
          <h2 className="flex-1 text-base font-semibold">Inbox</h2>
        )}
        <button
          onClick={panel.close}
          aria-label="Inbox 닫기"
          className="btn-ghost px-2"
        >
          ✕
        </button>
      </div>
      <div className="space-y-2 border-b border-slate-200/70 px-4 py-3">
        <div
          className="flex rounded-xl bg-slate-100 p-0.5 text-xs"
          role="group"
          aria-label="범위"
        >
          {(["all", "organization"] as const).map((s) => (
            <button
              key={s}
              disabled={s === "organization" && !currentOrg}
              aria-pressed={(s === "organization") === !!scoped}
              onClick={() => panel.setScope(s)}
              className={`flex-1 rounded-lg px-2 py-1 transition disabled:opacity-40 ${(s === "organization") === !!scoped ? "bg-white font-semibold shadow-sm" : "text-slate-500"}`}
            >
              {s === "all" ? "전체 조직" : "현재 조직"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="필터">
          {filterOrder.map((f) => {
            const count = inbox.data
              ? inScope.filter(inboxFilters[f]).length
              : null;
            return (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-2.5 py-1 text-xs transition ${filter === f ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {filterLabel[f]}{" "}
                <span className="tabular-nums">{count ?? "…"}</span>
              </button>
            );
          })}
        </div>
      </div>
      {checkedShown.length > 0 && (
        <div
          className="flex items-center gap-2 border-b border-slate-200/70 bg-slate-50 px-4 py-2 text-xs"
          role="group"
          aria-label="선택한 항목"
        >
          <span className="flex-1 text-slate-600">
            {checkedShown.length}개 선택
          </span>
          <button
            className="btn-soft px-2 py-1 text-xs"
            disabled={markRead.isPending}
            onClick={() =>
              markRead.mutate(
                checkedShown.filter((item) => !item.read).map(refOf),
                { onSuccess: () => setChecked(new Set()) }
              )
            }
          >
            모두 읽음
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => setChecked(new Set())}
          >
            선택 해제
          </button>
        </div>
      )}
      {markRead.isError && (
        <p role="alert" className="px-4 py-2 text-xs text-rose-700">
          일부 항목을 읽음으로 바꾸지 못했습니다. 다시 시도하세요.
        </p>
      )}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {inbox.isPending ? (
          <Loading />
        ) : inbox.isError ? (
          <LoadError what="Inbox" onRetry={() => void inbox.refetch()} />
        ) : !shown.length ? (
          <p className="p-4 text-sm text-slate-500">{emptyText[filter]}</p>
        ) : (
          <ul
            className="divide-y divide-slate-100"
            aria-label={filterLabel[filter]}
          >
            {shown.map((item) => (
              <li key={itemKey(item)}>
                <InboxRow
                  item={item}
                  checked={checked.has(itemKey(item))}
                  onCheck={() => toggle(item)}
                  onPick={onPick}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** 항목 → 제목·부가 설명. */
function describe(item: InboxItem) {
  if (item.kind === "approval")
    return {
      title: approvalKindLabel[item.approval.kind],
      detail: item.approval.previousApprovalId ? "다시 제출됨" : null,
    };
  if (item.kind === "result_submission")
    return {
      title: "결과 제출",
      detail: item.submission.previousSubmissionId ? "다시 제출됨" : null,
    };
  return {
    title: "실행 시도 실패",
    detail: `${item.agentName}${item.run.error ? ` · ${item.run.error}` : ""}`,
  };
}

function InboxRow({
  item,
  checked,
  onCheck,
  onPick,
}: {
  item: InboxItem;
  checked: boolean;
  onCheck: () => void;
  onPick: () => void;
}) {
  const organizationId = inboxOrganizationId(item);
  const { title, detail } = describe(item);
  const to = inboxDetailPath(organizationId, item.kind, inboxSourceId(item));
  // 지금 연 항목을 표시한다.
  const current = useMatch(to) !== null;
  const at = inboxItemTime(item);
  return (
    <div className="flex items-start gap-1 px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        aria-label={`${title} · ${item.organizationName} 선택`}
        className="mt-3 h-4 w-4 shrink-0 accent-brand-600"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          onClick={onPick}
          aria-current={current ? "page" : undefined}
          className={`flex items-start gap-3 rounded-xl p-1 text-sm transition hover:bg-slate-50 ${current ? "bg-brand-50/60 ring-1 ring-brand-200" : ""}`}
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-white"
            style={avatarStyle(organizationId)}
          >
            {abbr(item.organizationName)}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block ${item.read ? "text-slate-600" : "font-semibold text-slate-900"}`}
            >
              {title}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {item.organizationName}
              {detail && ` · ${detail}`}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {needsAttention(item) && (
                <span className="chip bg-amber-50 text-amber-800">
                  주의 필요
                </span>
              )}
              {!item.read && (
                <span className="chip bg-brand-50 text-brand-700">
                  읽지 않음
                </span>
              )}
              {item.archived && (
                <span className="chip bg-slate-100 text-slate-600">보관됨</span>
              )}
              <time
                dateTime={at}
                className="text-[11px] text-slate-400 tabular-nums"
              >
                {formatTime(at)}
              </time>
            </span>
          </span>
        </Link>
        <div className="mt-1 pl-12">
          <InboxItemOrganize item={item} label={`${title} 정리`} />
        </div>
      </div>
    </div>
  );
}

/**
 * 알림 정리 버튼. 읽은 항목은 읽지 않음으로 되돌릴 수 있고(읽음은 항목을 열거나 체크해 한꺼번에),
 * 실패한 실행 시도는 보관·보관 해제한다(결정을 기다리는 항목은 보관하지 않고 결정하면 빠진다).
 * 패널 행과 Inbox 상세가 같은 명령으로 쓴다. 업무 결정과 따로다.
 */
export function InboxItemOrganize({
  item,
  label,
}: {
  item: InboxItem;
  label: string;
}) {
  const update = useUpdateInboxItem({
    organizationId: inboxOrganizationId(item),
    kind: item.kind,
    sourceId: inboxSourceId(item),
  });
  return (
    <>
      <div className="flex gap-1" role="group" aria-label={label}>
        {item.read && (
          <button
            className="btn-ghost px-2 py-1 text-xs"
            disabled={update.isPending}
            onClick={() => update.mutate({ read: false })}
          >
            읽지 않음
          </button>
        )}
        {canArchiveInboxItem(item.kind) && (
          <button
            className="btn-ghost px-2 py-1 text-xs"
            disabled={update.isPending}
            onClick={() => update.mutate({ archived: !item.archived })}
          >
            {item.archived ? "보관 해제" : "보관"}
          </button>
        )}
      </div>
      {update.isError && (
        <p role="alert" className="mt-1 text-xs text-rose-700">
          정리하지 못했습니다. 상태는 그대로입니다. 다시 시도하세요.
        </p>
      )}
    </>
  );
}
