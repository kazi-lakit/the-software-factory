// Board tables, indexes and access rules as code. `tools/blocks-resources.ts` renders these into the
// files the `blocks` CLI deploys. Ported from ACR's tools/blocks-store/resources.ts.
export const TABLES = ['FactoryTask', 'FactoryDoc', 'FactoryApproval', 'FactorySettings', 'FactoryRun', 'FactoryEvent', 'FactorySpike'] as const;
export type SchemaName = (typeof TABLES)[number];
export type Role = 'factory-owner' | 'factory-core';
export type Operation = 'read' | 'insert' | 'edit' | 'delete';
export type Field = { name: string; type: 'String' | 'Int'; description: string };

const s = (name: string, description: string): Field => ({ name, type: 'String', description });
const i = (name: string, description: string): Field => ({ name, type: 'Int', description });

/** Only String and Int: objects and decimals are JSON or decimal text in a String field. */
export const FIELDS: Record<SchemaName, Field[]> = {
  FactoryTask: [
    s('taskId', 'Unique id of the task.'), s('title', 'Task title.'), s('description', 'Task description.'), s('repo', 'Repo id the task targets.'),
    s('baseBranch', 'Branch the task branches from.'), s('status', 'Task status.'), s('stage', 'Current pipeline stage.'), s('branch', 'Task branch name.'),
    s('prUrl', 'Pull request URL.'), s('blockedReason', 'Why the task is blocked.'), s('question', 'Open question for the owner.'), s('answer', 'Owner answer to the question.'),
    s('gateOverrides', 'JSON text of the gate overrides.'), s('claimBy', 'Worker that holds the claim.'), s('claimUntil', 'ISO time the claim expires.'),
    s('costUsd', 'Total cost in USD, as decimal text.'), i('attempt', 'Attempt counter.'), i('version', 'Row version; bumped on every update.'), s('writeId', 'Id of the write that produced this version.'),
  ],
  FactoryDoc: [
    s('docKey', 'Unique key: taskId:kind:version.'), s('taskId', 'Task the document belongs to.'), s('kind', 'Document kind.'), i('version', 'Document version.'),
    s('body', 'Document body.'), s('bodySha256', 'SHA-256 of the body.'), s('author', 'Author of the document.'),
  ],
  FactoryApproval: [
    s('approvalId', 'Unique id of the approval.'), s('taskId', 'Task the approval belongs to.'), s('gate', 'Gate the approval covers.'),
    i('docVersion', 'Document version approved.'), s('decision', 'Approval decision.'), s('comment', 'Reviewer comment.'), s('at', 'ISO time of the decision.'),
  ],
  FactorySettings: [
    s('scope', 'Unique scope: global or a repo id.'), s('json', 'JSON text of the Settings or RepoSettings object.'),
    i('version', 'Row version; bumped on every update.'), s('writeId', 'Id of the write that produced this version.'),
  ],
  FactoryRun: [
    s('runId', 'Unique id of the run.'), s('taskId', 'Task the run belongs to.'), s('step', 'Pipeline step the run executed.'), s('mode', 'Run mode.'),
    s('agent', 'Agent that ran the step.'), s('startedAt', 'ISO start time.'), s('endedAt', 'ISO end time.'), s('result', 'Run result.'),
    i('turns', 'Number of agent turns.'), s('costUsd', 'Run cost in USD, as decimal text.'), i('version', 'Row version; bumped on every update.'), s('writeId', 'Id of the write that produced this version.'),
  ],
  FactoryEvent: [
    s('eventId', 'Unique id: SHA-256 of the event JSON.'), s('taskId', 'Task the event belongs to.'), s('actor', 'Who caused the event.'), s('action', 'What happened.'),
    s('field', 'Field that changed.'), s('from', 'Previous value.'), s('to', 'New value.'), s('reason', 'Why it changed.'), s('at', 'ISO time of the event.'),
  ],
  FactorySpike: [s('spikeKey', 'Unique key of the spike row.'), s('body', 'Spike payload.'), s('bodySha256', 'SHA-256 of the body.')],
};

/** Each listed field is its own single-field unique index. */
export const UNIQUE: Record<SchemaName, string[]> = {
  FactoryTask: ['taskId'], FactoryDoc: ['docKey'], FactoryApproval: ['approvalId'], FactorySettings: ['scope'],
  FactoryRun: ['runId'], FactoryEvent: ['eventId'], FactorySpike: ['spikeKey'],
};

