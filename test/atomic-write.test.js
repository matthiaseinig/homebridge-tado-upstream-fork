import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/helper/atomic-write.js';

test('writeFileAtomic replaces the file and leaves no temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  try {
    const file = join(dir, 'status.json');
    await writeFileAtomic(file, '{"a":1}');
    await writeFileAtomic(file, '{"a":2}');
    assert.equal(await readFile(file, 'utf8'), '{"a":2}');
    assert.deepEqual(await readdir(dir), ['status.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic cleans up and rethrows when the target folder is missing', async () => {
  await assert.rejects(() => writeFileAtomic(join(tmpdir(), 'tado-harden-missing-dir', 'x.json'), '{}'));
});

test('concurrent writes in the same millisecond use distinct temp files and leave a whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tado-harden-test-'));
  try {
    const file = join(dir, 'status.json');
    const a = 'A'.repeat(300000);
    const b = 'B'.repeat(10);
    const realNow = Date.now;
    const t = realNow();
    Date.now = () => t;
    let results;
    try {
      results = await Promise.allSettled([writeFileAtomic(file, a), writeFileAtomic(file, b), writeFileAtomic(file, a)]);
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    const content = await readFile(file, 'utf8');
    assert.ok(content === a || content === b);
    assert.deepEqual(await readdir(dir), ['status.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
