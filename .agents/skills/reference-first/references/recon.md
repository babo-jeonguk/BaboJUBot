# Recon

심층 대상 하나를 조사하는 방법이다. Brief에서 고른 전략의 절만 따른다. 결과는
`.reference-cache/<key>/recon/<레퍼런스>.md`에 쓰고, 결정에 쓰는 관찰만 결과 문서의 근거 표로 올린다.

## Source Recon

고정 SHA, 확인일, root LICENSE를 기록한다. 파일 몇 개면 raw로 읽고, 호출 경로를 따라가야 하면 checkout한다.

```bash
git clone --filter=blob:none https://github.com/<owner>/<repo> .reference-cache/src/<owner>-<repo>@<sha7>
git -C .reference-cache/src/<owner>-<repo>@<sha7> checkout <sha>
```

메커니즘 하나를 이 순서로 따라간다.

1. 진입점: 공개 API·route·명령·이벤트 handler.
2. 호출 경로: 상태가 어디서 바뀌는지 `파일:심볼` 사슬로 적는다. 표나 guard를 거치지 않는 쓰기 경로를 찾는다.
3. 계약: 타입·schema·protocol·DB 정의. 강제하는 것과 주석으로만 말하는 것을 나눈다.
4. 테스트: 무엇을 assert하는지, 어떤 경우가 빠졌는지.
5. 실패 경로: 예외·timeout·재시도·취소·부분 실패·재시작 뒤 복구.
6. 이유: 핵심 파일의 `git log`·blame과 연결된 issue·PR.

격리·권한 대상은 adversarial scenario를 문장으로 쓰고(「조직 A의 agent가 조직 B의 task ID로 결과를 제출한다」,
「조직 ID 없이 연결한다」) 코드가 어디서 거부하는지 추적한다. 거부 분기의 줄이 근거이고, 못 찾으면 미확인이다.

## Behavioral Recon

결정에 닿는 주장을 자격 증명 없이 싸게 실행할 수 있을 때 한다.

- 의존성은 lifecycle script를 끄고 설치한다(`npm install --ignore-scripts`, `pnpm install --ignore-scripts`).
  키가 없는 셸에서 실행한다: `env -i HOME="$HOME" PATH="$PATH" <명령>`.
- probe는 `.reference-cache/<key>/probes/`에 두고 checkout 경로를 인자로 넘긴다.
- 정상 사례와 함께 거부돼야 하는 음성 대조군도 실행한다.
- 명령·버전·결과를 `probes/run-log.txt`에 남긴다. 설치·실행이 실패하면 그 동작은 미확인이며 「동작하지
  않음」의 근거로 쓰지 않는다.

## Surface Capture — UI Issue

같은 상호작용이 실제로 일어나는 구체 화면을 사용 가능한 브라우저 도구로 캡처한다. 폭과 상태는 AC가 다루는
것으로 정한다.

- `.reference-cache/<key>/captures/`에 두고 URL·시각·폭·상태를 `captures.md`에 적는다.
- 메인이 모든 캡처를 직접 연다. 빈 화면·loading·차단·오류 캡처는 근거로 세지 않는다.
- 로그인 뒤 화면은 공식 문서의 스크린샷으로 대신하고 수준을 문서 주장으로 적는다.
- 다른 회사의 캡처는 저장소·Issue·PR에 올리지 않고 서비스 이름과 관찰만 쓴다.
