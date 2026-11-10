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
- **Durable Research Artifacts**: Access structured Markdown reports, summaries, code, and data files generated during research. All artifacts are securely stored and versioned.
- **Observable Dashboard**: Real-time event streams provide complete visibility into agent activities, active runs, token usage, and organizational health without relying on hidden model traces.

---

## Quickstart

### Prerequisites
- **Node.js**: 24.x or later
- **pnpm**: 10.x or later
- **Git**

### Installation & Launch

Clone the repository and start the platform locally:

```bash
git clone https://github.com/babo-jeonguk/BaboJUBot.git
cd BaboJUBot
pnpm install
pnpm dev
```

Open your browser and navigate to **`http://localhost:5173`** to access the dashboard.

---

## Connecting AI Models

BaboJUBot connects to your favorite LLM providers and coding agents:

- **Anthropic Claude Code**
- **OpenAI Codex**
- **OpenCode**
- **Google Antigravity**

Configure provider credentials, authentication logins, and concurrency limits directly in the dashboard under **Settings › Providers**. Agents can also run in isolated Docker environments for secure local code execution.

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

## Development & Contributing

Looking to develop, test, or contribute to BaboJUBot?

Please see our **[Development & Contributing Guide](CONTRIBUTING.md)** for local testing commands, demo scenarios, database setup, and architectural guidelines.

---

## License

BaboJUBot is currently in active development.
