// The vitest names the kept rules and server tests use (describe / it /
// expect / beforeAll / afterAll), on node:test and node:assert, so they run
// unchanged under `node --test` without vitest.
import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

export { describe, it, test };
export const beforeAll = (fn) => before(fn);
export const afterAll = (fn) => after(fn);
export function expect(actual, msg) {
  const m = {
    toBe: (v) => assert.strictEqual(actual, v, msg),
    toEqual: (v) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(v)), msg),
    toContain: (v) => assert.ok(actual.includes(v), msg || `${JSON.stringify(actual)} contains ${JSON.stringify(v)}`),
    toBeNull: () => assert.strictEqual(actual, null, msg),
    toBeDefined: () => assert.notStrictEqual(actual, undefined, msg),
    toBeUndefined: () => assert.strictEqual(actual, undefined, msg),
    toBeGreaterThan: (v) => assert.ok(actual > v, msg || `${actual} > ${v}`),
    toBeGreaterThanOrEqual: (v) => assert.ok(actual >= v, msg || `${actual} >= ${v}`),
    toBeLessThan: (v) => assert.ok(actual < v, msg || `${actual} < ${v}`),
    toBeLessThanOrEqual: (v) => assert.ok(actual <= v, msg || `${actual} <= ${v}`),
    toBeCloseTo: (v, d = 2) => assert.ok(Math.abs(actual - v) < 10 ** -d / 2, msg || `${actual} ≈ ${v}`),
    toMatch: (re) => assert.match(actual, re, msg),
    toThrow: (want) => (want === undefined ? assert.throws(actual) : assert.throws(actual, (e) => (want instanceof RegExp ? want.test(e.message) : String(e.message).includes(want)))),
  };
  m.not = {
    toBe: (v) => assert.notStrictEqual(actual, v, msg),
    toEqual: (v) => assert.notDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(v)), msg),
    toContain: (v) => assert.ok(!actual.includes(v), msg),
    toThrow: () => assert.doesNotThrow(actual),
  };
  return m;
}
