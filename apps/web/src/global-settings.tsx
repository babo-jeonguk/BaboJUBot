import { Page } from "./ui.tsx";

/**
 * 전역 설정. 첫 판은 자리만 있다: 실행기 adapter, 연구 환경 템플릿, 비밀값, 메시지 앱 연결.
 * 지금 쓰는 것(가짜 실행기·가짜 채널)을 그대로 알리고, 아직 없는 입력·연결은 동작하는 것처럼 보이지 않는다.
 */
export function GlobalSettingsPage() {
  return (
    <Page width="reading">
      <h1 className="mb-1 text-xl font-semibold">전역 설정</h1>
      <p className="mb-5 text-sm text-slate-500">
        모든 연구 조직에 쓰는 설정입니다. 이 판에서는 현재 상태만 보이며 바꿀 수
        있는 항목은 아직 없습니다.
      </p>
      <div className="space-y-3">
        <Placeholder
          title="실행기 adapter"
          now="가짜 실행기(개발용 시나리오)로 실행합니다."
          later="실제 실행기 adapter와 계정 연결은 이후 판에서 추가합니다."
        />
        <Placeholder
          title="연구 환경 템플릿"
          now="조직마다 초기 연구 승인에서 받은 연구 환경 명세를 씁니다."
          later="여러 조직이 함께 쓰는 템플릿은 이후 판에서 추가합니다."
        />
        <Placeholder
          title="비밀값"
          now="저장한 비밀값이 없습니다."
          later="API 키 같은 비밀값 보관은 이후 판에서 추가합니다. 비밀값은 Git에 넣지 않습니다."
        />
        <Placeholder
          title="메시지 앱 연결"
          now="가짜 채널(개발용)만 연결돼 있습니다. Lead 메시지·승인 요청·결과 제출·실패한 실행 시도 알림을 받아 전송 기록으로 남깁니다."
          later="실제 메시지 앱 연결은 이후 판에서 추가하며, 같은 알림과 같은 승인 명령을 씁니다."
        />
      </div>
    </Page>
  );
}

function Placeholder({
  title,
  now,
  later,
}: {
  title: string;
  now: string;
  later: string;
}) {
  return (
    <section aria-label={title} className="card p-4">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="chip bg-slate-100 text-slate-600">준비 중</span>
      </div>
      <p className="text-sm text-slate-700">{now}</p>
      <p className="mt-1 text-xs text-slate-500">{later}</p>
    </section>
  );
}
