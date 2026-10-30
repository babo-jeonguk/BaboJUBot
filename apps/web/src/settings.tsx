import {
  approvalPolicyItems,
  type ApprovalPolicyItem,
  type OrganizationDetail,
} from "@babojubot/contracts";
import { useState } from "react";
import { useUpdateApprovalPolicy } from "./api.ts";
import { approvalPolicyItemLabel } from "./ui.tsx";

/**
 * 조직 › 설정. 첫 판은 승인 정책 스위치뿐이다(예산·job 한도·연결 채널은 후속).
 * 항목마다 누르면 바로 그 항목만 저장한다. `GitHub에 올리기`는 에이전트 지침으로 지키는 항목이다(ADR-0005).
 * 끌 수 없는 초기 연구 승인·최종 완료는 잠긴 스위치로 보인다.
 */
export function SettingsScreen({ org }: { org: OrganizationDetail }) {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">설정</h1>
      <section aria-label="승인 정책" className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">내 승인이 필요한 일</h2>
        <ul className="divide-y divide-slate-100 text-sm">
          {approvalPolicyItems.map((item) => (
            <PolicySwitch key={item} org={org} item={item} />
          ))}
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
      </section>
    </div>
  );
}

/**
 * 승인 정책 항목 하나의 스위치. 서버가 저장한 값만 보여 주고, 저장하는 동안에는 보낸 값으로 잠가 둔다. 실패하면 저장된 값으로 돌아간다.
 * 보낸 값은 누른 순간 지역 상태에 둔다. mutation 상태는 한 박자 늦게 바뀌어, 그 사이 controlled 스위치가 옛 값으로 되돌아가지 않게 한다.
 */
function PolicySwitch({
  org,
  item,
}: {
  org: OrganizationDetail;
  item: ApprovalPolicyItem;
}) {
  const update = useUpdateApprovalPolicy(org.id);
  const [requested, setRequested] = useState<boolean | null>(null);
  const saving = requested !== null;
  const checked = requested ?? org.approvalPolicy[item];
  return (
    <li className="py-2.5">
      <label className="flex items-center gap-3">
        <span className="flex-1 font-medium">
          {approvalPolicyItemLabel[item]}
        </span>
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
            const value = e.currentTarget.checked;
            setRequested(value);
            update.mutate(
              { [item]: value },
              { onSettled: () => setRequested(null) }
            );
          }}
        />
      </label>
      {!saving && update.isError && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          저장하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </li>
  );
}
