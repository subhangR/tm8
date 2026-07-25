// Preflight checks shared by dev / start / doctor.
//
// Every check returns {ok, level, title, detail}. `level: "error"` aborts the
// launcher; `level: "warn"` prints and continues. The point of this file is that
// a failed start says exactly what is wrong and exactly what to do about it —
// never a silent port collision with live maestro.

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAESTRO_RESERVED_DIRS,
  MAESTRO_RESERVED_PORTS,
  REPO_ROOT,
  port as readPort,
} from "./env.mjs";

const MIN_NODE_MAJOR = 20;

/** True when something is already listening on 127.0.0.1:<port>. */
export function isPortInUse(port, timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function check(level, ok, title, detail) {
  return { ok, level: ok ? "info" : level, title, detail };
}

/**
 * @param {Record<string,string>} env resolved tm8 env
 * @param {{needUiPort?: boolean, needPgPort?: boolean}} opts
 * @returns {Promise<Array<{ok:boolean, level:string, title:string, detail:string}>>}
 */
export async function preflight(env, opts = {}) {
  const results = [];

  // --- runtime ------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push(
    check(
      "error",
      nodeMajor >= MIN_NODE_MAJOR,
      `node ${process.versions.node}`,
      `tm8 requires node >= ${MIN_NODE_MAJOR}. Found ${process.versions.node}.`,
    ),
  );

  results.push(
    check(
      "error",
      process.versions.bun === undefined,
      "launcher runtime is node",
      "This launcher must run under node, not bun: it supervises packages/server " +
        "and packages/execution, and node-pty is broken under bun. " +
        "Run `node scripts/dev.mjs` (or `bun run dev`, which shells out to node).",
    ),
  );

  // --- data dir isolation -------------------------------------------------
  const dataDir = resolve(env.TM8_DATA_DIR);
  const collidingDir = MAESTRO_RESERVED_DIRS.find(
    (d) => dataDir === d || dataDir.startsWith(d + "/"),
  );
  results.push(
    check(
      "error",
      !collidingDir,
      `data dir ${dataDir}`,
      collidingDir
        ? `TM8_DATA_DIR resolves inside live maestro's data dir (${collidingDir}). ` +
            "tm8 must never write there. Set TM8_DATA_DIR to ~/.tm8-dev (dev) or ~/.tm8 (prod)."
        : `env=${env.TM8_ENV}`,
    ),
  );

  // --- port isolation from live maestro ------------------------------------
  const wanted = [
    ["TM8_PORT", readPort(env, "TM8_PORT"), true],
    ["TM8_PG_PORT", readPort(env, "TM8_PG_PORT"), opts.needPgPort !== false],
    ["TM8_UI_PORT", readPort(env, "TM8_UI_PORT"), opts.needUiPort === true],
  ].filter(([, , active]) => active);

  for (const [key, value] of wanted) {
    if (MAESTRO_RESERVED_PORTS.includes(value)) {
      results.push(
        check(
          "error",
          false,
          `${key}=${value}`,
          `Port ${value} belongs to live maestro (${MAESTRO_RESERVED_PORTS.join(", ")}). ` +
            "tm8 must not bind it. Pick another port in .env.",
        ),
      );
    }
  }

  // --- port availability ---------------------------------------------------
  for (const [key, value] of wanted) {
    // The sidecar port is allowed to be occupied: an already-running tm8 sidecar
    // for THIS data dir is a normal restart case, and the server reconciles it
    // via single-instance locking (R15). Everything else must be free.
    const inUse = await isPortInUse(value);
    if (!inUse) {
      results.push(check("error", true, `${key}=${value} free`, ""));
      continue;
    }
    if (key === "TM8_PG_PORT") {
      results.push(
        check(
          "warn",
          false,
          `${key}=${value} already in use`,
          "Something is listening on the sidecar Postgres port. If that is a previous " +
            "tm8 sidecar for this data dir the server will reuse it; otherwise stop it " +
            "or set TM8_PG_PORT.",
        ),
      );
      continue;
    }
    results.push(
      check(
        "error",
        false,
        `${key}=${value} already in use`,
        `Another process is listening on ${value}. Stop it, or set ${key} in .env. ` +
          "(A second tm8 stack needs its own TM8_PORT, TM8_UI_PORT, TM8_PG_PORT and TM8_DATA_DIR.)",
      ),
    );
  }

  // --- workspace sanity ----------------------------------------------------
  results.push(
    check(
      "error",
      existsSync(resolve(REPO_ROOT, "node_modules")),
      "dependencies installed",
      "node_modules is missing at the repo root. Run `bun install` first.",
    ),
  );

  return results;
}

/** Print preflight results; return true when it is safe to continue. */
export function reportPreflight(results, log) {
  let fatal = false;
  for (const r of results) {
    if (r.ok) continue;
    if (r.level === "error") {
      fatal = true;
      log.error(`preflight FAILED — ${r.title}`);
      if (r.detail) log.error(`  ${r.detail}`);
    } else {
      log.warn(`${r.title}`);
      if (r.detail) log.warn(`  ${r.detail}`);
    }
  }
  return !fatal;
}
