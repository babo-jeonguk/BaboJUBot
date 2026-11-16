// 승인 요청·결과 제출의 결정 영역 공통 표시(#144, docs/research/issue-144-references.md D01–D09).
// 결정 대기면 폼, 아니면 결정 기록을 보이고, 전송 중·오류 안내와 조직 상태 안내의 자리, 이 화면에서 성공했을 때
// 결정 기록으로 옮기는 포커스를 맡는다. 허용 결정·사유 조건·결정 가능 여부·안내 문구·작업자 선택·최종 완료 재확인은
// 각 폼이 정한다. 필드 오류 포커스와 인라인 확인의 취소 복귀도 각 폼과 기존 기능(`useInlineConfirm`·`ProviderChoiceFields`)의 몫이다.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api.ts";
import { focusLost, formatTime } from "./ui.tsx";

/** 중단된 조직에서 결정할 수 없는 종류(초기 연구 승인·결과 검토)의 폼이 보이는 안내. 어느 종류가 막히는지는 폼이 정한다. */
export const closedOrganizationNotice = "중단된 조직이라 결정할 수 없습니다.";

/**
 * 결정 영역. 이 화면의 결정 성공(`onDecided`)만 결정 기록으로 포커스를 옮긴다. 다른 화면의 결정이 Event로 오거나
 * 이미 결정됐다는 거절 뒤 다시 불러와 기록으로 바뀌면 포커스를 두고 간다.
 * 결정 명령(`useDecide…`)은 이 영역을 감싼 컴포넌트에 둔다. 폼은 응답보다 먼저 온 Event로 사라질 수 있는데, 명령이
 * 폼에 있으면 그때 이 화면의 성공을 받지 못한다. 항목이 바뀌면(`key`) 명령과 함께 사라져 늦은 응답이 다른 항목에 닿지 않는다.
 */
export function DecisionArea({
  pending,
  form,
  record,
}: {
  pending: boolean;
  form: (onDecided: () => void) => ReactNode;
  record: (focus: boolean) => ReactNode;
}) {
  const [decidedHere, setDecidedHere] = useState(false);
  return pending ? form(() => setDecidedHere(true)) : record(decidedHere);
}

/**
 * 결정 폼의 외곽: 제목, 조직 상태 안내, 전송 중 안내, 폼 전체 오류 안내. 안내 문구와 결정 가능 여부는 폼이 정해 넘긴다.
 * 오류는 이미 결정됨·조직 끝남·그 밖의 실패를 공통으로 말하고, 폼만의 거절은 `describeError`로 덧붙인다.
 * 필드에 연결하지 않으며 포커스를 옮기지 않는다.
 */
export function DecisionFormFrame({
  notice,
  sending,
  error,
  subject,
  describeError,
  children,
}: {
  notice: string | null;
  sending: boolean;
  error: Error | null;
  /** 이미 결정됐다는 안내에서 부를 이름. */
  subject: "요청" | "제출";
  describeError?: (error: ApiError) => string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      id="decision"
      aria-label="결정"
      className="card scroll-mt-4 p-4 ring-2 ring-amber-200"
    >
      <h2 className="mb-3 text-sm font-semibold">결정</h2>
      {notice && (
        <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-xs break-keep text-slate-700">
          {notice}
        </p>
      )}
      {children}
      {sending && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          결정을 보내는 중…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {errorMessage(error, subject, describeError)}
        </p>
      )}
    </section>
  );
}

function errorMessage(
  error: Error,
  subject: "요청" | "제출",
  describe?: (error: ApiError) => string | undefined
) {
  if (!(error instanceof ApiError))
    return "보내지 못했습니다. 다시 시도하세요.";
  if (error.code === "already_decided")
    return `이미 결정된 ${subject}입니다. 최신 결정을 불러옵니다.`;
  if (error.code === "organization_closed")
    return "조직이 중단되어 결정을 받지 않았습니다.";
  return describe?.(error) ?? "보내지 못했습니다. 다시 시도하세요.";
}

/**
 * 결정 기록: 결정 상태와 시각, 사유·의견, 종류별 내용(`children`). `focus`면 사라진 폼 대신 이 기록으로 포커스를 옮긴다.
 * 그사이 사용자가 다른 곳으로 포커스를 옮겼으면 빼앗지 않는다.
 */
export function DecisionRecord({
  focus,
  title,
  decidedAt,
  note,
  children,
}: {
  focus: boolean;
  title: string;
  decidedAt: string | null;
  note: { label: string; text: string | null };
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus && focusLost()) ref.current?.focus();
  }, [focus]);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="결정"
      className="card p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
    >
      <h2 className="mb-2 text-sm font-semibold">
        {title}
        {decidedAt && (
          <span className="ml-2 font-normal text-slate-500">
            {formatTime(decidedAt)}
          </span>
        )}
      </h2>
      {note.text && (
        <p className="mb-2 break-words whitespace-pre-wrap">
          {note.label}: {note.text}
        </p>
      )}
      {children}
    </section>
  );
}
