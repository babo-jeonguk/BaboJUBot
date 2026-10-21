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
        <h2 className="mb-1 text-sm font-semibold">승인 정책</h2>
        <p className="mb-3 text-xs text-slate-500">
          체크한 행동은 Lead가 바로 하지 않고 Inbox에 승인 요청을 올립니다. 새
          조직은 모두 꺼져 있습니다.
        </p>
        <label className="flex items-start gap-3 rounded-xl px-1 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-brand-600"
            checked={checked}
            disabled={saving}
            aria-describedby="add-worker-help"
            onChange={(e) => {
              const addWorker = e.currentTarget.checked;
              setRequested(addWorker);
              update.mutate(
                { addWorker },
                { onSettled: () => setRequested(null) }
              );
            }}
          />
          <span>
            <span className="font-medium">작업자 추가</span>
            <span
              id="add-worker-help"
              className="mt-0.5 block text-xs text-slate-500"
            >
              켜면 Lead가 작업자를 추가할 때마다 승인을 받습니다. 끄면 바로
              추가됩니다. 끄더라도 이미 기다리는 요청은 그대로 남아 직접
              결정합니다.
            </span>
          </span>
        </label>
        {saving && (
          <p role="status" className="mt-2 text-xs text-slate-500">
            저장하는 중…
          </p>
        )}
        {!saving && update.isError && (
          <p role="alert" className="mt-2 text-xs text-rose-600">
            정책을 저장하지 못했습니다. 저장된 값은 그대로이니 다시 시도하세요.
          </p>
        )}
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
          초기 연구 승인과 최종 완료는 항상 사용자가 결정하며 끌 수 없습니다.
        </p>
      </section>
    </div>
  );
}
