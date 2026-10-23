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
import { ApprovalDetailPage, InboxPage } from "./approvals.tsx";
import { CreateOrganizationProvider } from "./create-organization.tsx";
import { useLiveEvents } from "./live-events.ts";
import { Home, OrganizationScreen } from "./pages.tsx";
import { ResultSubmissionPage } from "./results.tsx";
import { Shell } from "./shell.tsx";
import { ArtifactPage, TaskDetailPage } from "./tasks.tsx";
import { NotFound } from "./ui.tsx";
import "./index.css";

const queryClient = new QueryClient();

/** 셸 바깥의 공통: 실시간 Event 구독과 조직 생성 dialog. data router라서 화면은 이동 차단(`useBlocker`)을 쓸 수 있다. */
function Root() {
  useLiveEvents();
  return (
    <CreateOrganizationProvider>
      <Shell />
    </CreateOrganizationProvider>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<Root />}>
      <Route index element={<Home />} />
      <Route path="inbox" element={<InboxPage />} />
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
      <Route path="orgs/:orgId/:section?" element={<OrganizationScreen />} />
      <Route path="*" element={<NotFound what="화면" />} />
    </Route>
  )
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
