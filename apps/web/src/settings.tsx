import type { OrganizationDetail } from "@babojubot/contracts";
import { useState } from "react";
import { useUpdateApprovalPolicy } from "./api.ts";

/**
 * 조직 › 설정. 첫 판은 승인 정책 체크박스 하나다(예산·job 한도·연결 채널은 후속).
 * 체크박스는 서버가 저장한 값만 보여 주고, 저장하는 동안에는 보낸 값으로 잠가 둔다. 실패하면 저장된 값으로 돌아간다.
 * 보낸 값은 누른 순간 지역 상태에 둔다. mutation 상태는 한 박자 늦게 바뀌어, 그 사이 controlled 체크박스가 옛 값으로 되돌아가지 않게 한다.
 */
export function SettingsScreen({ org }: { org: OrganizationDetail }) {
  const update = useUpdateApprovalPolicy(org.id);
  const [requested, setRequested] = useState<boolean | null>(null);
  const saving = requested !== null;
  const checked = requested ?? org.approvalPolicy.addWorker;
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">설정</h1>
      <section aria-label="승인 정책" className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">승인 받을 행동</h2>
        <ul className="divide-y divide-slate-100 text-sm">
          <li>
            <label className="flex items-center gap-3 py-2.5">
              <span className="flex-1 font-medium">작업자 추가</span>
              {saving && (
                <span role="status" className="text-xs text-slate-400">
                  저장하는 중…
                </span>
              )}
              <input
                type="checkbox"
                className="switch"
                checked={checked}
                disabled={saving}
                onChange={(e) => {
                  const addWorker = e.currentTarget.checked;
                  setRequested(addWorker);
                  update.mutate(
                    { addWorker },
                    { onSettled: () => setRequested(null) }
                  );
                }}
              />
            </label>
          </li>
          {["초기 연구 승인", "최종 완료"].map((label) => (
            <li key={label}>
              <label className="flex items-center gap-3 py-2.5 text-slate-500">
                <span className="flex-1">{label}</span>
                <span aria-hidden className="text-xs">
                  🔒
                </span>
                <input type="checkbox" className="switch" checked disabled />
              </label>
            </li>
          ))}
        </ul>
        {!saving && update.isError && (
          <p role="alert" className="mt-2 text-xs text-rose-600">
            저장하지 못했습니다. 다시 시도하세요.
          </p>
        )}
      </section>
    </div>
  );
}
