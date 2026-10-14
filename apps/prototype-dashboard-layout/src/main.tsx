// PROTOTYPE (#50) — throwaway. Three dashboard layouts of the same mock data on one app,
// switchable via ?variant=A|B|C and the floating bar. Question: which shell / org tabs /
// Inbox / Home arrangement should 판 1 build on?
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useSearchParams } from "react-router";
import "./index.css";
import { StoreProvider, Toaster } from "./shared";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { VariantA } from "./variants/A";
import { VariantB } from "./variants/B";
import { VariantC } from "./variants/C";

// C was picked on 2026-10-14; A/B stay only for comparison and keep the first-round look.
export const VARIANTS = [
  { key: "C", name: "조직 레일 + 세로 섹션 + Inbox 패널", C: VariantC },
  { key: "A", name: "조직 사이드바 + 가로 탭 (1차)", C: VariantA },
  { key: "B", name: "조직 switcher + 상단 바 (1차)", C: VariantB },
];

function App() {
  const [sp] = useSearchParams();
  const v = VARIANTS.find((x) => x.key === sp.get("variant")) ?? VARIANTS[0];
  return (
    <>
      <v.C key={v.key} />
      <Toaster />
      {import.meta.env.DEV && <PrototypeSwitcher variants={VARIANTS} current={v.key} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <App />
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>,
);
