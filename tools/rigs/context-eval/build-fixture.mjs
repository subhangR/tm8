#!/usr/bin/env node
// Emit fixtures/fixture-v2.json from fixture-data.mjs + fixtures/replicas-v2.json.
// Re-run after any fixture-data change; a CONTENT change bumps SCHEMA_VERSION
// (report.mjs refuses to diff runs across versions).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fixtureContent } from './fixture-data.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const replicasPath = new URL('replicas-v2.json', dir);
const replicas = existsSync(replicasPath) ? JSON.parse(readFileSync(replicasPath, 'utf8')).replicas : [];
const fx = fixtureContent(replicas);
const canonical = JSON.stringify(fx);
fx.contentHash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
writeFileSync(new URL('fixture-v2.json', dir), JSON.stringify(fx, null, 2) + '\n');
console.error(`fixture-v2.json: schema ${fx.schemaVersion}, ${Object.keys(fx.tasks).length} tasks (${replicas.length} replicas), hash ${fx.contentHash}`);
