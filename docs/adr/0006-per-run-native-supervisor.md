# 실행 시도마다 네이티브 감독 실행기를 둔다

[#219](https://github.com/babo-jeonguk/BaboJUBot/issues/219)는 일반 설치를 systemd·cgroup에 묶지 않고 Node.js만으로 띄우고 끄는 길을 골랐다. Linux·macOS는 서버가 프로세스 그룹과 표식으로 트리를 띄웠고, Windows만 [#205](https://github.com/babo-jeonguk/BaboJUBot/issues/205)의 C# 묶음(Job Object) 실행기를 썼다. 이 구조에서는 서버가 죽으면 Linux·macOS 실행 시도의 트리를 쥔 쪽이 없었다. 다음 시작 때 기록한 번호와 시작 시각으로 찾아 끄는 복구가 필요했고, 확인과 신호 사이에 번호가 다른 프로그램에 다시 주어질 틈이 남았다. Node.js의 `spawn`은 자식을 스스로 거두므로, 업계 표준(Bazel·Buck2)처럼 마지막 신호까지 대표를 거두지 않아 번호를 쥐는 방식도 쓸 수 없었다. 그래서 [#268](https://github.com/babo-jeonguk/BaboJUBot/issues/268)에서 세 OS 모두 실행 시도마다 감독 실행기(Rust 프로그램 하나)를 두기로 했다(사용자 결정 2026-11-19·2026-11-20). 비교와 근거는 [조사](../research/issue-268-references.md)에 있다.

- **실행기:** 프로그램을 직접 띄우고 그 트리를 쥔다.
  - Linux·macOS는 프로그램의 프로세스 그룹을 마지막 그룹 신호 뒤까지 거두지 않는다.
  - Windows는 프로그램을 생성과 동시에 묶음에 넣는다.
  - 서버와는 공용 제어 통로로 말한다. 통로가 끝나면(서버 사망) 스스로 트리를 끈다.
- **언어와 의존성:** 세 OS 모두 Rust 하나로 만든다. 공용 약속·정리 전이·빌드 경로를 한 소스에서 공유하고, OS별 차이는 시스템 호출과 Windows 묶음·핸들 연결에만 둔다.
  - OS 호출 정의는 `libc`와 `windows-sys`만 판을 고정해 쓰고 `Cargo.lock`을 커밋한다(사용자 결정 2026-11-22).
  - Rust 판은 `rust-toolchain.toml`로 고정한다(Buck2·Biome과 같은 방식).
- **대체 경로 없음:** 실행기를 준비하지 못하면 실행을 이유와 함께 거부한다. Node.js가 직접 띄우는 길은 두지 않는다. 약한 길이 남으면 그 자체가 본보기가 된다.
- **배포:** 저장소에는 소스만 둔다. 공개 설치는 OS·CPU별 미리 빌드한 실행 파일을 npm optional dependency로 배포한다(Linux glibc x64·arm64, macOS x64·arm64, Windows x64). checkout 개발자는 명시적으로 빌드한다(`pnpm --filter @babojubot/process run build`).
  - Linux 실행 파일은 정적 musl로 빌드해 빌드 기기의 glibc 판에 묶이지 않게 한다. Linux 최소판은 5.4다.
  - 일반 npm/pnpm 설치에는 Developer ID·공증과 Authenticode를 요구하지 않는다. macOS arm64는 링커의 ad hoc 서명으로 충족한다.

## Considered Options

- **Node.js만으로 띄우기(#219의 길):** 서버가 죽으면 트리를 쥔 쪽이 없고, 번호로 찾아 끄는 복구가 남는다.
- **systemd·cgroup 필수:** 일반 설치를 특정 환경에 묶는다(#219). cgroup은 나중에 실제 가입·정리 능력을 확인한 환경에서만 고르는 실행기 안의 선택형 백엔드로 붙인다.
- **POSIX는 Rust·C, Windows는 기존 C#:** 약속과 오류 전이를 두 언어에서 고쳐야 하고 CLR·컴파일러에 기댄 별도 빌드가 남는다.
- **설치 시 빌드(node-gyp 등):** 사용자 기기에 빌드 도구를 요구한다.

## Consequences

- checkout 개발과 CI는 Rust 도구(rustup)가 필요하다. CI는 프로그램을 띄우는 job마다 실행기를 빌드하고, Rust 형식·clippy를 세 OS 대상으로 검사한다.
- Windows 서버는 더 이상 시작 때 C# 컴파일러로 실행기를 만들지 않는다.
- 서버만 죽으면 실행기가 정리하므로, 다음 시작의 번호 기반 복구가 필요한 경우가 줄어든다. 실행기도 함께 죽은 경우의 보수적 복구와 대시보드 안내는 #268의 후속 PR이 정한다.
- Linux는 실행기가 그룹 밖으로 나간 고아(새 세션 자손)도 맡아 트리와 함께 끈다(subreaper). 표식을 가진 프로그램(트리 밖으로 나간 것 포함)도 실행기가 찾아 끄고, 서버와 실행기가 함께 죽은 뒤의 재시작 복구도 실행기에 정리만 청한다(#268 PR 2). 번호 신호를 실행기 밖에서 막는 lint는 #268 PR 2의 마지막 단계다.
- 미리 빌드한 패키지와 Linux 5.4 미만 거부도 #268의 후속 PR이 맡는다. 그 전까지는 checkout 빌드만 쓴다.
