/** Studio id/hostname/URL derivation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HOSTNAME_PREFIX = 'ozwell-studio';
process.env.EXTERNAL_DOMAIN = 'example.org';
process.env.EXTERNAL_SCHEME = 'https';
process.env.STUDIO_PATH = '/studio/';
process.env.STUDIO_PORT = '6080';

const { newId, hostnameFor, idFrom, studioUrl, studioUrlFrom } = await import(
  '../src/studios/naming.js'
);

test('newId is a short hex id', () => {
  assert.match(newId(), /^[0-9a-f]{8}$/);
});

test('hostnameFor prefixes the id; idFrom round-trips it', () => {
  assert.equal(hostnameFor('ab12cd34'), 'ozwell-studio-ab12cd34');
  assert.equal(idFrom('ozwell-studio-ab12cd34'), 'ab12cd34');
});

test('studioUrl follows the naming convention', () => {
  assert.equal(studioUrl('ab12cd34'), 'https://ab12cd34-studio.example.org/studio/');
});

test('studioUrlFrom prefers the container service record', () => {
  const container = {
    hostname: 'ozwell-studio-ab12cd34',
    services: [
      { internalPort: 3000, httpService: { externalHostname: 'ab12cd34' } },
      {
        internalPort: 6080,
        httpService: { externalHostname: 'ab12cd34-studio', domain: 'other.example.net' },
      },
    ],
  };
  assert.equal(studioUrlFrom(container), 'https://ab12cd34-studio.other.example.net/studio/');
});

test('studioUrlFrom defaults the domain when the record has none', () => {
  const container = {
    hostname: 'ozwell-studio-ab12cd34',
    services: [{ internalPort: 6080, httpService: { externalHostname: 'ab12cd34-studio' } }],
  };
  assert.equal(studioUrlFrom(container), 'https://ab12cd34-studio.example.org/studio/');
});

test('studioUrlFrom falls back to the convention without a studio service', () => {
  const container = { hostname: 'ozwell-studio-ab12cd34' };
  assert.equal(studioUrlFrom(container), 'https://ab12cd34-studio.example.org/studio/');
});
