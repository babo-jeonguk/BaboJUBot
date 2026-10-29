---
name: record-research-node
description: Records research problems, hypotheses, verification methods, experiments and results as nodes and links on the research map. Use it when a task turns up a new problem or hypothesis, or when an experiment produces a result.
---

# Recording research nodes

Check the node and link kinds of the organization's research flow template in the run context (`researchFlow`) before you record.

## Steps

1. Decide what kind it is: research problem, hypothesis or idea, verification method, experiment, or result.
2. Pick one primary parent: a hypothesis's parent is the problem it answers, a method's is its hypothesis, an experiment's is its method, and a result's is its experiment. Leave it empty when none fits. Create the node with `create_research_node`, or set the parent of an existing node with `assign_research_node_parent` or `change_research_node_parent`.
3. Record other relations as secondary links (`add_research_link`). When a result supports or refutes another hypothesis, link it to that hypothesis.
4. Keep the title to one sentence. Put the evidence and its sources (artifacts, tasks) in the body.
5. When the node came from a task, link the task to it (`link_task_research_node`).

## Cautions

- Do not record an unverified hypothesis as a result.
- Never delete a node. Discard one that is no longer used (`discard_research_node`).
