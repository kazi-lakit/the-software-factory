import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCESS, FIELDS, UNIQUE, TABLES, PROTECTED_TASK_FIELDS, generateIndexes, generateRules, collectionOf } from '../../src/blocks/schema.js';
import { CORE_TASK_FIELDS } from '../../src/blocks/store.js';

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

type Policy = { schemaName: string; policyName: string; policyType: number; operation: number; fieldNames: unknown[]; ruleGroup: { rules: { staticValue: string[] }[] } };
type Rules = { security: { schemaName: string; operation: number; policyType: number; accessLevel: number; fieldNames: string[] }[]; policies: Policy[] };

describe('blocks schema', () => {
  it('ACCESS equals the matrix', () => {
    expect(ACCESS).toEqual(MATRIX);
    expect(TABLES).toHaveLength(7);
    expect(collectionOf('FactoryTask')).toBe('FactoryTasks');
  });

  it('rules: no delete policy except FactorySpike, every row-level policy has empty fieldNames', () => {
    const rules = generateRules() as Rules;
    const deletes = rules.policies.filter(p => p.operation === 3).map(p => p.schemaName);
    expect(new Set(deletes)).toEqual(new Set(['FactorySpike']));
    const rowLevel = rules.policies.filter(p => p.policyType === 0);
    expect(rowLevel.every(p => Array.isArray(p.fieldNames) && p.fieldNames.length === 0)).toBe(true);
    expect(rules.security.filter(e => e.policyType === 0)).toHaveLength(7 * 4);
    expect(rules.policies.map(p => p.policyName)).toContain('factory-task-edit-factory-core');
    expect(rules.policies.map(p => p.policyName)).toContain('factory-settings-insert-factory-owner');
  });

  it('rules policies match the matrix triples', () => {
    const rules = generateRules() as Rules;
    const ops = ['read', 'insert', 'edit', 'delete'];
    const actual = rules.policies.filter(p => p.policyType === 0).map(p => `${p.schemaName}|${ops[p.operation]}|${p.ruleGroup.rules[0]!.staticValue[0]}`).sort();
    const expected = Object.entries(MATRIX).flatMap(([schema, byOp]) => Object.entries(byOp).flatMap(([op, roles]) => roles.map(role => `${schema}|${op}|${role}`))).sort();
    expect(actual).toEqual(expected);
  });

  it('exactly one column write rule: owner-only CLS EDIT on the five protected fields, none for the core', () => {
    const rules = generateRules() as Rules;
    const cls = rules.policies.filter(p => p.policyType === 1);
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({ schemaName: 'FactoryTask', policyName: 'factory-task-edit-fields-factory-owner', operation: 2, isAllowPolicy: true, fieldNames: ['title', 'description', 'repo', 'baseBranch', 'gateOverrides'] });
    expect(cls[0]!.ruleGroup.rules.map(r => r.staticValue)).toEqual([['factory-owner']]);
    expect(JSON.stringify(cls[0])).not.toContain('factory-core');
    expect(rules.security.filter(e => e.policyType === 1)).toEqual([{ schemaName: 'FactoryTask', operation: 2, policyType: 1, accessLevel: 3, fieldNames: ['title', 'description', 'repo', 'baseBranch', 'gateOverrides'] }]);
    expect(PROTECTED_TASK_FIELDS).toEqual(cls[0]!.fieldNames);
    for (const f of PROTECTED_TASK_FIELDS) expect(FIELDS.FactoryTask.map(x => x.name)).toContain(f);
  });

  it('protected and core task fields are disjoint', () => {
    expect(PROTECTED_TASK_FIELDS.filter(f => (CORE_TASK_FIELDS as readonly string[]).includes(f))).toEqual([]);
  });

  it('every UNIQUE field exists in FIELDS', () => {
    for (const t of TABLES) for (const f of UNIQUE[t]) expect(FIELDS[t].map(x => x.name)).toContain(f);
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
