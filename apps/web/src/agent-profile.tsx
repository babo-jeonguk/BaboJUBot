import {
  agentNameMaxLength,
  faceAccessories,
  faceColors,
  faceEyes,
  faceMouths,
  type AgentAppearance,
  type AgentDetail,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState, type ReactNode } from "react";
import {
  AgentFace,
  faceAccessoryLabel,
  faceColorStyle,
  faceEyeLabel,
  faceMoodOf,
  faceMouthLabel,
} from "./agent-face.tsx";
import { ApiError, useUpdateAgentProfile } from "./api.ts";

// 에이전트 상세 머리의 이름 바꾸기와 얼굴 꾸미기. 둘 다 사용자 변경이며 서버가 확정한 값만 보인다.

const nameError = (error: unknown) =>
  error instanceof ApiError && error.code === "name_taken"
    ? "같은 이름의 에이전트가 이미 있습니다."
    : "이름을 바꾸지 못했습니다. 다시 시도하세요.";

/** 이름을 누르면 입력칸이 되고, Enter·포커스 이동은 저장, Esc는 취소다. 비우거나 그대로면 저장하지 않는다. */
export function AgentNameEditor({
  orgId,
  agent,
}: {
  orgId: string;
  agent: Pick<AgentDetail, "id" | "name">;
}) {
  const update = useUpdateAgentProfile(orgId, agent.id);
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  const close = () => {
    done.current = true;
    setDraft(null);
    update.reset();
  };
  const save = () => {
    if (done.current || draft === null || update.isPending) return;
    const name = draft.trim();
    if (!name || name === agent.name) return close();
    update.mutate({ name }, { onSuccess: close });
  };
  if (draft === null)
    return (
      <h1 className="text-xl font-semibold">
        <button
          type="button"
          title="이름 바꾸기"
          className="group -mx-1.5 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1.5 text-left transition hover:bg-slate-900/5 focus-visible:outline-2 focus-visible:outline-brand-500"
          onClick={() => {
            done.current = false;
            setDraft(agent.name);
          }}
        >
          <span className="truncate">{agent.name}</span>
          <PencilIcon className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500 group-focus-visible:text-slate-500" />
        </button>
      </h1>
    );
  return (
    <div>
      <input
        aria-label="에이전트 이름"
        autoFocus
        value={draft}
        maxLength={agentNameMaxLength}
        readOnly={update.isPending}
        aria-invalid={update.isError || undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          if (update.isError) update.reset();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        onBlur={save}
        className="-mx-1.5 w-full max-w-sm rounded-lg bg-white px-1.5 text-xl font-semibold ring-2 ring-brand-500 outline-none aria-invalid:ring-rose-400"
      />
      {update.isError && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          {nameError(update.error)}
        </p>
      )}
    </div>
  );
}

