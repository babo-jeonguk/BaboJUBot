import {
  goalMaxLength,
  organizationNameMaxLength,
  type ProviderChoice,
} from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { useCreateOrganization, useProviderSettings } from "./api.ts";
import { ProviderChoiceFields } from "./provider-choice.tsx";

const labelClass = "text-xs font-medium text-slate-600";
const fieldClass =
  "mt-1 w-full rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400";

const OpenCreate = createContext<() => void>(() => {});
/** 레일 ＋와 조직 없음 빈 상태가 같은 dialog를 연다. */
export const useOpenCreateOrganization = () => useContext(OpenCreate);

/**
 * 조직 생성 dialog. 입력은 이 provider가 가지므로 `닫기`·Esc·바깥 누르기로 닫아도 초안으로 남고, 만든 뒤에만 비운다.
 * Lead 프로바이더·모델은 고르기 전까지 전역 Lead 기본값을 따르고, 고르면 그 값이 초안이다. 좁은 화면에서는 아래에서 올라오는 시트다.
 */
export function CreateOrganizationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [lead, setLead] = useState<ProviderChoice | null>(null);
  const providers = useProviderSettings();
  const leadChoice = lead ?? providers.data?.leadDefault;
  const create = useCreateOrganization();
  const navigate = useNavigate();
  // 닫았다가 다시 연 뒤 도착한 이전 요청의 응답이 지금 화면을 덮지 않게 요청마다 번호를 붙인다.
  const attempt = useRef(0);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    attempt.current++;
    create.reset();
  };
  const clear = () => {
    setName("");
    setGoal("");
    setCriteria("");
    setLead(null);
  };
  const ready = !!name.trim() && !!goal.trim();

  const submit = async () => {
    if (!ready || create.isPending) return;
    const mine = ++attempt.current;
    try {
      // 완료 기준을 비우면 보내지 않는다. Lead가 초기 연구 승인 요청에서 제안한다.
      const org = await create.mutateAsync({
        name: name.trim(),
        goal: goal.trim(),
        ...(criteria.trim() ? { completionCriteria: criteria.trim() } : {}),
        // 설정을 읽지 못했으면 보내지 않는다. 서버가 전역 Lead 기본값을 쓴다.
        ...(leadChoice ? { lead: leadChoice } : {}),
      });
      if (attempt.current !== mine) return;
      setOpen(false);
      clear();
      navigate(`/orgs/${org.id}/chat`);
    } catch {
      // 오류는 create.error로 보이고 입력은 그대로 둔다.
    }
  };

  return (
    <OpenCreate.Provider value={() => changeOpen(true)}>
      {children}
      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-x-0 bottom-0 z-[71] max-h-[calc(100dvh-2rem)] animate-fade-up overflow-y-auto rounded-t-2xl bg-white p-6 shadow-pop md:inset-x-auto md:top-[max(1rem,10vh)] md:bottom-auto md:left-1/2 md:w-[min(520px,calc(100vw-2rem))] md:-translate-x-1/2 md:animate-pop-in md:rounded-2xl"
          >
            <Dialog.Title className="text-lg font-semibold">
              새 연구 조직
            </Dialog.Title>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div>
                <label className={labelClass} htmlFor="org-name">
                  조직 이름
                </label>
                <input
                  id="org-name"
                  autoFocus
                  required
                  value={name}
                  maxLength={organizationNameMaxLength}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 한국어 음성 인식 오류 분석"
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="org-goal">
                  연구 목표
                </label>
                <textarea
                  id="org-goal"
                  required
                  rows={3}
                  value={goal}
                  maxLength={goalMaxLength}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="예: 한국어 음성 인식 오류율을 절반으로 줄인다"
                  className={`${fieldClass} resize-y`}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="org-criteria">
                  완료 기준{" "}
                  <span className="font-normal text-slate-400">(선택)</span>
                </label>
                <textarea
                  id="org-criteria"
                  rows={3}
                  value={criteria}
                  maxLength={goalMaxLength}
                  onChange={(e) => setCriteria(e.target.value)}
                  placeholder="비워 두면 Lead가 제안합니다"
                  className={`${fieldClass} resize-y`}
                />
              </div>
              {providers.data && leadChoice && (
                <ProviderChoiceFields
                  idPrefix="org-lead"
                  label="Lead"
                  providers={providers.data.providers}
                  value={leadChoice}
                  onChange={setLead}
                />
              )}
              {create.isError && (
                <p role="alert" className="text-xs text-rose-600">
                  만들지 못했습니다. 다시 시도하세요.
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Dialog.Close className="btn-soft">닫기</Dialog.Close>
                <button
                  className="btn-primary"
                  disabled={!ready || create.isPending}
                >
                  {create.isPending ? "만드는 중…" : "만들기"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </OpenCreate.Provider>
  );
}
