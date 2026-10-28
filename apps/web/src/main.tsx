import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  RouterProvider,
} from "react-router";
import { AgentDetailPage, RunDetailPage } from "./agents.tsx";
import { ApprovalDetailPage } from "./approvals.tsx";
import { CreateOrganizationProvider } from "./create-organization.tsx";
import { GlobalSettingsPage } from "./global-settings.tsx";
import { InboxDetailPage } from "./inbox-detail.tsx";
import { InboxPanelProvider, InboxRedirect } from "./inbox.tsx";
import { useLiveEvents } from "./live-events.ts";
import { Home } from "./home.tsx";
import { OrganizationScreen } from "./pages.tsx";
import { ResultSubmissionPage } from "./results.tsx";
import { Shell } from "./shell.tsx";
import { ToastProvider } from "./toast.tsx";
import { ArtifactPage, TaskDetailPage } from "./tasks.tsx";
import { NotFound } from "./ui.tsx";
import "./index.css";

const queryClient = new QueryClient();

// `field-sizing: content`(index.css)가 없는 브라우저에서 textarea 높이를 입력에 맞춘다.
if (!CSS.supports("field-sizing", "content"))
  document.addEventListener("input", (e) => {
    if (!(e.target instanceof HTMLTextAreaElement)) return;
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  });

/**
 * 셸 바깥의 공통: 실시간 Event 구독, 조직 생성 dialog, Inbox 패널 상태, 되돌리기 토스트. data router라서 화면은 이동 차단(`useBlocker`)을 쓸 수 있다.
 */
function Root() {
  useLiveEvents();
  return (
    <CreateOrganizationProvider>
      <InboxPanelProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </InboxPanelProvider>
    </CreateOrganizationProvider>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<Root />}>
      <Route index element={<Home />} />
      <Route path="inbox" element={<InboxRedirect />} />
      <Route
        path="inbox/:orgId/:kind/:sourceId"
        element={<InboxDetailPage />}
      />
      <Route path="settings" element={<GlobalSettingsPage />} />
      <Route
        path="orgs/:orgId/approvals/:approvalId"
        element={<ApprovalDetailPage />}
      />
      <Route
        path="orgs/:orgId/results/:submissionId"
        element={<ResultSubmissionPage />}
      />
      <Route
        path="orgs/:orgId/agents/:agentId"
        element={<AgentDetailPage tab="overview" />}
      />
      <Route
        path="orgs/:orgId/agents/:agentId/instructions"
        element={<AgentDetailPage tab="instructions" />}
      />
      <Route path="orgs/:orgId/runs/:runId" element={<RunDetailPage />} />
      <Route path="orgs/:orgId/tasks/:taskId" element={<TaskDetailPage />} />
      <Route
        path="orgs/:orgId/artifacts/:artifactId"
        element={<ArtifactPage />}
      />
      <Route
        path="orgs/:orgId/chat/:conversationId"
        element={<OrganizationScreen section="chat" />}
      />
      <Route path="orgs/:orgId/:section?" element={<OrganizationScreen />} />
      <Route path="*" element={<NotFound what="화면" />} />
    </Route>
  )
);

// 화면 이동·선택(`?node=`)은 주소와 같은 때에 화면에 반영한다. 기본값인 startTransition 갱신은 TanStack Query의
// useSyncExternalStore 갱신이 이어지면 계속 다시 시작돼 최대 약 5초 늦게 반영되고, 그동안 이전 화면이 입력을 받는다.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} useTransitions={false} />
    </QueryClientProvider>
  </StrictMode>
);
