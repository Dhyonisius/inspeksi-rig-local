import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookieValue, jsonObjectBody } from './request-validation.js';
const error = (status, message) => Object.assign(new Error(message), { status });
test('valid and absent session cookies are decoded without altering other cookies', () => {
  assert.equal(sessionCookieValue('other=first; lentera_session=hello%20there', 'lentera_session'), 'hello there');
  assert.equal(sessionCookieValue('other=first', 'lentera_session'), '');
});
test('malformed cookie encoding is treated as an absent session', () => {
  assert.equal(sessionCookieValue('lentera_session=%', 'lentera_session'), '');
  assert.equal(sessionCookieValue('lentera_session=%FF', 'lentera_session'), '');
});
test('request JSON must be a readable object instead of a server TypeError', async () => {
  for (const body of ['null','[]','"hello"','true','3','{']) {
    await assert.rejects(jsonObjectBody(new Request('http://localhost/', { method:'POST', body }), error), cause => cause.status === 400);
  }
});
test('request JSON preserves valid fields', async () => {
  assert.deepEqual(await jsonObjectBody(new Request('http://localhost/', { method:'POST', body:'{"status":"REVIEW"}' }), error), { status:'REVIEW' });
});
