import { organizationNameMaxLength } from "@babojubot/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { useCreateOrganization } from "./api.ts";

const OpenCreate = createContext<() => void>(() => {});
/** 레일 ＋와 조직 없음 빈 상태가 같은 dialog를 연다. */
export const useOpenCreateOrganization = () => useContext(OpenCreate);

export function CreateOrganizationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const create = useCreateOrganization();
  const navigate = useNavigate();
  // 닫았다가 다시 연 뒤 도착한 이전 요청의 응답이 지금 화면을 덮지 않게 요청마다 번호를 붙인다.
  const attempt = useRef(0);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    attempt.current++;
    create.reset();
    if (!next) setName("");
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    const mine = ++attempt.current;
    try {
      const org = await create.mutateAsync({ name: trimmed });
      if (attempt.current !== mine) return;
      setOpen(false);
      setName("");
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
          <Dialog.Content className="animate-pop-in fixed top-[18vh] left-1/2 z-[71] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-white p-6 shadow-pop">
            <Dialog.Title className="text-lg font-semibold">
              새 연구 조직
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-slate-500">
              연구 목표 하나가 조직 하나가 됩니다. 이름만 정하면 전용 Research
              Lead가 함께 생기고, 목표와 완료 기준은 Lead 대화에서 정합니다.
            </Dialog.Description>
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label
                className="text-xs font-medium text-slate-600"
                htmlFor="org-name"
              >
                조직 이름
              </label>
              <input
                id="org-name"
                autoFocus
                value={name}
                maxLength={organizationNameMaxLength}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 한국어 음성 인식 오류 분석"
                className="mt-1 w-full rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 transition outline-none focus:bg-white focus:ring-2 focus:ring-brand-400"
              />
              {create.isError && (
                <p role="alert" className="mt-2 text-xs text-rose-600">
                  조직을 만들지 못했습니다. 입력은 그대로 두었으니 다시
                  시도하세요.
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close className="btn-soft">취소</Dialog.Close>
                <button
                  className="btn-primary"
                  disabled={!name.trim() || create.isPending}
                >
                  {create.isPending ? "만드는 중…" : "만들고 Lead 대화로"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </OpenCreate.Provider>
  );
}
