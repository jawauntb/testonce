// Reads src.mjs, so an edit to src.mjs must rerun this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from './src.mjs';
test('a: value is positive', () => assert.ok(value > 0));
