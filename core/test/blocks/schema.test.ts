import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCESS, TABLES, generateIndexes, generateRules, collectionOf } from '../../src/blocks/schema.js';

const coreRoot = fileURLToPath(new URL('../../', import.meta.url));

const MATRIX = {
  FactoryTask: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'], edit: ['factory-owner', 'factory-core'] },
  FactoryDoc: { read: ['factory-owner', 'factory-core'], insert: ['factory-core'] },
  FactoryApproval: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'] },
  FactorySettings: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'], edit: ['factory-owner'] },
  FactoryRun: { read: ['factory-owner', 'factory-core'], insert: ['factory-core'], edit: ['factory-core'] },
  FactoryEvent: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner', 'factory-core'] },
  FactorySpike: { read: ['factory-core'], insert: ['factory-core'], delete: ['factory-core'] },
};

type Policy = { schemaName: string; policyName: string; operation: number; fieldNames: unknown[]; ruleGroup: { rules: { staticValue: string[] }[] } };
type Rules = { security: { schemaName: string; operation: number }[]; policies: Policy[] };

describe('blocks schema', () => {
  it('ACCESS equals the matrix', () => {
    expect(ACCESS).toEqual(MATRIX);
    expect(TABLES).toHaveLength(7);
    expect(collectionOf('FactoryTask')).toBe('FactoryTasks');
  });

  it('rules: no delete policy except FactorySpike, every policy has empty fieldNames', () => {
    const rules = generateRules() as Rules;
    const deletes = rules.policies.filter(p => p.operation === 3).map(p => p.schemaName);
    expect(new Set(deletes)).toEqual(new Set(['FactorySpike']));
    expect(rules.policies.every(p => Array.isArray(p.fieldNames) && p.fieldNames.length === 0)).toBe(true);
    expect(rules.security).toHaveLength(7 * 4);
    expect(rules.policies.map(p => p.policyName)).toContain('factory-task-edit-factory-core');
    expect(rules.policies.map(p => p.policyName)).toContain('factory-settings-insert-factory-owner');
  });

  it('indexes follow factory_<table>_<field>_unique', () => {
    const indexes = generateIndexes() as { schemaName: string; fields: string[]; name: string }[];
    expect(indexes).toContainEqual({ schemaName: 'FactoryTask', fields: ['taskId'], name: 'factory_task_taskid_unique' });
    for (const i of indexes) expect(i.name).toBe(`factory_${i.schemaName.replace('Factory', '').toLowerCase()}_${i.fields[0]!.toLowerCase()}_unique`);
    expect(indexes).toHaveLength(7);
  });

  it('--check passes against the committed files', () => {
    const r = spawnSync('npx', ['tsx', 'tools/blocks-resources.ts', '--check'], { cwd: coreRoot, encoding: 'utf8' });
    expect(r.stderr + r.stdout).not.toMatch(/differs/);
    expect(r.status).toBe(0);
  });
});
