/** Studio list merge: manager rows + in-flight provisioning entries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SQL_URI = 'sqlite::memory:'; // service -> pool -> db
process.env.TEMPLATE = 'ozwell-studio';
process.env.HOSTNAME_PREFIX = 'ozwell-studio';
process.env.EXTERNAL_DOMAIN = 'example.org';
process.env.EXTERNAL_SCHEME = 'https';
process.env.STUDIO_PATH = '/studio/';
process.env.STUDIO_PORT = '6080';

const { mergeStudios } = await import('../src/studios/service.js');

const row = (hostname, overrides = {}) => ({
  hostname,
  template: 'ozwell-studio',
  status: 'running',
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

test('keeps only containers built from the configured template (post-normalization)', () => {
  const rows = [
    row('ozwell-studio-aaaa0001'),
    row('ozwell-studio-bbbb0002', { template: 'docker.io/library/ozwell-studio:latest' }),
    row('other-cccc0003', { template: 'nginx' }),
  ];
  const studios = mergeStudios(rows, new Map());
  assert.deepEqual(
    studios.map((s) => s.hostname),
    ['ozwell-studio-aaaa0001', 'ozwell-studio-bbbb0002']
  );
});

test('sorts newest first and passes manager statuses through', () => {
  const rows = [
    row('ozwell-studio-old', { createdAt: '2026-01-01T00:00:00Z', status: 'offline' }),
    row('ozwell-studio-new', { createdAt: '2026-02-01T00:00:00Z' }),
  ];
  const studios = mergeStudios(rows, new Map());
  assert.deepEqual(
    studios.map((s) => [s.hostname, s.status]),
    [
      ['ozwell-studio-new', 'running'],
      ['ozwell-studio-old', 'offline'],
    ]
  );
});

test('an in-flight create overrides the manager status', () => {
  const rows = [row('ozwell-studio-aaaa0001', { status: 'missing' })];
  const provisions = new Map([
    ['ozwell-studio-aaaa0001', { hostname: 'ozwell-studio-aaaa0001', status: 'creating' }],
  ]);
  assert.equal(mergeStudios(rows, provisions)[0].status, 'creating');
});

test('folds in creates the manager does not list yet, newest on top', () => {
  const rows = [row('ozwell-studio-aaaa0001')];
  const provisions = new Map([
    [
      'ozwell-studio-bbbb0002',
      {
        hostname: 'ozwell-studio-bbbb0002',
        status: 'creating',
        url: 'https://bbbb0002-studio.example.org/studio/',
      },
    ],
  ]);
  const studios = mergeStudios(rows, provisions);
  assert.deepEqual(studios[0], {
    hostname: 'ozwell-studio-bbbb0002',
    status: 'creating',
    url: 'https://bbbb0002-studio.example.org/studio/',
    createdAt: null,
    pooled: false,
  });
  assert.equal(studios.length, 2);
});

test('does not fold in failed provisions the manager never listed', () => {
  const provisions = new Map([
    ['ozwell-studio-dead0004', { hostname: 'ozwell-studio-dead0004', status: 'failed' }],
  ]);
  assert.deepEqual(mergeStudios([], provisions), []);
});

test('derives URLs from the container service record', () => {
  const rows = [
    row('ozwell-studio-aaaa0001', {
      services: [{ internalPort: 6080, httpService: { externalHostname: 'aaaa0001-studio' } }],
    }),
  ];
  assert.equal(mergeStudios(rows, new Map())[0].url, 'https://aaaa0001-studio.example.org/studio/');
});

test('flags studios whose hostname is in the pool, and only those', () => {
  const rows = [row('ozwell-studio-aaaa0001'), row('ozwell-studio-bbbb0002')];
  const pooled = new Set(['ozwell-studio-bbbb0002']);
  const studios = mergeStudios(rows, new Map(), pooled);
  assert.deepEqual(
    studios.map((s) => [s.hostname, s.pooled]),
    [
      ['ozwell-studio-aaaa0001', false],
      ['ozwell-studio-bbbb0002', true],
    ]
  );
});

test('pooled defaults to false for everything when no pool set is given', () => {
  const studios = mergeStudios([row('ozwell-studio-aaaa0001')], new Map());
  assert.equal(studios[0].pooled, false);
});