/** 얼굴을 누르면 꾸미기 창이 열린다. 고르는 대로 미리 보이고, 저장해야 다른 화면에도 바뀐다. */
export function FaceCustomizer({
  orgId,
  agent,
}: {
  orgId: string;
  agent: AgentDetail;
}) {
  const update = useUpdateAgentProfile(orgId, agent.id);
  const [draft, setDraft] = useState<AgentAppearance | null>(null);
  const open = draft !== null;
  const shown = draft ?? agent.appearance;
  const set = (patch: Partial<AgentAppearance>) =>
    setDraft({ ...shown, ...patch });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        update.reset();
        setDraft(next ? agent.appearance : null);
      }}
    >
      <Dialog.Trigger
        title="얼굴 꾸미기"
        aria-label="얼굴 꾸미기"
        className="group relative shrink-0 rounded-full transition hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <AgentFace
          appearance={agent.appearance}
          mood={faceMoodOf(agent)}
          size={64}
          seed={agent.id}
        />
        <span className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-500 shadow-card ring-1 ring-slate-200 transition group-hover:text-brand-600">
          <PencilIcon className="h-3.5 w-3.5" />
        </span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/30 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="animate-pop-in fixed top-1/2 left-1/2 z-[71] max-h-[calc(100dvh-2rem)] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-5 shadow-pop"
        >
          <Dialog.Title className="text-base font-semibold">
            얼굴 꾸미기
          </Dialog.Title>
          <div className="my-4 flex justify-center rounded-2xl bg-slate-50 py-4">
            <AgentFace
              appearance={shown}
              size={120}
              seed={agent.id}
              label={`${agent.name} 얼굴 미리 보기`}
            />
          </div>
          <Choices label="색">
            {faceColors.map((color) => (
              <Choice
                group="face-color"
                key={color}
                label={faceColorStyle[color].label}
                checked={shown.color === color}
                onPick={() => set({ color })}
              >
                <span
                  className="block h-7 w-7 rounded-full ring-2 ring-inset"
                  style={
                    {
                      background: faceColorStyle[color].fill,
                      "--tw-ring-color": faceColorStyle[color].shade,
                    } as React.CSSProperties
                  }
                />
              </Choice>
            ))}
          </Choices>
          <Choices label="눈">
            {faceEyes.map((eyes) => (
              <Choice
                group="face-eyes"
                key={eyes}
                label={faceEyeLabel[eyes]}
                checked={shown.eyes === eyes}
                onPick={() => set({ eyes })}
              >
                <AgentFace
                  appearance={{ ...shown, eyes, accessory: "none" }}
                  size={36}
                  track={false}
                  seed={eyes}
                />
              </Choice>
            ))}
          </Choices>
          <Choices label="입">
            {faceMouths.map((mouth) => (
              <Choice
                group="face-mouth"
                key={mouth}
                label={faceMouthLabel[mouth]}
                checked={shown.mouth === mouth}
                onPick={() => set({ mouth })}
              >
                <AgentFace
                  appearance={{ ...shown, mouth, accessory: "none" }}
                  size={36}
                  track={false}
                  seed={mouth}
                />
              </Choice>
            ))}
          </Choices>
          <Choices label="액세서리">
            {faceAccessories.map((accessory) => (
              <Choice
                group="face-accessory"
                key={accessory}
                label={faceAccessoryLabel[accessory]}
                checked={shown.accessory === accessory}
                onPick={() => set({ accessory })}
              >
                <AgentFace
                  appearance={{ ...shown, accessory }}
                  size={36}
                  track={false}
                  seed={accessory}
                />
              </Choice>
            ))}
          </Choices>
          {update.isError && (
            <p role="alert" className="mt-3 text-xs text-rose-600">
              얼굴을 저장하지 못했습니다. 다시 시도하세요.
            </p>
          )}
          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setDraft(randomAppearance(shown))}
            >
              🎲 무작위
            </button>
            <span className="flex-1" />
            <Dialog.Close className="btn-soft">취소</Dialog.Close>
            <button
              type="button"
              className="btn-primary"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { appearance: shown },
                  { onSuccess: () => setDraft(null) }
                )
              }
            >
              {update.isPending ? "저장하는 중…" : "저장"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 프리셋 하나를 고르는 묶음. 실제 radio라 화살표 키로 옮겨 다닌다. */
function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="mt-3">
      <legend className="mb-1.5 text-xs font-semibold text-slate-500">
        {label}
      </legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

function Choice({
  group,
  label,
  checked,
  onPick,
  children,
}: {
  group: string;
  label: string;
  checked: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <label
      title={label}
      className={`relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl transition hover:bg-slate-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-500 ${checked ? "bg-brand-50 ring-2 ring-brand-500" : "ring-1 ring-slate-200"}`}
    >
      <input
        type="radio"
        name={group}
        aria-label={label}
        checked={checked}
        onChange={onPick}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
      {/* 보이지 않는 radio가 칸 전체를 덮어 누름을 받는다. */}
      <span className="pointer-events-none flex">{children}</span>
    </label>
  );
}

/** 지금 얼굴과 다른 무작위 조합. */
function randomAppearance(current: AgentAppearance): AgentAppearance {
  const pick = <T,>(options: readonly T[]) =>
    options[Math.floor(Math.random() * options.length)]!;
  for (;;) {
    const next: AgentAppearance = {
      color: pick(faceColors),
      eyes: pick(faceEyes),
      mouth: pick(faceMouths),
      accessory: pick(faceAccessories),
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) return next;
  }
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M13.5 3.5l3 3L7 16l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
