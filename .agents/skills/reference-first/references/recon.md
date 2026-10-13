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

결정에 닿는 주장을 자격 증명 없이 싸게 실행할 수 있을 때 한다. 모델 API가 필요한 실행 흐름은 「Self-host」의
mock provider로 키 없이 돌린다.

- 의존성은 lifecycle script를 끄고 설치한다(`npm install --ignore-scripts`, `pnpm install --ignore-scripts`).
  키가 없는 셸에서 실행한다: `env -i HOME="$HOME" PATH="$PATH" <명령>`.
- probe는 `.reference-cache/<key>/probes/`에 두고 checkout 경로를 인자로 넘긴다.
- 정상 사례와 함께 거부돼야 하는 음성 대조군도 실행한다.
- 명령·버전·결과를 `probes/run-log.txt`에 남긴다. 설치·실행이 실패하면 그 동작은 미확인이며 「동작하지
  않음」의 근거로 쓰지 않는다.

## Surface Capture — UI Issue

**실화면**만 캡처한다. 실화면은 에이전트가 브라우저로 직접 열어 그 상호작용이 화면에 보이는 상태까지 조작한
화면이다: 로그인 없이 열리는 실서비스 화면, 공식 데모·playground·디자인 시스템 예시, 「Self-host」로 띄운 OSS.
폭과 상태는 AC가 다루는 것으로 정한다.

- 첫 화면에 상호작용이 없으면 패널 열기·텍스트 선택·스크롤처럼 그 상태까지 가는 조작을 한 뒤 찍는다.
- `.reference-cache/<key>/captures/`에 두고 URL·시각·폭·상태·조작을 `captures.md`에 적는다.
- 메인이 모든 캡처를 직접 열어 그 상호작용이 화면 안에 보이는지 확인한다. 첫 화면·쿠키 배너·빈 화면·loading·
  차단·오류만 보이면 조작을 고쳐 다시 찍거나 근거에서 뺀다.
- 로그인·계정 생성이 필요한 서비스는 열지 않는다. 같은 상호작용을 공개 데모나 「Self-host」에서 찾고, 없으면 그
  상태를 미확인으로 둔다.
- 도움말·마케팅 페이지의 그림과 시연 영상은 문서 주장이다. 패턴이 있다는 보조 근거로만 쓰고, 배치·시각 결정의
  근거는 실화면 관찰이다.
- 다른 회사의 캡처는 저장소·Issue·PR에 올리지 않고 서비스 이름과 관찰만 쓴다.

## Self-host

공개 실화면이 없는 OSS, 또는 결정에 걸린 상태를 공개 데모로 만들 수 없을 때(모델 API가 필요한 실행 흐름,
provider 오류·timeout·빈 응답·느린 응답·tool call) 그 OSS를 로컬로 띄운다. Behavioral Recon과 Surface Capture는
띄운 로컬 주소를 공개 화면처럼 쓴다.

1. **받기**: 고정 SHA를 저장소 밖 새 빈 디렉터리 `/tmp/reference-selfhost/<slug>/`에 받는다. 저장소 안에서
   설치하면 루트 `pnpm-workspace.yaml`이 그 OSS를 우리 workspace로 잡을 수 있다. 가장 가벼운 실행 경로(단일
   example·dev server)를 먼저 고른다.
2. **상한**: `free -g`로 여유를 보고 설치·실행을 메모리 상한 안에서 돌린다 —
   `systemd-run --user --scope -p MemoryMax=2G <명령>` 또는 docker `--memory 2g`. 여유가 상한보다 작으면 띄우지
   않고 미확인으로 둔다. 설치·실행 규칙(lifecycle script 끄기, 키 없는 셸)은 Behavioral Recon과 같다.
3. **모델 API**: 실제 키 대신 [scripts/mock-llm.mjs](../scripts/mock-llm.mjs)를 붙인다. OpenAI 호환
   `/v1/chat/completions`·`/v1/models`를 흉내 내고, 마지막 user 메시지에 걸리는 규칙으로 정상 응답·오류 status·
   지연·빈 응답·무응답·tool call을 고른다(규칙 형식은 `--help`). 앱의 provider base URL을
   `http://127.0.0.1:<port>/v1`, 키를 `sk-dummy`로 둔다. provider가 코드에 고정돼 있으면 그 줄만 바꾸고 기록한다.
   - 먼저 규칙 없이 `--log`로 한 번 돌려 앱이 보내는 요청을 읽는다. 앱이 tool call을 기대하면 그 schema대로
     `message.tool_calls` 규칙을 쓴다.
   - 규칙의 `match`는 대소문자를 무시하는 정규식이다. `^fail`처럼 앞을 고정한다 — `hang`은 「change」에도 걸린다.
   - OpenAI 호환 base URL을 받지 않는 provider나 결제·메일·OAuth 같은 다른 외부 서비스가 필요한 경로는 띄우지
     않고 미확인으로 둔다.
4. **기록**: `.reference-cache/<key>/selfhost/<slug>.md`에 저장소@SHA, 바꾼 코드, 실행 명령, mock 규칙 파일을
   적는다. 근거 출처에도 저장소@SHA와 mock을 적는다. mock으로 본 것은 그 제품이 응답·오류를 다루는 방식이며,
   실제 모델의 응답이나 품질은 미확인이다.
5. **정리**: 띄울 때 PID를 적어 두고 관찰이 끝나면 그 PID로 끈다. `pkill -f <패턴>`은 그 패턴을 담은 자기
   셸까지 끈다.