const both: Role[] = ['factory-owner', 'factory-core'];
/** Delete exists only on FactorySpike. */
export const ACCESS: Record<SchemaName, Partial<Record<Operation, Role[]>>> = {
  FactoryTask: { read: both, insert: both, edit: both },
  FactoryDoc: { read: both, insert: ['factory-core'] },
  FactoryApproval: { read: both, insert: ['factory-owner'] },
  FactorySettings: { read: both, insert: ['factory-owner'], edit: ['factory-owner'] },
  FactoryRun: { read: both, insert: ['factory-core'], edit: ['factory-core'] },
  FactoryEvent: { read: both, insert: both },
  FactorySpike: { read: ['factory-core'], insert: ['factory-core'], delete: ['factory-core'] },
};

// Operation numbers follow the Blocks probe entries.
const OPERATIONS: { key: Operation; number: number; verb: string }[] = [
  { key: 'read', number: 0, verb: 'reads' }, { key: 'insert', number: 1, verb: 'inserts' },
  { key: 'edit', number: 2, verb: 'edits' }, { key: 'delete', number: 3, verb: 'deletes' },
];

/**
 * FactoryTask fields only factory-owner may change. A column write rule (CLS, EDIT) makes Blocks refuse a core
 * update that changes one of them. Must stay disjoint from the store's CORE_TASK_FIELDS.
 */
export const PROTECTED_TASK_FIELDS: readonly string[] = ['title', 'description', 'repo', 'baseBranch', 'gateOverrides'];

export const collectionOf = (schema: SchemaName): string => `${schema}s`;
const kebab = (schema: SchemaName) => schema.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const tableLabel = (schema: SchemaName) => schema.replace('Factory', '').toLowerCase();

export function generateRules(): { security: object[]; policies: object[] } {
  const security: object[] = [];
  const policies: object[] = [];
  for (const schema of TABLES) {
    // Every operation gets a security entry, so an operation with no policy means nobody.
    for (const operation of [0, 1, 2, 3]) security.push({ schemaName: schema, operation, policyType: 0, accessLevel: 3, fieldNames: [] });
    for (const op of OPERATIONS) {
      for (const role of ACCESS[schema][op.key] ?? []) {
        policies.push({
          schemaName: schema,
          policyName: `${kebab(schema)}-${op.key}-${role}`,
          policyDescription: `${role} ${op.verb} ${schema} rows.`,
          policyType: 0,
          operation: op.number,
          fieldNames: [],
          ruleGroup: { logicalOperator: 0, nestedGroups: [], rules: [{ leftSource: 0, leftOperand: 'Roles', operator: 6, rightSource: 2, staticValue: [role] }] },
          priority: 0,
          isAllowPolicy: true,
        });
      }
    }
  }
  // Column write rule: an allow-list, so exactly one policy for the owner and none for the core.
  // The security entry sets the fields' EDIT level to Custom (otherwise the rule is ignored).
  security.push({ schemaName: 'FactoryTask', operation: 2, policyType: 1, accessLevel: 3, fieldNames: [...PROTECTED_TASK_FIELDS] });
  policies.push({
    schemaName: 'FactoryTask',
    policyName: 'factory-task-edit-fields-factory-owner',
    policyDescription: `Only factory-owner changes ${PROTECTED_TASK_FIELDS.join(', ')}.`,
    policyType: 1,
    operation: 2,
    fieldNames: [...PROTECTED_TASK_FIELDS],
    ruleGroup: { logicalOperator: 0, nestedGroups: [], rules: [{ leftSource: 0, leftOperand: 'Roles', operator: 6, rightSource: 2, staticValue: ['factory-owner'] }] },
    priority: 0,
    isAllowPolicy: true,
  });
  return { security, policies };
}

export function generateFields(schema: SchemaName): { fields: { name: string; type: string; isArray: false; description: string }[] } {
  return { fields: FIELDS[schema].map(({ name, type, description }) => ({ name, type, isArray: false, description })) };
}

export function generateIndexes(): { schemaName: string; fields: string[]; name: string }[] {
  return TABLES.flatMap(schema => UNIQUE[schema].map(field => ({ schemaName: schema, fields: [field], name: `factory_${tableLabel(schema)}_${field.toLowerCase()}_unique` })));
}
