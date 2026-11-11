import {
  approvalPolicyItems,
  destinationSchema,
  type ApprovalPolicyItem,
  type Destination,
  type OrganizationDetail,
} from "@babojubot/contracts";
import { useState, type FormEvent } from "react";
import {
  useNetworkPolicy,
  useUpdateApprovalPolicy,
  useUpdateNetworkPolicy,
} from "./api.ts";
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
      <NetworkPolicySection org={org} />
    </div>
  );
}

/** 목적지 한 줄의 글자. */
const destinationLabel = (entry: Destination) =>
  `${entry.host.includes(":") ? `[${entry.host}]` : entry.host}:${entry.port}`;

/**
 * 외부 연결 허용 목록(#149). 격리 실행에서 초기 연구 승인 뒤 에이전트가 연결할 수 있는 이름·포트다. 목록에 없으면 연결하지 않는다.
 * 추가·삭제는 누르면 바로 목록 전체를 저장한다. 모델·로그인 연결은 연결마다 따로 열려 있어 여기에 적지 않는다.
 */
function NetworkPolicySection({ org }: { org: OrganizationDetail }) {
  const policy = useNetworkPolicy(org.id);
  const update = useUpdateNetworkPolicy(org.id);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [addresses, setAddresses] = useState("");
  const [invalid, setInvalid] = useState(false);
  const destinations = policy.data?.destinations ?? [];
  const save = (next: Destination[], done?: () => void) =>
    update.mutate({ destinations: next }, { onSuccess: done });
  const add = (event: FormEvent) => {
    event.preventDefault();
    const parsed = destinationSchema.safeParse({
      host,
      port: Number(port),
      ...(addresses.trim()
        ? {
            addresses: addresses
              .split(/[\s,]+/)
              .map((value) => value.trim())
              .filter(Boolean),
          }
        : {}),
    });
    if (!parsed.success) return setInvalid(true);
    setInvalid(false);
    save([...destinations, parsed.data], () => {
      setHost("");
      setAddresses("");
    });
  };
  return (
    <section aria-label="외부 연결 허용 목록" className="card p-4">
      <h2 className="mb-1 text-sm font-semibold">외부 연결 허용 목록</h2>
      <p className="mb-3 text-xs text-slate-500">
        격리 실행에서 초기 연구 승인 뒤 에이전트가 연결할 수 있는 곳입니다.
        목록에 없는 곳과 이 컴퓨터·내부망 주소는 연결하지 않습니다. 모델과
        로그인 연결은 따로 열려 있습니다.
      </p>
      {policy.isPending ? (
        <p className="text-sm text-slate-400">불러오는 중…</p>
      ) : destinations.length === 0 ? (
        <p className="text-sm text-slate-500">
          허용한 곳이 없습니다. 연구 중 외부 연결은 모두 거부됩니다.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {destinations.map((entry, index) => (
            <li
              key={`${destinationLabel(entry)}-${index}`}
              className="flex items-center gap-3 py-2"
            >
              <span className="flex-1">
                <span className="font-mono">{destinationLabel(entry)}</span>
                {entry.addresses?.length ? (
                  <span className="ml-2 text-xs text-slate-500">
                    내부 주소 허용: {entry.addresses.join(", ")}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="btn-soft text-xs"
                disabled={update.isPending}
                aria-label={`${destinationLabel(entry)} 삭제`}
                onClick={() => save(destinations.filter((_, i) => i !== index))}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={add}
        className="mt-3 flex flex-wrap items-end gap-2 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">이름</span>
          <input
            className="input"
            value={host}
            placeholder="example.com 또는 *.example.com"
            onChange={(e) => setHost(e.currentTarget.value)}
          />
        </label>
        <label className="flex w-24 flex-col gap-1">
          <span className="text-xs text-slate-500">포트</span>
          <input
            className="input"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">허용할 내부 주소(선택)</span>
          <input
            className="input"
            value={addresses}
            placeholder="10.0.0.5"
            onChange={(e) => setAddresses(e.currentTarget.value)}
          />
        </label>
        <button
          type="submit"
          className="btn-primary"
          disabled={update.isPending}
        >
          추가
        </button>
      </form>
      {invalid && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          이름·포트·주소를 확인해 주세요. 이름은 example.com처럼, 포트는
          1~65535로 적습니다.
        </p>
      )}
      {update.isError && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          저장하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </section>
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
