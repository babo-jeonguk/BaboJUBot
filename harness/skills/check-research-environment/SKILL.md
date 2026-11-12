---
name: check-research-environment
description: Checks, before the initial approval request, whether the research environment the plan needs is ready where your own commands run, and writes the result into the research environment specification. Use it in planning, after you settle the plan and team and before you call `request_initial_approval`.
---

# Checking the research environment

The check tells the Owner what is ready now and what still has to be prepared, so they can decide with that in view. It is a short look, not setup: you install nothing, configure nothing and run no experiment before approval. Items that are not present or cannot be confirmed do not block the request; the Owner decides whether to approve.

## Order

1. Settle the plan and the team.
2. List what the research needs: commands, Python or Node versions, Python modules, CPU, GPU, data, storage, external services, and network destinations with their purpose. List only what this research needs.
3. Check each listed item in the environment where your own commands run (the steps below).
4. Write the specification with the result table, then submit it in `environment` of `request_initial_approval` together with the plan, team and template.

If you cannot run commands at all in this run, do not guess: mark every item Cannot confirm with that reason and submit.

## What you may run

Only short read-only probes, one attempt per item:

- Command present: `command -v <name>`.
- Version: `<name> --version` (for example `python3 --version`, `node --version`).
- Python module: find it without importing it, because an import runs the module's own code and can write files:
  `python3 -B -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('<module>') else 1)"`
  Use only the top-level name (`torch`, not `torch.nn`). Exit 1 means Not present. Exit 0 means Confirmed for "installed" only: the module was found, but whether it imports (its own dependencies load) was not checked, so its follow-up is that the first task imports it. Never run `import <module>` to check.
- CPU cores: `nproc`.
- GPU: `nvidia-smi -L`. If it runs and lists no GPU, mark it Not present. If `nvidia-smi` itself is missing, that does not show there is no GPU; mark it Cannot confirm.
- Data or storage at a path you were given: `ls` or `df -h` on that path. With no path yet, mark it Cannot confirm.

If none of these probes fits a listed item, mark it Cannot confirm and say why.

Do not:

- install or upgrade anything, create a virtual environment, or change files, settings or the environment;
- read credentials or secret values: no credential files, no dumping environment variables, no logins;
- make external connections or paid calls: no `curl`, `pip download`, `git fetch`, pings, or model or API calls;
- try another route when a probe is refused, or retry a probe that failed or timed out.

## Time limits

- `command -v` is a shell builtin that returns at once. Run it as is; `timeout` cannot run it.
- Run every other probe, quick ones such as `nproc` and `df -h` included, as `timeout 10 <command>`. Exit code 124 means it timed out; mark the item Cannot confirm, giving the 10-second limit as the reason.
- If `timeout` is missing, run only `command -v` and mark every item that needs any other probe Cannot confirm, giving the missing `timeout` as the reason.
- The whole check: 2 minutes. When that time is up, stop, mark every unchecked item Cannot confirm, giving the 2-minute limit as the reason, and submit.

## Results

The Result column of every row holds exactly one of three results, never anything else:

- **Confirmed**: the probe showed the item is there. Quote the evidence (the version line, the path).
- **Not present**: the probe ran and showed the item is not there. Only a probe that succeeded in showing absence counts.
- **Cannot confirm**: you could not find out (refused, the probe tool is missing, timed out, no access, out of time). Always give the reason.

Never write a result you did not observe.

## Which environment you checked

Your result covers only the environment where your own commands ran. Workers may run with another provider or in another container, so never write that their environment is ready. Add a row for the workers' environment marked Cannot confirm (you cannot reach it) whose follow-up is that the first task checks it.

Network: write which destinations the research needs and why, but do not test them. Do not claim a connection works. The Owner allows destinations in the organization settings.

## Writing it in Korean

The Owner reads the specification in Korean. This file is in English only because Skill files must be; your specification must contain no English headings or labels.

- Translate every heading and column name of the example below into Korean.
- The Result column is in Korean too; never leave an English result word in it. Write each result as the plain Korean word for it: for Confirmed, the Korean word for "confirmed"; for Not present, the Korean word for "none"; for Cannot confirm, the Korean noun phrase for "confirmation not possible". Use exactly that Korean word for that result in every row. Do not swap in a word of a different meaning, such as one for "cannot judge" or "unknown".
- The Follow-up column holds `-` when nothing needs doing. `-` belongs only in Follow-up, never in Result.
- Commands, versions, paths and module names stay as they are.

## What the specification holds

Its shape, shown here in English:

```markdown
# Research environment specification

## Needed
- Compute: one CUDA GPU (training), 4 CPU cores
- Software: Python 3.10 or later, numpy, torch
- Data: public evaluation set (the Owner gives the path)

## Environment check
Checked: the Lead's run environment (this run). The workers' environment was not checked.

| Item | Requirement | Result | Checked where | How, evidence | Follow-up |
| --- | --- | --- | --- | --- | --- |
| python3 | 3.10 or later | Confirmed | Lead run environment | `python3 --version` -> Python 3.12.3 | - |
| numpy | installed | Confirmed | Lead run environment | `find_spec('numpy')` found it (not imported) | a worker checks that it imports in the first task |
| torch | installed | Not present | Lead run environment | `find_spec('torch')` found nothing | a worker installs it in their own virtual environment after approval |
| CPU | 4 cores | Confirmed | Lead run environment | `nproc` -> 4 | - |
| GPU | one CUDA GPU | Cannot confirm | Lead run environment | `nvidia-smi` is not installed, so no answer | the Owner says whether a GPU is provided, or prepares one |
| Evaluation set | readable | Cannot confirm | Lead run environment | no path given yet | the Owner gives the path |
| Workers' run environment | all items above | Cannot confirm | workers' run environment | the Lead cannot reach it | a worker checks it in the first task after approval |

## Network (not tested)
- huggingface.co:443: download the evaluation set. Whether it connects was not checked.

## Set up after approval
- A worker installs torch in their own virtual environment.

## Only the Owner can prepare
- Allow huggingface.co:443 in the organization settings
- Say whether a GPU is provided

The Owner may approve even with items that are not present or cannot be confirmed. Approval does not mean the environment above is ready.
```

Keep the two follow-up lists apart: what the team sets up after approval, and what only the Owner can prepare (accounts, hardware, data access, allowed network destinations). Never write credential values.
