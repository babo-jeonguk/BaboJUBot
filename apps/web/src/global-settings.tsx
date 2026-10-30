import { Page } from "./ui.tsx";

/**
 * 전역 설정. 첫 판은 자리만 있다: 프로바이더 adapter, 연구 환경 템플릿, 비밀값, 메시지 앱 연결.
 * 지금 쓰는 것(가짜 프로바이더·가짜 채널)을 그대로 알리고, 아직 없는 입력·연결은 동작하는 것처럼 보이지 않는다.
 */
export function GlobalSettingsPage() {
  return (
    <Page width="reading">
      <h1 className="mb-5 text-xl font-semibold">전역 설정</h1>
      <div className="space-y-3">
        <Placeholder title="프로바이더" now="가짜 프로바이더" />
        <Placeholder title="연구 환경 템플릿" now="조직별 연구 환경 명세" />
        <Placeholder title="비밀값" now="없음" />
        <Placeholder title="메시지 앱 연결" now="가짜 채널" />
      </div>
    </Page>
  );
}

function Placeholder({ title, now }: { title: string; now: string }) {
  return (
    <section
      aria-label={title}
      className="card flex items-center gap-3 p-4 text-sm"
    >
      <h2 className="flex-1 font-semibold">{title}</h2>
      <span className="text-slate-600">{now}</span>
      <span className="chip bg-slate-100 text-slate-500">준비 중</span>
    </section>
  );
}
