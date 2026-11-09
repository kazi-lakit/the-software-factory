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

describe('main', () => {
  it('refuses without the confirm flag', async () => {
    const lines: string[] = [];
    expect(await main([], (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([REFUSAL]);
  });
});
