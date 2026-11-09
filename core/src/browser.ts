// The browser entry: only modules with no Node-only API and no credential. Task 2 adds the owner.ts exports (R1).
export { BlocksStore, CORE_TASK_FIELDS } from './blocks/store.js';
export { SdkBlocksData } from './blocks/data.js';
export type { TokenSource } from './blocks/token.js';
export { PROTECTED_TASK_FIELDS } from './blocks/schema.js';
export { assertMove, canMove, STEP_STATUS, TERMINAL } from './status.js';
export { GATE_DOC, resolveSettings, resolveGates, validApproval, shouldMerge } from './gates.js';
export type {
  RepoId, Status, Step, AgentStep, Gate, DocKind, Mode, Task, Doc, Approval, Settings, RepoSettings, Run, FactoryEvent, AgentResult,
} from './types.js';
export { DEFAULT_SETTINGS } from './defaults.js';
export { MAX_DOC_BYTES } from './limits.js';
export { ForbiddenError, VersionConflictError, NotFoundError } from './boardStore.js';
export { diffEvents } from './history.js';
