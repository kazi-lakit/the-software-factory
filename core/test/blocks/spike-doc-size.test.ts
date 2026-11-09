import { describe, expect, it } from 'vitest';
import { FakeBlocksData } from '../../src/blocks/fakeData.js';
import type { BlocksData, Filter } from '../../src/blocks/data.js';
import { main, runSpike, spikeBody, REFUSAL, SPIKE_SIZES } from '../../tools/spike-doc-size.js';

describe('spikeBody', () => {
  it('is deterministic, exactly N UTF-8 bytes, and mixes ASCII with multi-byte characters', () => {
    for (const n of [1, 7, 1000, 262_144]) {
      const b = spikeBody(n);
      expect(Buffer.byteLength(b, 'utf8')).toBe(n);
      expect(spikeBody(n)).toBe(b);
    }
    const big = spikeBody(5000);
    expect(big.length).toBeLessThan(5000);
    expect(/^[\x00-\x7f]*$/.test(big)).toBe(false);
  });
});

describe('runSpike', () => {
  it('passes every size and hard-deletes each row', async () => {
    const data = new FakeBlocksData('factory-core');
    const lines: string[] = [];
    expect(await runSpike(data, { sizes: [1024, 2048, 4096], log: (l) => lines.push(l) })).toBe(true);
    expect(lines).toEqual(['1KiB ok', '2KiB ok', '4KiB ok']);
    expect(data.rows('FactorySpike')).toEqual([]);
  });

  it('labels the default sizes', () => {
    expect(SPIKE_SIZES).toEqual([262_144, 1_048_576, 4_194_304, 8_388_608]);
  });

  it('marks a corrupted read-back failed, still deletes the row and stops', async () => {
    const fake = new FakeBlocksData('factory-core');
    const corrupting: BlocksData = {
      list: async (schema, filter: Filter, fields) => (await fake.list(schema, filter, fields)).map((r) => ({ ...r, body: `${String(r.body)}!` })),
      insert: (s, r) => fake.insert(s, r),
      update: (s, f, i) => fake.update(s, f, i),
      hardDelete: (s, id) => fake.hardDelete(s, id),
    };
    const lines: string[] = [];
    expect(await runSpike(corrupting, { sizes: [1024, 2048], log: (l) => lines.push(l) })).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^1KiB failed: /);
    expect(fake.rows('FactorySpike')).toEqual([]);
  });
});

describe('runSpike cleanup', () => {
  it('deletes a row whose insert stored it but threw', async () => {
    const data = new FakeBlocksData('factory-core');
    data.failNextReply('insert');
    const lines: string[] = [];
    expect(await runSpike(data, { sizes: [1024, 2048], log: (l) => lines.push(l) })).toBe(false);
    expect(lines).toEqual(['1KiB failed: fake: insert reply lost']);
    expect(data.rows('FactorySpike')).toEqual([]);
  });

  it('prints cleanup needed with the key when the cleanup delete fails', async () => {
    const fake = new FakeBlocksData('factory-core');
    fake.failNextReply('insert');
    const noDelete: BlocksData = {
      list: (s, f, fl) => fake.list(s, f, fl), insert: (s, r) => fake.insert(s, r), update: (s, f, i) => fake.update(s, f, i),
      hardDelete: async () => { throw new Error('blocks: deleteFactorySpike failed (HTTP 500)'); },
    };
    const lines: string[] = [];
    await runSpike(noDelete, { sizes: [1024], log: (l) => lines.push(l) });
    expect(lines.some((l) => /^cleanup needed: spikeKey spike-1024-[0-9a-f]{8}$/.test(l))).toBe(true);
  });

  it('passes the first error line (with HTTP status) through, never more', async () => {
    const fake = new FakeBlocksData('factory-core');
    const failing: BlocksData = {
      list: (s, f, fl) => fake.list(s, f, fl), update: (s, f, i) => fake.update(s, f, i), hardDelete: (s, id) => fake.hardDelete(s, id),
      insert: async () => { throw new Error('blocks: insertFactorySpike failed (HTTP 413)\nsecret-detail'); },
    };
    const lines: string[] = [];
    await runSpike(failing, { sizes: [1024], log: (l) => lines.push(l) });
    expect(lines).toEqual(['1KiB failed: blocks: insertFactorySpike failed (HTTP 413)']);
  });
});

describe('main', () => {
  it('refuses without the confirm flag', async () => {
    const lines: string[] = [];
    expect(await main([], (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([REFUSAL]);
  });
});
