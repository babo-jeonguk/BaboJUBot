# Commit Messages

커밋 메시지는 `<type>(<scope>): <summary>` 형식으로 씁니다. scope 하나로 정하기 애매한 변경은 `<type>: <summary>`로 씁니다.

- type: Conventional Commits의 `feat`, `fix`, `docs`, `refactor`, `test`, `chore` 등
- scope: 주로 바뀐 workspace 폴더명(`core`, `web` 등) 또는 그에 준하는 한 영역(`ci` 등)
- summary: 기존 이력처럼 영어 명령형, 소문자로 시작하고 마침표 없이 씁니다.

```text
feat(core): add organization isolation rules
docs: add agent routing docs
```
