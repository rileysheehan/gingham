const {test} = require('node:test');
const assert = require('node:assert/strict');
const {policy, markStale} = require('../dist/sw.js');

const at = 'https://frame.test', p = (path, method = 'GET') => policy(method, at + path, at);

test('What the frame may keep for a bad day, and what it never keeps', () => {
  for (const path of ['/api/calendar?from=2026-09-20&to=2026-10-18', '/api/tasks', '/api/weather', '/api/household', '/api/settings', '/api/photos']) assert.equal(p(path), 'data', path);
  for (const path of ['/', '/app.js', '/style.css', '/fonts/inter-4.1-var.woff2', '/lists', '/lists-page.js']) assert.equal(p(path), 'shell', path);
  assert.equal(p('/photos/up-0123456789abcdef01234567.jpg'), 'photo');
  // Secrets in an address, the pages that change things, and every write stay out of it entirely.
  for (const path of ['/?k=a-frame-secret', '/s/a-one-time-link', '/setup', '/admin', '/photos', '/api/setup', '/api/setup/places?q=x', '/api/admin', '/api/pair/poll', '/api/owner-code', '/healthz']) assert.equal(p(path), 'pass', path);
  for (const path of ['/api/tasks', '/api/settings', '/api/tasks/123/close', '/api/photos/add']) assert.equal(p(path, 'POST'), 'pass', 'POST ' + path);
  assert.equal(policy('GET', 'https://elsewhere.test/api/tasks', at), 'pass', 'another origin');
  assert.equal(policy('GET', 'not a url', at), 'pass');
});

test('An answer from the cupboard says it is stale, in the words the page already understands', () => {
  assert.deepEqual(JSON.parse(markStale('{"events":[],"updatedAt":"2026-09-20T20:00:00Z"}')), {events: [], updatedAt: '2026-09-20T20:00:00Z', stale: true});
  assert.equal(markStale('[1,2]'), '[1,2]');
  assert.equal(markStale('<html>'), '<html>');
});
