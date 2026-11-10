import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCESS, FIELDS, UNIQUE, TABLES, PROTECTED_TASK_FIELDS, generateIndexes, generateRules, collectionOf } from '../../src/blocks/schema.js';
import { CORE_TASK_FIELDS } from '../../src/blocks/store.js';

const coreRoot = fileURLToPath(new URL('../../', import.meta.url));

const MATRIX = {
  FactoryTask: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner', 'factory-core'], edit: ['factory-owner', 'factory-core'] },
  FactoryDoc: { read: ['factory-owner', 'factory-core'], insert: ['factory-core'] },
  FactoryApproval: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'] },
  FactorySettings: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'], edit: ['factory-owner'] },
  FactoryRun: { read: ['factory-owner', 'factory-core'], insert: ['factory-core'], edit: ['factory-core'] },
  FactoryEvent: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner', 'factory-core'] },
  FactorySpike: { read: ['factory-core'], insert: ['factory-core'], delete: ['factory-core'] },
  FactoryDef: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'], edit: ['factory-owner'] },
  FactoryRepo: { read: ['factory-owner', 'factory-core'], insert: ['factory-owner'], edit: ['factory-owner'] },
  FactoryHealth: { read: ['factory-owner', 'factory-core'], insert: ['factory-core'], edit: ['factory-core'] },
};
const CLS_FIELDS = ['title', 'description', 'repo', 'baseBranch', 'gateOverrides', 'factoryId'];

type Policy = { schemaName: string; policyName: string; policyType: number; operation: number; fieldNames: unknown[]; ruleGroup: { rules: { staticValue: string[] }[] } };
type Rules = { security: { schemaName: string; operation: number; policyType: number; accessLevel: number; fieldNames: string[] }[]; policies: Policy[] };

describe('blocks schema', () => {
  it('ACCESS equals the matrix', () => {
    expect(ACCESS).toEqual(MATRIX);
    expect(TABLES).toHaveLength(10);
    expect(collectionOf('FactoryTask')).toBe('FactoryTasks');
  });

  it('rules: no delete policy except FactorySpike, every row-level policy has empty fieldNames', () => {
    const rules = generateRules() as Rules;
    const deletes = rules.policies.filter(p => p.operation === 3).map(p => p.schemaName);
    expect(new Set(deletes)).toEqual(new Set(['FactorySpike']));
    const rowLevel = rules.policies.filter(p => p.policyType === 0);
    expect(rowLevel.every(p => Array.isArray(p.fieldNames) && p.fieldNames.length === 0)).toBe(true);
    expect(rules.security.filter(e => e.policyType === 0)).toHaveLength(10 * 4);
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

  it('exactly one column write rule: owner-only CLS EDIT on the six protected fields (factoryId included), none for the core', () => {
    const rules = generateRules() as Rules;
    const cls = rules.policies.filter(p => p.policyType === 1);
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({ schemaName: 'FactoryTask', policyName: 'factory-task-edit-fields-factory-owner', operation: 2, isAllowPolicy: true, fieldNames: CLS_FIELDS });
    expect(cls[0]!.ruleGroup.rules.map(r => r.staticValue)).toEqual([['factory-owner']]);
    expect(JSON.stringify(cls[0])).not.toContain('factory-core');
    expect(rules.security).toHaveLength(41);
    expect(rules.security.filter(e => e.policyType === 1)).toEqual([{ schemaName: 'FactoryTask', operation: 2, policyType: 1, accessLevel: 3, fieldNames: CLS_FIELDS }]);
    expect(PROTECTED_TASK_FIELDS).toEqual(cls[0]!.fieldNames);
    for (const f of PROTECTED_TASK_FIELDS) expect(FIELDS.FactoryTask.map(x => x.name)).toContain(f);
  });

  it('the core may insert a FactoryTask, yet the CLS EDIT rule still protects the same fields for the owner only', () => {
    expect(ACCESS.FactoryTask.insert).toEqual(['factory-owner', 'factory-core']);
    const rules = generateRules() as Rules;
    const insertRoles = rules.policies.filter(p => p.schemaName === 'FactoryTask' && p.policyType === 0 && p.operation === 1).map(p => p.ruleGroup.rules[0]!.staticValue[0]);
    expect(insertRoles.sort()).toEqual(['factory-core', 'factory-owner']);
    const cls = rules.policies.filter(p => p.policyType === 1);
    expect(cls).toHaveLength(1);
    expect(cls[0]!.fieldNames).toEqual(CLS_FIELDS);
    expect(cls[0]!.ruleGroup.rules.map(r => r.staticValue)).toEqual([['factory-owner']]);
  });

  it('factoryId is a field of FactoryTask and FactoryEvent; definitions are owner-written, health core-written', () => {
    for (const table of ['FactoryTask', 'FactoryEvent'] as const) expect(FIELDS[table].map(f => f.name)).toContain('factoryId');
    const rules = generateRules() as Rules;
    const roles = (schema: string, operation: number) => rules.policies.filter(p => p.schemaName === schema && p.policyType === 0 && p.operation === operation).map(p => p.ruleGroup.rules[0]!.staticValue[0]);
    for (const table of ['FactoryDef', 'FactoryRepo']) expect([roles(table, 1), roles(table, 2)]).toEqual([['factory-owner'], ['factory-owner']]);
    expect([roles('FactoryHealth', 1), roles('FactoryHealth', 2)]).toEqual([['factory-core'], ['factory-core']]);
    for (const table of ['FactoryDef', 'FactoryRepo', 'FactoryHealth']) expect(roles(table, 3)).toEqual([]);
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
    expect(indexes).toHaveLength(10);
    expect(indexes).toContainEqual({ schemaName: 'FactoryDef', fields: ['factoryId'], name: 'factory_def_factoryid_unique' });
    expect(indexes).toContainEqual({ schemaName: 'FactoryRepo', fields: ['repoKey'], name: 'factory_repo_repokey_unique' });
    expect(indexes).toContainEqual({ schemaName: 'FactoryHealth', fields: ['factoryId'], name: 'factory_health_factoryid_unique' });
  });

  it('--check passes against the committed files', () => {
    const r = spawnSync('npx', ['tsx', 'tools/blocks-resources.ts', '--check'], { cwd: coreRoot, encoding: 'utf8' });
    expect(r.stderr + r.stdout).not.toMatch(/differs/);
    expect(r.status).toBe(0);
  });
});
