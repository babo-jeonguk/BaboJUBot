# Provider protocol fixtures

Every current fixture is **synthetic**, derived from the pinned public protocol and reviewed local source. No fixture is a recorded model response. Behavioral peers persist synthetic notes and invoke the local contract-test tool server so resume/steer tests check observable effects.

`replay.mjs <fixture.json>` reads a duplex trace. `version` specifies the version probe, `argv` checks public options, and ordered `steps` contain partial JSON `input`, JSON `frame`, raw `stdout` fragments, or `exit`. Input mismatches fail the subprocess. JSON field order does not matter. Raw chunks exercise fragmentation/truncation without exposing private model content.

Future recordings require separate authorization for product login and model/quota use. Capture only in a private product directory excluded from Git. Replace identities, credentials, research inputs, tool results, user text and private reasoning before producing a fixture; use deterministic placeholder values matching the synthetic RunRequest. Review the entire trace, not only regex redaction. Store provider/version/source date and mark it as a reviewed recording only after replay and human review. Never commit raw recordings, credential files or personal provider state.

The HTTP/SSE peers for OpenCode are synthetic servers, not an HTTP recording. A live smoke is available in `scripts/provider-smoke.mjs`, outside CI. Real authentication, model behavior, cache savings and real captures remain unverified.
