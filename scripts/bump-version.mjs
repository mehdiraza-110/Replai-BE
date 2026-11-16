#!/usr/bin/env node
// Bumps the 4-part release version in ./VERSION (1.0.0.0 -> 1.0.0.1).
// Usage: node scripts/bump-version.mjs            -> increment the last part
//        node scripts/bump-version.mjs 1.1.0.0    -> set an explicit version
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../VERSION', import.meta.url));
const PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const current = readFileSync(file, 'utf8').trim();
const arg = process.argv[2];

let next;
if (arg) {
  if (!PATTERN.test(arg)) { console.error(`"${arg}" is not a version like 1.0.0.1`); process.exit(1); }
  next = arg;
} else {
  if (!PATTERN.test(current)) { console.error(`VERSION holds "${current}", expected 1.0.0.0`); process.exit(1); }
  const parts = current.split('.').map(Number);
  parts[3] += 1;
  next = parts.join('.');
}
writeFileSync(file, `${next}\n`);
console.log(`${current} -> ${next}`);
