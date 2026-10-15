// PROTOTYPE (#51) — d3-flextree ships no types.
declare module "d3-flextree" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function flextree(opts: Record<string, unknown>): any;
}
