// PROTOTYPE (#51) — throwaway. Three layout engines fed ONLY primary links (research D02).
// Every function returns node centres + elapsed ms so the switcher can show what each costs.
import dagre from "@dagrejs/dagre";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { flextree } from "d3-flextree";
import { NODE_H, NODE_W, type RNode } from "./data";

export type Dir = "LR" | "TB";
export type Pos = Map<string, { x: number; y: number }>;
export type LayoutOut = { pos: Pos; ms: number };

/** A parent that is not in the visible set (e.g. hidden 폐기) makes the child a root for layout purposes. */
function primaryEdges(nodes: RNode[]) {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.filter((n) => n.parentId && ids.has(n.parentId)).map((n) => [n.parentId!, n.id] as const);
}

export function dagreLayout(nodes: RNode[], dir: Dir): LayoutOut {
  const t = performance.now();
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: dir === "LR" ? 14 : 28, ranksep: dir === "LR" ? 72 : 56 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const [a, b] of primaryEdges(nodes)) g.setEdge(a, b);
  dagre.layout(g);
  const pos: Pos = new Map(nodes.map((n) => [n.id, { x: g.node(n.id).x, y: g.node(n.id).y }]));
  return { pos, ms: performance.now() - t };
}

// Real browser Worker (not the Node fake-worker fallback the research measured, E17).
const elk = new ELK({ workerUrl: elkWorkerUrl });
export async function elkLayout(nodes: RNode[], dir: Dir): Promise<LayoutOut> {
  const t = performance.now();
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir === "LR" ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.componentComponent": "48",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: primaryEdges(nodes).map(([a, b]) => ({ id: `${a}>${b}`, sources: [a], targets: [b] })),
  });
  const pos: Pos = new Map((res.children ?? []).map((c) => [c.id, { x: c.x! + NODE_W / 2, y: c.y! + NODE_H / 2 }]));
  return { pos, ms: performance.now() - t };
}

type TreeIn = { id: string; children: TreeIn[] };
/** Tidy tree for a forest: flextree wants one root, so all roots hang off a zero-size virtual root (E19/E21). */
export function flextreeLayout(nodes: RNode[], dir: Dir, w = 184, h = 56): LayoutOut {
  const t = performance.now();
  const ids = new Set(nodes.map((n) => n.id));
  const map = new Map<string, TreeIn>(nodes.map((n) => [n.id, { id: n.id, children: [] }]));
  const root: TreeIn = { id: "__root", children: [] };
  for (const n of nodes) (n.parentId && ids.has(n.parentId) ? map.get(n.parentId)! : root).children.push(map.get(n.id)!);
  const gapX = 24;
  const gapY = 56;
  const layout = flextree({
    nodeSize: (x: { data: TreeIn }) => (x.data.id === "__root" ? [0, 0] : dir === "TB" ? [w + gapX, h + gapY] : [h + gapX / 2, w + gapY]),
    spacing: 0,
  });
  const tree = layout.hierarchy(root);
  layout(tree);
  const pos: Pos = new Map();
  tree.each((x: { data: TreeIn; x: number; y: number }) => {
    if (x.data.id === "__root") return;
    // flextree: x = slot centre, y = slot top along the depth axis
    pos.set(x.data.id, dir === "TB" ? { x: x.x, y: x.y + h / 2 } : { x: x.y + w / 2, y: x.x });
  });
  return { pos, ms: performance.now() - t };
}
