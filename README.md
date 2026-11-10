# BaboJUBot

> Autonomous AI research teams with human governance and observable workflows.

BaboJUBot turns complex research goals into executed, verified results using autonomous AI research teams.

For each research objective, BaboJUBot creates an independent research organization led by an autonomous **Research Lead** and specialized **Worker agents**. From hypothesis formulation and experimental validation to structured reporting, the AI team conducts research autonomously while keeping you in full control through critical approval checkpoints.

---

## Key Features

- **Goal-Oriented AI Organizations**: Spin up a dedicated AI team for each research objective. Each organization maintains isolated memory, context, and workspaces, ensuring research efforts never contaminate each other.
- **Human-in-the-Loop Governance**: Retain full control over key decisions. The AI team formulates plans and proposes team structures, but work begins only after your approval. Final completion is always determined by you.
- **Visual Research Map**: Track research progress on a live, interactive graph (DAG). Watch hypotheses branch, converge, or get pruned as evidence accumulates.
- **Real-Time Steering & Chat**: Jump into conversation with the Research Lead at any time. Queue upcoming instructions, steer in-flight execution, or interrupt and redirect immediately.
- **Durable Research Artifacts**: Access structured Markdown reports, summaries, code, and data files generated during research. File artifacts keep the bytes captured at registration, so they stay viewable even if the original file later changes or is deleted.
- **Observable Dashboard**: Real-time event streams provide complete visibility into agent activities, active runs, token usage and cost per run, and per-organization metrics without relying on hidden model traces.

---

## Quickstart

### Prerequisites
- **Node.js**: 24.x
- **pnpm**: 10.33.0
- **Git**

### Installation & Launch

Clone the repository and start the platform locally:

```bash
git clone https://github.com/babo-jeonguk/BaboJUBot.git
cd BaboJUBot
pnpm install
pnpm dev
```

Open your browser and navigate to **`http://127.0.0.1:5173`** to access the dashboard.

---

## Connecting AI Models

BaboJUBot connects to your favorite LLM providers and coding agents:

- **Anthropic Claude Code**
- **OpenAI Codex**
- **OpenCode**
- **Google Antigravity**

Install the CLI you want to use and sign in with it yourself. Then start BaboJUBot with the connections you need, for example:

```bash
BABOJUBOT_PROVIDERS=claude,codex pnpm dev
```

Without this, BaboJUBot starts with only a built-in demo connection that does not call any model. In the dashboard **Settings**, pick the default connection and model for new Research Leads and workers, set per-connection concurrency limits, and check each connection's readiness. The **Isolated execution** switch (off by default) runs each real-model run inside a Docker container. Real model calls use your own subscription or API credits.

See the [provider guide](docs/providers.md) for every option. Real-model runs have been tested on Linux; macOS and Windows are covered by automated checks only.

---

## How It Works

```text
1. Define Goal ──> 2. Approve Plan ──> 3. Autonomous Execution ──> 4. Final Review
  (You)               (Inbox)             (Research Map & Chat)         (You)
```

1. **Define Your Research**: Click `+` on the dashboard sidebar. Enter your research objective (e.g., *"Investigate performance bottlenecks in distributed consensus"*) and target completion criteria.
2. **Review & Approve the Plan**: The Research Lead wakes up, plans the workflow, and submits an initial plan, proposed team staffing, and environment specifications to your **Inbox**. Review and approve with a single click (or request adjustments).
3. **Observe & Steer**: The Lead assigns tasks to specialized workers. Watch findings appear on the **Research Map** and read generated artifacts. You can chat with the Lead at any point to steer priorities or add new instructions.
4. **Final Sign-off**: Once the Lead determines that the completion criteria have been met, it compiles the evidence and submits a final review package. Review the summary and artifacts, then confirm final completion.

---

## Data and Security

BaboJUBot is meant to run on your own machine. The dashboard and API listen on `127.0.0.1` and have no login, so any program on the same machine can use them. Your database and organization folders are stored in the local data folder selected by `BABOJUBOT_HOME` (a Git-ignored folder in the repository by default).

---

## Development & Contributing

Looking to develop, test, or contribute to BaboJUBot?

Please see our **[Development & Contributing Guide](CONTRIBUTING.md)** for setup, demo scenarios, tests, and CI.

---

## License

BaboJUBot is released under the [MIT License](LICENSE).
