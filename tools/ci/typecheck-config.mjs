#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const configs = [];

for (const projectRoot of ["packages", "tools"]) {
  const absoluteRoot = resolve(root, projectRoot);
  for (const entry of readdirSync(absoluteRoot)) {
    const config = resolve(absoluteRoot, entry, "tsconfig.json");
    try {
      if (statSync(config).isFile()) configs.push(config);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const failures = [];
for (const config of configs.sort()) {
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error) {
    failures.push(ts.formatDiagnostic(read.error, formatHost));
    continue;
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(config, ".."), {}, config);
  if (parsed.errors.length > 0) {
    failures.push(...parsed.errors.map((error) => ts.formatDiagnostic(error, formatHost)));
    continue;
  }

  const relative = config.slice(root.length + 1);
  if (parsed.options.composite !== true) {
    failures.push(`${relative}: compilerOptions.composite must resolve to true`);
  }
  if (parsed.fileNames.length === 0) {
    failures.push(`${relative}: config resolves to zero input files`);
  }
}

if (failures.length > 0) {
  console.error("TypeScript build-mode configuration audit failed:\n");
  console.error(failures.map((failure) => `- ${failure.trim()}`).join("\n"));
  process.exit(1);
}

console.log(`TypeScript build-mode configuration audit passed (${configs.length} projects)`);

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
}
