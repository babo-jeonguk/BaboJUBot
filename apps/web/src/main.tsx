import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { CreateOrganizationProvider } from "./create-organization.tsx";
import { useLiveEvents } from "./live-events.ts";
import { Home, OrganizationScreen } from "./pages.tsx";
import { Shell } from "./shell.tsx";
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
          <Route path="orgs/:orgId/:section?" element={<OrganizationScreen />} />
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
  </StrictMode>,
);
