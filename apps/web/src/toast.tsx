import * as Tooltip from "@radix-ui/react-tooltip";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tip } from "./ui.tsx";

// 화면 아래 가운데의 토스트 하나. 되돌릴 수 있는 일은 묻지 않고 바로 한 뒤 여기서 되돌리기를 준다.
// 새 토스트는 이전 토스트를 바꾼다. 마우스를 올리거나 포커스가 안에 있으면 시간이 멈추고, Esc나 닫기 버튼으로 닫는다.

/** 되돌리기 버튼을 누를 수 있게 충분히 오래 보인다. */
export const toastDurationMs = 10_000;

export type ToastInput = {
  message: string;
  action?: { label: string; onAction: () => void };
};

type Shown = ToastInput & { id: number };

const ShowToast = createContext<(toast: ToastInput) => void>(() => {});

/** 토스트를 띄우는 함수. `ToastProvider` 아래에서 쓴다. */
export const useToast = () => useContext(ShowToast);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Shown | null>(null);
  const next = useRef(0);
  const show = useCallback(
    (input: ToastInput) => setToast({ ...input, id: ++next.current }),
    []
  );
  const dismiss = useCallback(
    (id: number) =>
      setToast((current) => (current?.id === id ? null : current)),
    []
  );
  return (
    <ShowToast.Provider value={show}>
      {children}
      {/* 화면 낭독기가 새 토스트를 읽도록 영역은 늘 있다. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-[90] flex justify-center px-4"
      >
        {toast && (
          <Tooltip.Provider delayDuration={150}>
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          </Tooltip.Provider>
        )}
      </div>
    </ShowToast.Provider>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: Shown;
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const remaining = useRef(toastDurationMs);
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [held, onDismiss, toast.id]);
  const close = () => onDismiss(toast.id);
  return (
    <div
      data-testid="toast"
      className="animate-toast-in pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl bg-slate-900 py-1.5 pr-1.5 pl-4 text-sm text-white shadow-pop"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <span className="min-w-0 py-1 pr-2">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="shrink-0 rounded-xl px-3 py-1.5 font-semibold text-brand-200 transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-brand-200"
          onClick={() => {
            toast.action!.onAction();
            close();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <Tip content="닫기">
        <button
          type="button"
          aria-label="닫기"
          onClick={close}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-brand-200"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </Tip>
    </div>
  );
}
