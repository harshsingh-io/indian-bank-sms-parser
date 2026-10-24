/**
 * Assertions and the case registry.
 *
 * Separate from run.mjs on purpose: test files import the harness, and run.mjs
 * imports both. Putting these in run.mjs makes that a cycle, and ESM deadlocks
 * on the top-level await that loads the tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { Parser } from '../src/parser.ts';

export const cases = [];
export const state = { assertions: 0 };

export function test(name, fn) { cases.push({ name, fn }); }
export function fail(msg) { throw new Error(msg); }

export function assertSame(expected, actual, msg = '') {
  state.assertions++;
  const a = JSON.stringify(expected) ?? 'undefined';
  const b = JSON.stringify(actual) ?? 'undefined';
  if (a !== b) fail(`${msg || 'values differ'}\n      expected: ${a}\n      actual:   ${b}`);
}
export function assertTrue(actual, msg = 'expected true') { assertSame(true, actual, msg); }
export function assertNull(actual, msg = 'expected null') {
  state.assertions++;
  if (actual !== null && actual !== undefined) fail(`${msg}, got ${JSON.stringify(actual)}`);
}
export async function assertThrows(fn, msg = 'expected an exception') {
  state.assertions++;
  try { await fn(); } catch { return; }
  fail(msg);
}

export function loadProfiles() {
  // Read from disk rather than importing the bundle, so a profile added as a
  // file is picked up by the fixture run without touching any code.
  const dir = new URL('../src/profiles/banks/', import.meta.url);
  const banks = readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
  const generic = JSON.parse(
    readFileSync(new URL('../src/profiles/generic.json', import.meta.url), 'utf8'));
  return { banks, generic };
}

export function testParser(opts = {}) {
  const { banks, generic } = loadProfiles();
  return new Parser(banks, generic,
    { timezone: 'Asia/Kolkata', storeBalance: false, requireKnownSender: true, ...opts });
}
