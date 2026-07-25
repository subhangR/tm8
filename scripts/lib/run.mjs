// Child-process supervision + prefixed logging for the tm8 launchers.
//
// One rule this file exists to enforce: every child dies with the launcher.
// A stranded tm8-server holding 4610 (or a stranded sidecar holding 5442) is the
// exact failure the ports/data-dir isolation rules are meant to prevent.

import { spawn } from "node:child_process";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const CODES = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function paint(code, text) {
  return COLOR ? `${CODES[code]}${text}${CODES.reset}` : text;
}

const PREFIX_COLORS = ["cyan", "magenta", "green", "blue", "yellow"];
let prefixCursor = 0;

/** A prefixed logger. `logger("server")` → `[server] ...` lines. */
export function logger(name, color) {
  const chosen = color ?? PREFIX_COLORS[prefixCursor++ % PREFIX_COLORS.length];
  const tag = paint(chosen, `[${name}]`);
  const write = (stream, text) => {
    for (const line of String(text).replace(/\n$/, "").split("\n")) {
      stream.write(`${tag} ${line}\n`);
    }
  };
  return {
    name,
    info: (msg) => write(process.stdout, msg),
    warn: (msg) => write(process.stdout, paint("yellow", `warn: ${msg}`)),
    error: (msg) => write(process.stderr, paint("red", `error: ${msg}`)),
    dim: (msg) => write(process.stdout, paint("dim", msg)),
    raw: (chunk) => write(process.stdout, chunk),
    rawErr: (chunk) => write(process.stderr, chunk),
  };
}

const children = new Set();

/**
 * Spawn a supervised child. stdout/stderr are line-prefixed with the log tag.
 * @returns {import("node:child_process").ChildProcess}
 */
export function start(command, args, { cwd, env, log }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => log.raw(chunk));
  child.stderr.on("data", (chunk) => log.rawErr(chunk));
  child.on("exit", () => children.delete(child));
  child.on("error", (err) => log.error(`failed to spawn ${command}: ${err.message}`));
  return child;
}

/** Run a command to completion. Resolves with the exit code. */
export function run(command, args, { cwd, env, log }) {
  return new Promise((resolvePromise) => {
    const child = start(command, args, { cwd, env, log });
    child.on("exit", (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)));
    child.on("error", () => resolvePromise(1));
  });
}

/** SIGTERM every live child, then SIGKILL anything still standing. */
export function killAll(signal = "SIGTERM") {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Wire Ctrl-C / SIGTERM to a clean teardown. Idempotent. */
export function installShutdownHandler(log) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.dim(`received ${signal} — stopping ${children.size} child process(es)`);
    killAll("SIGTERM");
    const deadline = setTimeout(() => {
      killAll("SIGKILL");
      process.exit(0);
    }, 4000);
    const poll = setInterval(() => {
      if (children.size === 0) {
        clearTimeout(deadline);
        clearInterval(poll);
        process.exit(0);
      }
    }, 100);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => killAll("SIGKILL"));
}
