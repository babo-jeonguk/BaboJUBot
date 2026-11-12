---
name: check-research-environment
description: Checks, before the initial approval request, whether the research environment the plan needs is ready where your own commands run, and writes the result into the research environment specification. Use it in planning, after you settle the plan and team and before you call `request_initial_approval`.
---

# Checking the research environment

The check tells the Owner what is ready now and what still has to be prepared, so they can decide with that in view. It is a short look, not setup: you install nothing, configure nothing and run no experiment before approval. Missing or unknown items do not block the request; the Owner decides whether to approve.

## Order

1. Settle the plan and the team.
2. List what the research needs: commands, Python or Node versions, Python modules, GPU, data, storage, external services, and network destinations with their purpose.
3. Check the items you can check in the environment where your own commands run (the steps below).
4. Write the specification with the result table, then submit it in `environment` of `request_initial_approval` together with the plan, team and template.

If you cannot run commands at all in this run, do not guess: mark every item Cannot tell with that reason and submit.

## What you may run

Only short read-only probes, one attempt per item:

- Command present: `command -v <name>`. It is a shell builtin that returns at once; run it as is, never under `timeout`.
- Version: `<name> --version` (for example `python3 --version`, `node --version`).
- Python module: find it without importing it, because an import runs the module's own code and can write files:
  `python3 -B -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('<module>') else 1)"`
  Use only the top-level name (`torch`, not `torch.nn`). Exit 0 means Confirmed (found, not imported); exit 1 means Absent. Never run `import <module>` to check.
- CPU cores: `nproc`.
- GPU: `nvidia-smi -L`. If it runs and lists no GPU, mark it Absent. If `nvidia-smi` itself is missing, that does not show there is no GPU; mark it Cannot tell.
- Data or storage at a path you were given: `ls` or `df -h` on that path. With no path yet, mark it Cannot tell.

Any other item you list under Needed still gets a row: if none of these probes fits it, mark it Cannot tell and say why.

Do not:

- install or upgrade anything, create a virtual environment, or change files, settings or the environment;
- read credentials or secret values: no credential files, no dumping environment variables, no logins;
- make external connections or paid calls: no `curl`, `pip download`, `git fetch`, pings, or model or API calls;
- try another route when a probe is refused, or retry a probe that failed or timed out.

## Time limits

- Each probe other than `command -v`: 10 seconds. Run it as `timeout 10 <command>`. Exit code 124 means it timed out; mark the item Cannot tell, giving the 10-second limit as the reason.
- If `timeout` is missing, run only `command -v` (it returns at once) and mark every item that needs any other probe Cannot tell, giving the missing `timeout` as the reason.
- The whole check: 2 minutes. When that time is up, stop, mark every unchecked item Cannot tell, giving the 2-minute limit as the reason, and submit.

## Results

Give each item exactly one of three results:

- **Confirmed**: the probe showed the item is there. Quote the evidence (the version line, the path).
- **Absent**: the probe ran and showed the item is not there. Only a probe that succeeded in showing absence counts.
- **Cannot tell**: you could not decide (refused, the probe tool is missing, timed out, no access, out of time). Always give the reason.

Never write a result you did not observe. Write the results in Korean like the rest of the specification, and use the same Korean word for each result everywhere. When an item needs no follow-up, write `-` so it is not mistaken for the Absent result.

## Which environment you checked

Your result covers only the environment where your own commands ran. Workers may run with another provider or in another container, so never write that their environment is ready. Add a row for the workers' environment marked Cannot tell (you cannot reach it) whose follow-up is that the first task checks it.

Network: write which destinations the research needs and why, but do not test them. Do not claim a connection works. The Owner allows destinations in the organization settings.

## What the specification holds

Write it in Korean, in this shape (shown here in English):

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
| numpy | installed | Confirmed | Lead run environment | `find_spec('numpy')` found it (not imported) | - |
| torch | installed | Absent | Lead run environment | `find_spec('torch')` found nothing | a worker installs it in their own virtual environment after approval |
| CPU | 4 cores | Confirmed | Lead run environment | `nproc` -> 4 | - |
| GPU | one CUDA GPU | Cannot tell | Lead run environment | `nvidia-smi` is not installed, so no answer | the Owner says whether a GPU is provided, or prepares one |
| Evaluation set | readable | Cannot tell | Lead run environment | no path given yet | the Owner gives the path |
| Workers' run environment | all items above | Cannot tell | workers' run environment | the Lead cannot reach it | a worker checks it in the first task after approval |

## Network (not tested)
- huggingface.co:443: download the evaluation set. Whether it connects was not checked.

## Set up after approval
- A worker installs torch in their own virtual environment.

## Only the Owner can prepare
- Allow huggingface.co:443 in the organization settings
- Say whether a GPU is provided

The Owner may approve even with Absent or Cannot tell items. Approval does not mean the environment above is ready.
```

Keep the two follow-up lists apart: what the team sets up after approval, and what only the Owner can prepare (accounts, hardware, data access, allowed network destinations). Never write credential values.
