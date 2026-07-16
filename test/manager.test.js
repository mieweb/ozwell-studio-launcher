/**
 * Pins normalizeDockerRef to the manager's canonicalization rules
 * (host/org/image:tag). If these tests break because the manager changed
 * its normalization, update both together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeDockerRef } = await import('../src/clients/manager.js');

test('bare image name gets docker.io/library and :latest', () => {
  assert.equal(normalizeDockerRef('ozwell-studio'), 'docker.io/library/ozwell-studio:latest');
});

test('explicit tag is preserved', () => {
  assert.equal(normalizeDockerRef('nginx:1.25'), 'docker.io/library/nginx:1.25');
});

test('org/image goes under docker.io', () => {
  assert.equal(normalizeDockerRef('mieweb/ozwell-studio'), 'docker.io/mieweb/ozwell-studio:latest');
});

test('a dotted first segment is a registry host, org defaults to library', () => {
  assert.equal(normalizeDockerRef('ghcr.io/nginx'), 'ghcr.io/library/nginx:latest');
});

test('a first segment with a port is a registry host, not a tag', () => {
  assert.equal(normalizeDockerRef('registry:5000/nginx'), 'registry:5000/library/nginx:latest');
});

test('host/org/image with tag passes through canonically', () => {
  assert.equal(normalizeDockerRef('ghcr.io/mieweb/studio:v2'), 'ghcr.io/mieweb/studio:v2');
});

test('nested org paths are kept', () => {
  assert.equal(normalizeDockerRef('ghcr.io/org/sub/image:v2'), 'ghcr.io/org/sub/image:v2');
});

test('git and http(s) references are passed through untouched', () => {
  assert.equal(normalizeDockerRef('https://example.com/repo.git'), 'https://example.com/repo.git');
  assert.equal(normalizeDockerRef('git@github.com:foo/bar.git'), 'git@github.com:foo/bar.git');
});

test('normalization is idempotent', () => {
  const once = normalizeDockerRef('ozwell-studio');
  assert.equal(normalizeDockerRef(once), once);
});
