// Reads nothing but itself, so an edit to src.mjs must NOT rerun this test.
import test from 'node:test';
import assert from 'node:assert/strict';
test('b: arithmetic', () => assert.equal(1 + 1, 2));
