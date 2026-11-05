// Fake `docker` for tests without Docker. Synthetic; never talks to a daemon.
// argv: <stateDir> <programs JSON> <docker args...>
// - records every call as one JSON line in <stateDir>/calls.jsonl ({ args, env } where env is the container env of `run`)
// - `run ... <image> <program> <args...>`: runs programs[<program>] on this machine with the container env and --workdir,
//   passes stdin/stdout through, forwards SIGINT/SIGTERM and writes the port of a `{"url":"http://127.0.0.1:N"}` frame
//   to <stateDir>/<name>.port so `port <name> <spec>` can answer like a published port.
// - `rm`: succeeds. `inspect`/`container inspect`: "No such container". `port`: the recorded port.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [stateDir, programsJson, ...args] = process.argv.slice(2);
const programs = JSON.parse(programsJson);
const record = (entry) =>
  appendFileSync(
    path.join(stateDir, "calls.jsonl"),
    JSON.stringify(entry) + "\n"
  );
const flagsWithValue = new Set([
  "--name",
  "--user",
  "-u",
  "--network",
  "--mount",
  "--workdir",
  "-w",
  "--env",
  "-e",
  "--label",
  "-l",
  "--cap-drop",
  "--security-opt",
  "--pull",
  "--publish",
  "-p",
  "--add-host",
  "--memory",
  "--pids-limit",
  "--entrypoint",
]);

const verb = args[0] === "container" ? args[1] : args[0];
if (verb === "run") {
  const rest = args.slice(args.indexOf("run") + 1);
  const options = new Map();
  const env = {};
  let i = 0;
  for (; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("-")) break;
    if (flagsWithValue.has(arg)) {
      const value = rest[++i];
      options.set(arg, [...(options.get(arg) ?? []), value]);
      if (arg === "-e" || arg === "--env") {
        const at = value.indexOf("=");
        if (at >= 0) env[value.slice(0, at)] = value.slice(at + 1);
        else if (process.env[value] !== undefined)
          env[value] = process.env[value];
      }
    }
  }
  const [, program, ...programArgs] = rest.slice(i);
  record({ args, env });
  const name = options.get("--name")?.[0] ?? "unnamed";
  const mapped = programs[program];
  if (!mapped) {
    process.stderr.write(`fake docker: unknown program ${program}\n`);
    process.exit(127);
  }
  const child = spawn(mapped[0], [...mapped.slice(1), ...programArgs], {
    cwd: options.get("--workdir")?.[0] ?? options.get("-w")?.[0],
    env: { PATH: process.env.PATH, ...env },
    stdio: ["inherit", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk.toString();
    for (let n; (n = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const url = JSON.parse(line).url;
        if (typeof url === "string")
          writeFileSync(path.join(stateDir, `${name}.port`), new URL(url).port);
      } catch {
        /* not a frame */
      }
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
} else {
  record({ args });
  if (verb === "inspect") {
    process.stderr.write(`Error: No such container: ${args.at(-1)}\n`);
    process.exit(1);
  }
  if (verb === "port") {
    const name = args[args.indexOf("port") + 1];
    process.stdout.write(
      `127.0.0.1:${readFileSync(path.join(stateDir, `${name}.port`), "utf8")}\n`
    );
  }
  process.exit(0);
}
