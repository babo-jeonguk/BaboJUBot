# Provider protocol fixtures

Fixtures are **synthetic**, derived from the public protocol and reviewed local source, except `*-recorded.json`, which are masked real output (see below). Behavioral peers persist synthetic notes and invoke the local contract-test tool server so resume/steer tests check observable effects.

`replay.mjs <fixture.json>` reads a duplex trace. `version` specifies the version probe, `argv` checks public options, and ordered `steps` contain partial JSON `input`, JSON `frame`, raw `stdout` fragments, or `exit`. Input mismatches fail the subprocess. JSON field order does not matter. Raw chunks exercise fragmentation/truncation without exposing private model content.

Future recordings require separate authorization for product login and model/quota use. Capture only in a private product directory excluded from Git. Replace identities, credentials, research inputs, tool results, user text and private reasoning before producing a fixture; use deterministic placeholder values matching the synthetic RunRequest. Review the entire trace, not only regex redaction. Store provider/version/source date and mark it as a reviewed recording only after replay and human review. Never commit raw recordings, credential files or personal provider state.

`*-recorded.json` are real protocol output of Claude, Codex (both modes), OpenCode and Antigravity. A simulator given `--recording <file>` emits those frames while scripting behaviour, so the contract test checks each adapter against real frames; the behaviour around them is not a replay of a model. Recordings are made by `scripts/provider-live.mjs --record` into the Git-ignored product folder, then reduced by `scripts/live/make-stdio-fixture.mjs` or `make-opencode-fixture.mjs`. They keep only allowlisted strings, so prompts, answers, paths and IDs cannot enter the repository. Review the remaining strings and keys before committing.

Live scenes are in `scripts/provider-live.mjs`, outside CI. `quirky-cli.synthetic.mjs` plays the untidy behaviour of real programs (banners, long lines, slow answers, untidy exits).
