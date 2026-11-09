# Blocks Board Store Implementation Plan (plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **USER** are run by the user in their own terminal (they use the user's Blocks sign-in or the factory credential); the executor prepares them, shows the exact commands, waits, and records the result.

**Goal:** Put the Board in the factory's own Blocks project: create the project and its six tables with access rules, measure how much text a Blocks Data field holds, and build `BlocksStore`, a `BoardStore` that the engine and `factory --store blocks` use.

**Architecture:** Same shape ACR proved on Blocks Data: GraphQL over the `@seliseblocks/client` SDK, one machine client credential for the factory core (role `factory-core`), the user with role `factory-owner`, Custom access on every table with per-role allow policies and no delete policy, and compare-and-set updates on a `version` field. Code is ported from ACR, not imported. The resources (fields, indexes, rules) are generated from TypeScript tables, so code and deployed rules can't drift.

**Tech Stack:** what plan 1 uses, plus `@seliseblocks/client` 0.3.0 and the `blocks` CLI 0.11.0 (user's machine).

**Spec:** `docs/superpowers/specs/2026-11-09-software-factory-design.md` §4, §10, §12.1. Research: `docs/research/2026-11-09-blocks-data-from-acr.md` (every ACR path below is relative to `~/scratchpad/selise/build-with-blocks/agent-control-room`, read-only).

## Global Constraints

- Paths are relative to `~/scratchpad/selise/the-software-factory`. Code in `core/`; Blocks workspace files in `blocks.json` and `blocks/` at the factory root.
- **Never modify ACR or any Blocks repo.** Port code by copying and adapting it into `core/src/blocks/`.
- **No secrets anywhere:** the client secret and tokens are never printed, logged, written to a file or committed. The credential lives only in the macOS Keychain, service `the-software-factory`, account `blocks-credential`, as JSON `{clientId, clientSecret, projectKey, apiUrl}`.
- **The user runs every command that uses their Blocks sign-in or reads the factory credential** (all **USER** steps and the `core/tools/*` live scripts). Agents write and unit-test the code with fakes only; they never call Blocks.
- Every mutating `blocks` command is shown with `--dry-run` first, then run with `--yes` after the user approves. Use `BLOCKS_STRICT_FLAGS=1`.
- Table names: `FactoryTask`, `FactoryDoc`, `FactoryApproval`, `FactorySettings`, `FactoryRun`, `FactoryEvent`, plus `FactorySpike` for the size spike. Collection = schema name + `s`.
- Field types: only `String` and `Int` (what ACR proved). Objects and decimals are stored as JSON text in a `String` field.
- Roles: `factory-core` (machine client `factory-core`, token life 15 minutes) and `factory-owner` (the user's own account).
- Policy rules: `fieldNames: []` on every row-level policy (otherwise Blocks answers 400 after access has already flipped to Custom).
- Delete: no delete policy on the six Board tables (nobody deletes). `FactorySpike` alone allows `factory-core` to delete.
- Compare-and-set: classify `acknowledged === true && totalImpactedData === 1` as applied, `totalImpactedData === 0` as not applied, anything else as unknown; never use Blocks message text as a signal.
- Commits end with the Co-Authored-By line from the implementer's own harness reminder.

### Access matrix (source of truth for the generator)

| Table | `factory-owner` | `factory-core` |
|---|---|---|
| FactoryTask | read, insert, edit | read, edit |
| FactoryDoc | read | read, insert |
| FactoryApproval | read, insert | read |
| FactorySettings | read, insert, edit | read |
| FactoryRun | read | read, insert, edit |
| FactoryEvent | read, insert | read, insert |
| FactorySpike | — | read, insert, delete |

Spec §4 also says the core may edit only status, claim and result fields of a task. Blocks row rules can't express that; column write rules exist in the gateway (`ClsWriteGuard`) but are unproven. In this plan the core enforces it in code (Task 5), and Task 10 tries column rules live.

## Review Focus

1. **Lost acknowledgements:** a retried `addEvents` or `addDoc` after a lost response must not write a second row. Task 5 tests a fake that applies the write but throws on the reply.
2. **Compare-and-set outcomes:** a lost race must surface as `VersionConflictError`, a missing or forbidden row as `NotFoundError`, and an unknown outcome as a plain error, never as success. Task 2 and Task 5 tests.
3. **Owner-only methods under the core identity:** `createTask`, `addApproval`, `setSettings` on a core-identity store throw `OwnerOnlyError` without calling Blocks. Task 5 test.
4. **Too-large documents:** an agent doc over `MAX_DOC_BYTES` must end as a failed agent result (task goes on per the machine), not a crash in `complete`. Task 6 test.
5. **Credential safety:** `save-blocks-credential` never echoes the secret, and the secret never appears in a process argument list (it goes to `security -i` on stdin). Task 4 test with a stub.

---

### Task 1: Blocks resources as code

**Files:**
- Create: `core/src/blocks/schema.ts`, `core/tools/blocks-resources.ts`
- Create (generated, committed): `blocks/data/factory/<Schema>.fields.json` (7 files), `blocks/data/factory/indexes.json`, `blocks/data/rules.json`
- Test: `core/test/blocks/schema.test.ts`

**Interfaces:**
- Produces (`schema.ts`):
  - `TABLES: readonly SchemaName[]` (the 7 names above), `type SchemaName`
  - `FIELDS: Record<SchemaName, {name: string, type: 'String'|'Int', description: string}[]>`
  - `UNIQUE: Record<SchemaName, string[]>` (one single-field unique index per listed field)
  - `ACCESS: Record<SchemaName, Partial<Record<'read'|'insert'|'edit'|'delete', ('factory-owner'|'factory-core')[]>>>` (exactly the matrix above)
  - `collectionOf(s: SchemaName): string` (= `s + 's'`)
  - `generateRules(): object`, `generateFields(s): object`, `generateIndexes(): object[]`
- Produces (`blocks-resources.ts`): `npm run blocks:resources` writes the generated files; `--check` exits 1 if disk differs.

**Fields** (all tables also get the server's `ItemId`, `CreatedBy`, `CreatedDate`):
- FactoryTask: `taskId` (unique), `title`, `description`, `repo`, `baseBranch`, `status`, `stage`, `branch`, `prUrl`, `blockedReason`, `question`, `answer`, `gateOverrides` (JSON), `claimBy`, `claimUntil`, `costUsd` (decimal as text), `attempt` Int, `version` Int, `writeId`
- FactoryDoc: `docKey` (unique, `<taskId>:<kind>:<version>`), `taskId`, `kind`, `version` Int, `body`, `bodySha256`, `author`
- FactoryApproval: `approvalId` (unique), `taskId`, `gate`, `docVersion` Int, `decision`, `comment`, `at`
- FactorySettings: `scope` (unique: `global` or a repo id), `json` (the Settings or RepoSettings object), `version` Int, `writeId`
- FactoryRun: `runId` (unique), `taskId`, `step`, `mode`, `agent`, `startedAt`, `endedAt`, `result`, `turns` Int, `costUsd` (text), `version` Int, `writeId`
- FactoryEvent: `eventId` (unique, sha256 of the event's JSON), `taskId`, `actor`, `action`, `field`, `from`, `to`, `reason`, `at`
- FactorySpike: `spikeKey` (unique), `body`, `bodySha256`

**Rules shape** (port `tools/blocks-store/resources.ts` from ACR): for each table, a `security` entry per operation 0–3 with `accessLevel: 3`, `policyType: 0`, `fieldNames: []`; one allow policy per (operation, role) named `factory-<table-kebab>-<op>-<role>`, rule `{leftSource: 0, leftOperand: "Roles", operator: 6, rightSource: 2, staticValue: ["<role>"]}`; operations read 0, insert 1, edit 2, delete 3.

- [ ] **Step 1: Write the failing tests.**
  - `ACCESS` equals the matrix (a literal copy of the table in the test).
  - `generateRules()` has no delete policy for any `Factory*` table except `FactorySpike`, and every policy has `fieldNames: []`.
  - `generateIndexes()` contains `{schemaName: 'FactoryTask', fields: ['taskId'], name: 'factory_task_taskid_unique'}`, and the names follow `factory_<table>_<field>_unique`.
  - Running the tool with `--check` against the committed files exits 0.
- [ ] **Step 2: Run** `npx vitest run test/blocks/schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, run `npm run blocks:resources`, and commit the generated files.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** `feat(blocks): board tables, indexes and access rules as code`.

---

### Task 2: Compare-and-set settle logic

**Files:**
- Create: `core/src/blocks/update.ts` (port of ACR `packages/core/src/blocks-update.ts`)
- Test: `core/test/blocks/update.test.ts` (port of ACR `packages/core/test/blocks-update.test.ts`)

**Interfaces:**
- Produces:
  - `type WriteOutcome = {kind: 'applied'} | {kind: 'not-applied'} | {kind: 'unknown'}`
  - `classifyUpdate(r: {acknowledged?: boolean, totalImpactedData?: number} | Error): WriteOutcome`
  - `settleConditionalUpdate(p: {expectedVersion: number, send: (writeId: string) => Promise<WriteOutcome>, reread: () => Promise<{rows: {version: number, writeId: string|null}[]} | {error: 'denied'|'failed'}>, newWriteId?: () => string}): Promise<{kind: 'applied'} | {kind: 'conflict'} | {kind: 'unauthorized'} | {kind: 'reconcile', pendingWriteIds: string[]}>`

Algorithm: as in the research note §4 (up to two rounds; a stored `writeId` of ours means applied; a higher stored version means conflict; an equal version retries once; zero rows means unauthorized; anything else reconcile with pending write ids).

- [ ] **Step 1: Port the tests**, renaming to these names. Keep every ACR case.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Port the code.** It has no Blocks imports. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(blocks): compare-and-set settle logic ported from ACR`.

---

### Task 3: Blocks Data adapter and fake

**Files:**
- Create: `core/src/blocks/data.ts` (port of ACR `packages/claude-connector/src/blocks-data-sdk.ts`), `core/src/blocks/fakeData.ts`
- Test: `core/test/blocks/data.test.ts`, `core/test/blocks/fakeData.test.ts`

**Interfaces:**
- Consumes: `FIELDS`, `UNIQUE`, `ACCESS`, `collectionOf` (Task 1); `classifyUpdate` (Task 2).
- Produces:
  - `interface BlocksData`:
    - `list(schema: SchemaName, filter: Record<string, string|number>, fields?: string[]): Promise<Row[]>` (pages of 100 until `totalCount`; at most 100 pages, then throw)
    - `insert(schema, row: Record<string, string|number|null>): Promise<{kind: 'inserted', itemId: string} | {kind: 'duplicate'} | {kind: 'forbidden'}>`
    - `update(schema, filter: Record<string, string|number>, input: Record<string, string|number|null>): Promise<WriteOutcome | {kind: 'forbidden'}>`
    - `hardDelete(schema, itemId: string): Promise<void>` (used only for `FactorySpike`)
  - `type Row = Record<string, string|number|null>`
  - `class SdkBlocksData implements BlocksData`, built with `(p: {apiUrl: string, projectKey: string, token: TokenSource, timeoutMs?: number})`. It sends GraphQL through `@seliseblocks/client` (`client.data.graphql`) to `POST {apiUrl}/data/v4/gateway` with header `x-blocks-key: <projectKey>` and a Bearer token. On HTTP 401 it calls `token.invalidate()` and retries once. HTTP 403 → `forbidden`. The duplicate error text `A record with the same value for '<field>' already exists.` → `duplicate` (inserts only). Default timeout 30 s via `AbortSignal.timeout`.
  - `class FakeBlocksData implements BlocksData`, built with `(role: 'factory-owner'|'factory-core')`. It enforces `UNIQUE`, applies the `ACCESS` matrix (a missing permission → `forbidden`), matches filters by equality, assigns `ItemId`/`CreatedDate`, and has test hooks `failNextReply(op)` (apply the write, then throw) and `rows(schema)`.
- `TokenSource` is defined in Task 4; create `core/src/blocks/token.ts` here with only the interface `{get(): Promise<string>, invalidate(): void}` so this task compiles.

- [ ] **Step 1: Write the failing tests.**
  - `SdkBlocksData` with a stubbed `fetch`: the GraphQL operation names (`getFactoryTasks`, `insertFactoryTask`, `updateFactoryTask`), the `x-blocks-key` header, the filter sent as a JSON string, paging until `totalCount`, 401 → invalidate + one retry, 403 → `forbidden`, the duplicate text → `duplicate`, and a timeout.
  - `FakeBlocksData`: a duplicate unique value → `duplicate`; `factory-core` inserting into `FactoryApproval` → `forbidden`; `failNextReply('insert')` stores the row and then throws.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** Add `@seliseblocks/client@0.3.0` to dependencies. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(blocks): GraphQL data adapter and in-memory fake`.

---

### Task 4: Factory credential and token

**Files:**
- Create: `core/src/blocks/credential.ts`, extend `core/src/blocks/token.ts`, `core/tools/save-blocks-credential.ts`
- Test: `core/test/blocks/credential.test.ts`, `core/test/blocks/token.test.ts`

**Interfaces:**
- Consumes: `readSecret`, `ExecFile` (plan 1 `secrets.ts`).
- Produces:
  - `BlocksCredential {clientId: string, clientSecret: string, projectKey: string, apiUrl: string}`
  - `loadBlocksCredential(exec?: ExecFile): Promise<BlocksCredential>`. It reads `readSecret('blocks-credential')` and validates with zod. A bad shape throws `Error('blocks-credential in Keychain is not valid JSON {clientId, clientSecret, projectKey, apiUrl}')` and never includes the value.
  - `class ClientCredentialsToken implements TokenSource`, built with `(cred, mint?: (cred) => Promise<{accessToken: string, expiresIn: number}>)`. The default mint uses the SDK `client.auth.oidc.clientCredentials` (port ACR `agent-token.ts`, but **in memory only**, no cache file). It refreshes when fewer than 120 s are left, keeps one mint in flight, and `invalidate()` forces the next `get` to mint.
  - Tool `save-blocks-credential`: reads the JSON that `blocks auth client-credentials save --json` prints on stdin (port the field extraction from ACR `tools/blocks-probe/save-agent-credential.ts`). It takes `--project-key <tenantId>` and `--api-url <url>` flags, builds a `BlocksCredential` and stores it by spawning `security -i` and writing `add-generic-password -U -s the-software-factory -a blocks-credential -w '<json>'` to its **stdin** (single quotes in the JSON escaped). It prints only `saved blocks-credential (client <clientId>)`.
- [ ] **Step 1: Write the failing tests.**
  - `loadBlocksCredential` with a stub exec returning good JSON gives the object. Bad JSON throws the exact message, and the message doesn't contain the stub value.
  - The token refreshes at 119 s left and not at 121 s. Two concurrent `get()` calls mint once. `invalidate()` mints again.
  - The save tool with a stub spawner: the secret appears only in the stub's stdin, never in its argv or the tool's stdout.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement**, and add the script `"blocks:save-credential"`. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(blocks): factory credential from Keychain and client-credentials token`.

---

### Task 5: BlocksStore

**Files:**
- Create: `core/src/blocks/store.ts`
- Create: `core/test/storeContract.ts` (shared suite), modify `core/test/store.test.ts` to run it against `MemoryStore`
- Test: `core/test/blocks/store.test.ts` (runs the contract suite against `BlocksStore('owner')` on `FakeBlocksData('factory-owner')`, plus Blocks-specific tests)

**Interfaces:**
- Consumes: `BoardStore`, `VersionConflictError`, `NotFoundError` (plan 1 `store.ts`); `BlocksData` (Task 3); `settleConditionalUpdate` (Task 2); `DEFAULT_SETTINGS`.
- Produces:
  - `class BlocksStore implements BoardStore`, built with `(data: BlocksData, identity: 'core'|'owner')`
  - `OwnerOnlyError`; `DocTooLargeError`; `MAX_DOC_BYTES` (initially `262_144`, the size ACR proved; Task 8 updates it)
  - `CORE_TASK_FIELDS: readonly (keyof Task)[]` = `status, stage, branch, prUrl, attempt, blockedReason, question, answer, claimBy, claimUntil, costUsd`

**Mapping rules:**
- `createTask`, `addApproval`, `setSettings`: identity `owner` only; with `core` they throw `OwnerOnlyError('<method> is done on the Board, not by the factory core')` before any call.
  - `createTask`: next id = 1 + the highest `T-<n>` in `list`; on `duplicate`, re-read and retry up to 3 times.
- `updateTask(id, expectedVersion, patch)`:
  - With identity `core`, a patch key outside `CORE_TASK_FIELDS` throws `Error('factory core may not change <key>')`.
  - Otherwise, call `update(FactoryTask, {taskId: id, version: expectedVersion}, {...encoded patch, version: expectedVersion + 1, writeId})` through `settleConditionalUpdate`:
    - applied → return the re-read task;
    - conflict → `VersionConflictError`;
    - unauthorized → `NotFoundError`;
    - reconcile → `Error('task <id> update outcome unknown; re-read before retrying')`.
- `addDoc(taskId, kind, body, author)`:
  - A body over `MAX_DOC_BYTES` (UTF-8 bytes) throws `DocTooLargeError`.
  - Otherwise take the current max version. If that doc has the same `bodySha256` and author, return it (a retry after a lost reply). Else insert version + 1 with `docKey`; on `duplicate`, re-read and retry up to 3 times.
- `currentDoc`: `list(FactoryDoc, {taskId, kind}, ['version','docKey'])`, pick the highest version, then fetch that row with its body by `docKey`. The `Doc` returned has `status: 'current'`. There is no stored status: older versions count as superseded because a higher version exists.
- `startRun`: `runId = 'R-' + randomUUID()`. `finishRun` uses a compare-and-set update on the run's `version`.
- `addEvents`: each event gets `eventId = sha256(JSON of the event)`. A `duplicate` counts as written.
- `getSettings`: `global` comes from the `scope: 'global'` row's `json` (`DEFAULT_SETTINGS` when missing). `repos` come from the other rows.
- Encode and decode: `gateOverrides`, settings `json` as JSON text; `costUsd` as text (`String(n)` / `Number(s)`); `null` stays `null`; never send an `undefined` key.

- [ ] **Step 1: Extract the contract suite** from `core/test/store.test.ts` (everything that isn't FileStore-specific) into `storeContract.ts` as `runStoreContract(name, make: () => BoardStore)`. `store.test.ts` calls it for `MemoryStore`. Run it. Expected: PASS (no behaviour change).
- [ ] **Step 2: Write the failing Blocks tests.**
  - The contract suite on `BlocksStore('owner')`.
  - Core identity: `createTask`/`addApproval`/`setSettings` throw `OwnerOnlyError` without any data call. `updateTask(..., {title: 'x'})` throws `factory core may not change title`.
  - Lost reply (`failNextReply`): `addEvents` retried → one row; `addDoc` retried → one doc version.
  - A compare-and-set race between two `updateTask` calls → one success, one `VersionConflictError`.
  - A 262,145-byte body → `DocTooLargeError`.
- [ ] **Step 3: Run.** Expected: FAIL. **Step 4: Implement.** **Step 5: Run.** Expected: PASS. Then `npm test && npm run typecheck`.
- [ ] **Step 6: Commit** `feat(blocks): BlocksStore on Blocks Data`.

---

### Task 6: Wire `--store blocks`, and handle docs that are too large

**Files:**
- Modify: `core/src/wire.ts`, `core/src/cli.ts`, `core/src/engine.ts`
- Test: `core/test/cli.test.ts`, `core/test/engine.test.ts`

**Interfaces:**
- `wire({store: 'blocks'})` builds `new BlocksStore(new SdkBlocksData({...cred, token: new ClientCredentialsToken(cred)}), 'core')`, using `loadBlocksCredential()` lazily (on the first store call, like the GitHub client).
- Remove the `Blocks store is not built yet (plan 2)` exit. `dev` commands keep their `--store file` guard.
- `Engine.complete`: if `addDoc` throws `DocTooLargeError`, treat the result as `{status: 'failed', summary: 'invalid agent result: doc larger than <MAX_DOC_BYTES> bytes'}` and continue (the machine decides: blocked, or back to build for verify/review).

- [ ] **Step 1: Write the failing tests.**
  - A CLI `status --store blocks` with an injected `makeEngine` on `BlocksStore('core', FakeBlocksData('factory-core'))` exits 0.
  - The old exit-2 test is replaced.
  - `dev add --store blocks` still exits 1 with the guard message.
  - Engine: a spec agent returning a doc of `MAX_DOC_BYTES + 1` bytes → the task is `blocked` with `blockedReason` starting `invalid agent result: doc larger than`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. Then `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** `feat(core): factory --store blocks`.

---

### Task 7 (USER): Create the Blocks project and its resources

The executor prints this block for the user, waits for each result, and records the outputs (project tenant id, schema ids, client id; **never** the secret) in the ledger.

```bash
export BLOCKS_STRICT_FLAGS=1
cd ~/scratchpad/selise/the-software-factory
blocks projects create the-software-factory --dry-run      # then --yes
blocks use <tenantId>                                       # pins blocks.json
blocks init                                                 # never overwrites; keeps our blocks/data files
blocks iam roles create --name "Factory Core" --slug factory-core --description "Factory core machine identity" --dry-run   # then --yes
blocks iam roles create --name "Factory Owner" --slug factory-owner --description "The factory's single user" --dry-run    # then --yes
# per table, for S in FactoryTask FactoryDoc FactoryApproval FactorySettings FactoryRun FactoryEvent FactorySpike:
blocks data schema info save --schema-name $S --collection-name ${S}s --schema-type 1 --dry-run   # then --yes; note the schema id
blocks data schema fields --schema-id <id> --file blocks/data/factory/$S.fields.json --dry-run    # then --yes
# per entry in blocks/data/factory/indexes.json:
blocks data schema indexes create --schema-id <id> --fields <field> --unique --name <name> --dry-run   # then --yes
blocks data validate
blocks data rules deploy --dry-run      # then --yes
blocks data reload --dry-run            # then --yes
blocks data schema aggregation --schema-name FactoryApproval   # read-back: access level Custom on every operation
# give your own account the owner role (create it if it isn't a project user yet):
blocks iam users list --json            # find your user id
blocks iam users update-access <userId> --roles factory-owner --dry-run   # then --yes
# machine client; the secret goes straight into the Keychain:
blocks auth client-credentials save --name factory-core --roles factory-core --access-token-valid-minutes 15 --yes --json \
  | (cd core && npm run -s blocks:save-credential -- --project-key <tenantId> --api-url https://api.seliseblocks.com)
```

- The commands follow what ACR ran on CLI 0.11.0. If a flag is refused, check `blocks <command> --help` and adjust before running with `--yes`. `iam users update-access` in particular was not in ACR's exact notes.
- [ ] **Step 1:** The user runs the block. Rules deploy happens right after the schemas are created, so the tables are open to signed-in users only for a few minutes.
- [ ] **Step 2:** The read-back shows Custom access on every operation of every table, and `save-blocks-credential` printed `saved blocks-credential (client …)`.
- [ ] **Step 3: Commit** `blocks.json` (the tenant id is not a secret) with `chore(blocks): pin the factory project`.

---

### Task 8 (USER-run script): Doc size spike

**Files:**
- Create: `core/tools/spike-doc-size.ts` (`npm run blocks:spike-doc-size -- --confirm-synthetic-writes`)
- Modify: `core/src/blocks/store.ts` (`MAX_DOC_BYTES`), `docs/superpowers/specs/2026-11-09-software-factory-design.md` §12.1

**Behaviour:** as `factory-core`, for sizes 256 KiB, 1 MiB, 4 MiB and 8 MiB:
1. Insert a markdown body of that many UTF-8 bytes (mixed ASCII and multi-byte characters) into `FactorySpike` with `spikeKey = spike-<size>-<uuid>`.
2. Read it back and compare `sha256`.
3. Hard-delete it.
4. Print one line per size: `256KiB ok` / `1MiB failed: <first line of error>`.

It refuses to run without `--confirm-synthetic-writes`, and it stops at the first failure.

- [ ] **Step 1:** The agent writes the script with a unit test against `FakeBlocksData('factory-core')`, then commits.
- [ ] **Step 2 (USER):** run `cd core && npm run -s blocks:spike-doc-size -- --confirm-synthetic-writes` and paste the output.
- [ ] **Step 3:** Set `MAX_DOC_BYTES` to the largest size that round-tripped (at most 4 MiB, so reads stay quick). Update spec §12.1 with the measured result. Commit `chore(blocks): doc size limit from the spike`.

---

### Task 9 (USER-run script): Live gate

**Files:**
- Create: `core/tools/gate-blocks.ts` (`npm run blocks:gate -- --confirm-synthetic-writes`), porting the structure of ACR `tools/blocks-store/run-gate-roles.ts` and `run-race.ts`

**Behaviour:**
- Owner login: hidden password prompt for the user's email (SDK `auth.login`; the password is never stored or printed). If the account can't sign in with a password (for example SSO only), the user creates a synthetic owner user with role `factory-owner` for the gate and deactivates it afterwards, as ACR did.
- The gate inserts its `FactoryTask` row directly through the owner's `BlocksData`, with `taskId: GATE-<uuid8>`, so it never takes a `T-<n>` number.
- Core identity from the Keychain credential.
- Steps (each prints a label and `pass`/`FAIL`, no data values):
  1. Owner creates task `GATE-<uuid8>` (status `inbox`), and core reads it.
  2. Core insert into `FactoryTask` → forbidden.
  3. Core insert into `FactoryApproval` → forbidden. Owner insert → ok.
  4. Core edit of `FactorySettings` → forbidden. Owner insert and edit → ok.
  5. Core insert into `FactoryEvent` → ok. Core edit of an event → forbidden. Owner edit → forbidden.
  6. Owner insert into `FactoryDoc` → forbidden. Core insert → ok.
  7. A compare-and-set race: two concurrent core `updateTask` calls on the same version → exactly one success and one `VersionConflictError`.
  8. A delete on `FactoryTask` by core and by owner → forbidden.
  9. `factory --store blocks status --json` (run by the script as a child process) lists the gate task.
  10. Owner cancels the gate task.
- Exit 0 only if every step passes.

- [ ] **Step 1:** The agent writes the script (unit test of the step runner with fakes) and commits it.
- [ ] **Step 2 (USER):** run it and paste the output.
- [ ] **Step 3:** Record the result in the vault overview. On any `FAIL`, stop and fix the rules or the code before Task 10.

---

### Task 10 (optional): Column write rule for core task edits

**Goal:** make Blocks itself refuse a core edit of `title`, `description`, `repo`, `baseBranch` or `gateOverrides`, as spec §4 says.

- [ ] **Step 1:** Read the local blocks-data source, read-only (`~/scratchpad/selise/blocks/blocks-data`, `ClsWriteGuard` and the policy DTOs), to find the rules.json shape for a column write rule on EDIT. Write the finding with file:line evidence into `docs/research/2026-11-09-blocks-data-from-acr.md` under a new section.
- [ ] **Step 2:** If a shape exists, extend `generateRules()` (Task 1) behind a test, regenerate, and give the user `blocks data rules deploy --dry-run` / `--yes` and `blocks data reload`. Extend the gate with step 11: core edit of `title` → refused. **USER** runs it.
- [ ] **Step 3:** If no shape exists or the gate fails, revert, keep the code-level guard from Task 5, and change spec §4's Task row to say the core's field limit is enforced in code. Commit either way.
