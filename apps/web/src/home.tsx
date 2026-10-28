// 홈: 에이전트 로비(docs/research/home-references.md 결정). 연구 조직 하나가 방 하나이고, 방은 만든 순서로 놓여
// 상태가 바뀌어도 움직이지 않는다. 위에는 주의 필요·작업 중·조직 수, 끝난 조직은 아래에 접어 둔다.
import { activeRunCount, type Overview } from "@babojubot/contracts";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useInbox, useOverview } from "./api.ts";
import { useOpenCreateOrganization } from "./create-organization.tsx";
import { arrangeHome, type HomeRoom } from "./home-model.ts";
import { Room } from "./home-room.tsx";
import "./home.css";
import { useInboxPanel } from "./inbox.tsx";
import { Loading, LoadError, Page } from "./ui.tsx";

export function Home() {
  const overview = useOverview();
  const inbox = useInbox();
  const small = useSmall();
  const now = useNow();
  if (overview.isPending) return <Loading />;
  if (overview.isError)
    return (
      <LoadError what="연구 조직" onRetry={() => void overview.refetch()} />
    );
  if (!overview.data.organizations.length) return <NoOrganizations />;

  const { open, closed, totalAttention } = arrangeHome(
    overview.data,
    inbox.data ?? []
  );

  return (
    <Page width="full">
      <div className="home-lobby mx-auto max-w-[90rem]">
        <Summary
          organizations={overview.data.organizations.length}
          attention={
            inbox.isError ? "error" : inbox.data ? totalAttention : undefined
          }
          onRetryAttention={() => void inbox.refetch()}
          runs={overview.data.runs}
        />
        <div className="space-y-8">
          {open.length > 0 && (
            <div className="room-grid">
              {open.map((room) => (
                <Room
                  key={room.org.organizationId}
                  room={room}
                  small={small}
                  now={now}
                />
              ))}
            </div>
          )}
          {closed.length > 0 && (
            <Closed
              rooms={closed}
              defaultOpen={!open.length}
              small={small}
              now={now}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

// ---------- 위쪽 요약 ----------

function Summary({
  organizations,
  attention,
  onRetryAttention,
  runs,
}: {
  organizations: number;
  attention: number | "error" | undefined;
  onRetryAttention: () => void;
  runs: Overview["runs"];
}) {
  const openCreate = useOpenCreateOrganization();
  const panel = useInboxPanel();
  const hot = typeof attention === "number" && attention > 0;
  const working = activeRunCount(runs);
  return (
    <div className="mb-6 flex flex-wrap items-stretch gap-3">
      <div className="card grid min-w-0 flex-1 grid-cols-3 divide-x divide-slate-100 overflow-hidden sm:flex sm:flex-none">
        <button
          onClick={
            attention === "error" ? onRetryAttention : () => panel.show()
          }
          aria-label={
            attention === "error"
              ? "주의 수를 불러오지 못함 · 다시 시도"
              : `주의 필요 ${attention ?? "…"}개 · Inbox 열기`
          }
          className={`${cell} text-left transition duration-150 ${hot ? "bg-amber-50 hover:bg-amber-100/70" : "hover:bg-slate-50"}`}
        >
          <Label dot={hot ? "bg-amber-500" : "bg-slate-300"}>주의 필요</Label>
          <span
            className={`text-2xl font-semibold tabular-nums ${hot ? "text-amber-800" : attention === "error" ? "text-rose-600" : "text-slate-800"}`}
            data-testid="attention-count"
          >
            {attention === "error" ? "!" : (attention ?? "…")}
          </span>
        </button>
        <div className={cell}>
          <Label dot={working > 0 ? "home-pulse bg-brand-500" : "bg-slate-300"}>
            작업 중
          </Label>
          <span className="flex items-baseline gap-2">
            <span
              className="text-2xl font-semibold text-slate-800 tabular-nums"
              data-testid="running-run-count"
            >
              {working}
            </span>
            {runs.cancelling > 0 && (
              <span
                className="text-xs text-amber-700"
                data-testid="cancelling-run-count"
              >
                취소 정리 중 {runs.cancelling}
              </span>
            )}
          </span>
        </div>
        <div className={cell}>
          <Label>연구 조직</Label>
          <span
            className="text-2xl font-semibold text-slate-800 tabular-nums"
            data-testid="organization-count"
          >
            {organizations}
          </span>
        </div>
      </div>
      <button
        className="btn-primary w-full self-center py-2 sm:ml-auto sm:w-auto"
        onClick={openCreate}
      >
        ＋ 새 연구 조직
      </button>
    </div>
  );
}

const cell =
  "flex min-w-0 flex-col items-start gap-0.5 px-4 py-2.5 sm:min-w-32 sm:px-5";

function Label({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-slate-500">
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
      {children}
    </span>
  );
}

// ---------- 끝난 조직 ----------

function Closed({
  rooms,
  defaultOpen,
  small,
  now,
}: {
  rooms: HomeRoom[];
  defaultOpen: boolean;
  small: boolean;
  now: number;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="mb-3 flex w-fit cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-semibold text-slate-500 transition select-none hover:text-slate-700 [&::-webkit-details-marker]:hidden">
        <span className="text-[10px] transition group-open:rotate-90">▶</span>
        끝난 조직
        <span
          className="font-normal text-slate-400 tabular-nums"
          data-testid="closed-organization-count"
        >
          {rooms.length}
        </span>
      </summary>
      <div className="room-grid" data-closed>
        {rooms.map((room) => (
          <Room
            key={room.org.organizationId}
            room={room}
            small={small}
            now={now}
          />
        ))}
      </div>
    </details>
  );
}

// ---------- 화면 폭·시각 ----------

const smallQuery = "(max-width: 640px)";
/** 작은 화면이면 자리를 줄인다(한 줄에 Lead + 작업자 셋). */
function useSmall() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(smallQuery);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => matchMedia(smallQuery).matches
  );
}

/** 상대 시각을 1분마다 다시 그린다. 개요는 Event가 올 때만 다시 불러오므로 시계는 따로 둔다. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function NoOrganizations() {
  const openCreate = useOpenCreateOrganization();
  return (
    <div className="card animate-fade-up mx-auto mt-16 max-w-sm p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">
        🧭
      </div>
      <div className="font-semibold">아직 연구 조직이 없습니다</div>
      <button className="btn-primary mt-5" onClick={openCreate}>
        ＋ 새 연구 조직
      </button>
    </div>
  );
}
