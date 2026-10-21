import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
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

function App() {
  useLiveEvents();
  return (
    <CreateOrganizationProvider>
      <Routes>
        <Route element={<Shell />}>
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
            element={<AgentDetailPage />}
          />
          <Route path="orgs/:orgId/runs/:runId" element={<RunDetailPage />} />
          <Route
            path="orgs/:orgId/tasks/:taskId"
            element={<TaskDetailPage />}
          />
          <Route
            path="orgs/:orgId/artifacts/:artifactId"
            element={<ArtifactPage />}
          />
          <Route
            path="orgs/:orgId/:section?"
            element={<OrganizationScreen />}
          />
          <Route path="*" element={<NotFound what="화면" />} />
        </Route>
      </Routes>
    </CreateOrganizationProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
