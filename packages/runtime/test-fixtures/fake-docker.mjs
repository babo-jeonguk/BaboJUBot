// Fake `docker` for tests without Docker. Synthetic; never talks to a daemon.
// argv: <stateDir> <programs JSON> <docker args...>
// - records every call as one JSON line in <stateDir>/calls.jsonl ({ args, env } where env is the container env of `run`)
// - `run ... <image> <program> <args...>`: runs programs[<program>] on this machine with the container env and --workdir,
//   passes stdin/stdout through and forwards SIGINT/SIGTERM. With <stateDir>/pass-output the program shares this program's output
//   directly and this program ends when the program itself ends, even if a child the program left keeps that output open. With BABOJUBOT_INBOUND_PORT it stands in for the image's relay.mjs:
//   once the program prints a `{"url":"http://127.0.0.1:N"}` frame it keeps connections open to the relay folder's inbound.sock
//   (the `/run/babojubot` mount source) and joins each to port N on its first byte.
// - `rm`: succeeds and records whether the last run's relay socket (`egress.sock`) still existed (`relayOpen`).
//   `inspect`/`container inspect`: "No such container". With <stateDir>/rm-fails, `rm` fails and the container stays.
// - `info`: prints <stateDir>/info.json or a local Linux engine. `image inspect`: prints <stateDir>/runner-version or "2".
//   `context inspect`: prints <stateDir>/context-host or the local socket.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

const [stateDir, programsJson, ...args] = process.argv.slice(2);
if (stateDir === undefined || programsJson === undefined)
  throw new Error(
    "usage: fake-docker <stateDir> <programs JSON> <docker args...>"
  );
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
  /** @type {Map<string, string[]>} */
  const options = new Map();
  /** @type {Record<string, string | undefined>} */
  const env = {};
  let i = 0;
  for (
    let arg = rest[i];
    arg !== undefined && arg.startsWith("-");
    arg = rest[++i]
  ) {
    if (flagsWithValue.has(arg)) {
      const value = rest[++i];
      if (value === undefined)
        throw new Error(`fake docker: ${arg} has no value`);
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
  const mounts = (options.get("--mount") ?? []).map((spec) =>
    Object.fromEntries(spec.split(",").map((part) => part.split("=")))
  );
  const relay = mounts.find(
    (mount) => mount.target === "/run/babojubot"
  )?.source;
  if (relay) writeFileSync(path.join(stateDir, "relay-dir"), relay);
  const inbound = Boolean(env.BABOJUBOT_INBOUND_PORT);
  /**
   * @param {string} folder the relay folder (the `/run/babojubot` mount source)
   * @param {number} port
   */
  const offer = (folder, port) => {
    const reverse = net.connect(path.join(folder, "inbound.sock"));
    let used = false;
    reverse.once("data", (first) => {
      used = true;
      reverse.pause();
      offer(folder, port);
      const local = net.connect(port, "127.0.0.1", () => {
        local.write(first);
        reverse.pipe(local).pipe(reverse);
        reverse.resume();
      });
      local.on("error", () => reverse.destroy());
      reverse.on("close", () => local.destroy());
    });
    reverse.on("error", () => reverse.destroy());
    reverse.on("close", () => {
      if (!used) setTimeout(() => offer(folder, port), 100).unref();
    });
  };
  const passOutput = existsSync(path.join(stateDir, "pass-output"));
  const mapped = program === undefined ? undefined : programs[program];
  if (!mapped) {
    process.stderr.write(`fake docker: unknown program ${program}\n`);
    process.exit(127);
  }
  const child = spawn(mapped[0], [...mapped.slice(1), ...programArgs], {
    cwd: options.get("--workdir")?.[0] ?? options.get("-w")?.[0],
    // The program runs on this machine, so the container's mounts are not applied. A program that must see a file mounted
    // over another path (a per-attempt file) reads FAKE_DOCKER_MOUNTS.
    env: {
      PATH: process.env.PATH,
      ...env,
      FAKE_DOCKER_MOUNTS: JSON.stringify(
        mounts.map(({ source, target }) => ({ source, target }))
      ),
    },
    stdio: passOutput ? "inherit" : ["inherit", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk.toString();
    for (let n; (n = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const url = JSON.parse(line).url;
        if (typeof url === "string" && inbound && relay)
          for (let k = 0; k < 4; k++) offer(relay, Number(new URL(url).port));
      } catch {
        /* not a frame */
      }
    }
  });
  /** @type {NodeJS.Signals[]} */
  const forwarded = ["SIGINT", "SIGTERM"];
  for (const signal of forwarded) process.on(signal, () => child.kill(signal));
  child.on(passOutput ? "exit" : "close", (code, signal) =>
    process.exit(code ?? (signal ? 137 : 1))
  );
} else {
  const failing = existsSync(path.join(stateDir, "rm-fails"));
  if (verb === "rm") {
    let relayOpen = false;
    try {
      const relay = readFileSync(path.join(stateDir, "relay-dir"), "utf8");
      relayOpen = existsSync(path.join(relay, "egress.sock"));
    } catch {
      /* no run yet */
    }
    record({ args, relayOpen });
    if (failing) {
      process.stderr.write("Error response from daemon: cannot remove\n");
      process.exit(1);
    }
    process.exit(0);
  }
  record({ args });
  if (verb === "inspect" && failing) {
    process.stdout.write("[{}]\n");
    process.exit(0);
  }
  if (verb === "inspect") {
    process.stderr.write(`Error: No such container: ${args.at(-1)}\n`);
    process.exit(1);
  }
  const stored = (file, fallback) => {
    try {
      return readFileSync(path.join(stateDir, file), "utf8").trim();
    } catch {
      return fallback;
    }
  };
  if (verb === "info")
    process.stdout.write(
      stored(
        "info.json",
        JSON.stringify({
          OSType: "linux",
          OperatingSystem: "Ubuntu 24.04",
          SecurityOptions: ["name=seccomp"],
        })
      ) + "\n"
    );
  if (args[0] === "context" && args[1] === "inspect")
    process.stdout.write(
      stored("context-host", "unix:///var/run/docker.sock") + "\n"
    );
  if (args[0] === "image" && args[1] === "inspect")
    process.stdout.write(stored("runner-version", "2") + "\n");
  process.exit(0);
}
