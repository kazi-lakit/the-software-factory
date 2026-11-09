# Blocks Data mechanics proven by ACR (for the software factory plan)

Date: 2026-11-09. Read-only research. No secrets read; no Blocks/GitHub calls made.
Paths: `R` = `~/scratchpad/selise/build-with-blocks/agent-control-room`, `V` = `~/scratchpad/selise/vaultS`.
Observed on CLI 0.11.0 and SDK `@seliseblocks/client` 0.3.0 (R/node_modules/@seliseblocks/client/package.json), dev project, 5-6 Nov 2026. ACR notes say behaviour is "not established as universal" (V/knowledge/blocks-functions-token-handoff.md:3).

## 1. Project and setup (human steps vs scripts)

Every mutating CLI step was shown as `--dry-run` first, run with `--yes` after approval (R/docs/superpowers/plans/2026-11-05-acr-blocks-store.md:494-495 "Show every mutating command as a dry run first"). Env: `BLOCKS_STRICT_FLAGS=1`; `$CTX` = `--account default --project <tenantId>` (R/docs/integration/blocks-capabilities.md:27-30). Project tenantId lives in `R/blocks.json:3`.

Human steps, in order (all CLI, no console clicks except the one noted):
1. Project: ACR reused an existing dev project (`D027bd41...`, V/projects/agent-control-room/agent-control-room-overview.md:4). Project creation not documented by ACR: not found. Select it with `blocks auth status` (R/blocks/functions/acr-connection-key/README.md:7).
2. Roles: `blocks iam roles create --name "ACR Member" --slug acr-member ...` (store plan:497); agent role `blocks iam roles create --name "ACR Agent" --slug acr-agent --description "ACR agent machine identity" --dry-run` then `--yes` (R/docs/superpowers/plans/2026-11-05-acr-connector-auth.md:156); admin role same pattern, `--slug acr-admin`, plus `blocks iam permissions list --search user` and `blocks iam roles assign-permissions acr-admin --add-permissions <perm> --yes` (R/blocks/functions/acr-connection-key/README.md:14-26).
3. Schemas (per table; plan:497-500): `blocks data schema info save --schema-name <S> --collection-name <S>s --schema-type 1` (capabilities:38-42), then `blocks data schema fields --schema-id <id> --file blocks/data/acr/<S>.fields.json`, then per index `blocks data schema indexes create --schema-id <id> --fields <f> --unique --name <n>`. Later tables used `blocks data schema push` + `indexes.json` (R/docs/superpowers/plans/2026-11-08-acr-connection-requests.md:251). Read-back: `blocks data schema aggregation --schema-name <S>` (access level per operation), `schema indexes list <id>`, `rules policy get <S>`.
4. Rules: `blocks data validate` (checks rules.json only, `schemaCount: 0`; capabilities:114), `blocks data rules deploy --dry-run` then `--yes`, then `blocks data reload --dry-run/--yes` (R/docs/plugin-guide.md:35-43). Live result: 55 writes, reload "version 36" (plan:~516-518).
5. Machine client: `BLOCKS_STRICT_FLAGS=1 blocks auth client-credentials save --name acr-agent --roles acr-agent --access-token-valid-minutes 15 $CTX --yes --json | npm run -s proof:agent-credential` (plan:528; spec connector-auth:92). Secret shown once; the pipe writes `~/.config/acr/agent.json` mode 0600 in a 0700 dir (R/tools/blocks-probe/save-agent-credential.ts:1,28-45). Expected shape (documented, file not opened): `{ clientId, clientSecret, projectKey, apiUrl }` (R/packages/claude-connector/src/agent-credentials.ts:8,17-22). `clientId` is the credential's `itemId`; `apiUrl` was `https://api.seliseblocks.com` (save-agent-credential.ts, last block).
6. Users: `blocks iam users create --email ... --roles acr-member,acr-approver --dry-run` (no `--password` on mail activation); user types password in own terminal `read -s PW; blocks iam users create ... --password "$PW" --yes` (R/docs/superpowers/plans/2026-11-06-acr-human-ui.md:187-190). Activation email links pointed at an undeployed domain, so `blocks iam users activate <id> --reason "..."` was used (human-ui spec:64; plan:189). Role grant to an existing user: `iam users update-access` (store plan:L3 line ~540).
7. Hosted login (human UI): see section 5.
8. Seeding config rows: CLI 0.11.0 has no data-row insert command (capabilities:115). Workaround: a temporary role-insert policy for `acr-agent` on the config table in a scratch folder (own `blocks.json` + `blocks/data/rules.json`), `rules deploy`, `reload`, insert as agent through the SDK adapter, then `blocks data rules policy delete <policyId> --yes` (store plan:119-121; R/docs/superpowers/specs/2026-11-08-acr-board-loop-design.md:36-38; R/blocks/policies/test-cleanup/). A permanent switch-on/off variant lives in `blocks/policies/workflow-insert/` (board-loop plan:40).

Scripted by ACR (all in repo):
- `tools/blocks-store/resources.ts` (`npm run blocks:resources`) generates `blocks/data/rules.json` + field/index files from the TS tables `ACR_FIELDS/ACR_UNIQUE/ACR_ACCESS` (R/packages/core/src/blocks-data.ts:13-32; R/package.json:23). A test asserts disk matches generated output (plan:~440).
- Gate runners: `tools/blocks-store/run-gate-roles.ts` (role matrix, 15 steps), `run-race.ts` (CAS race), `run-e2e.ts`, `run-inspect.ts`, `run-cleanup-*.ts` (package.json:24-31). All refuse to run without `--confirm-synthetic-writes` (plan:~478).
- Nothing creates the project, roles, client or users by script; those are manual CLI commands above.

## 2. Schema definition

- Fields file per table: `blocks/data/acr/<Schema>.fields.json` = `{ "fields": [ { "name", "type", "isArray": false, "description" } ] }` (R/blocks/data/acr/AcrWorkflowState.fields.json:1-28). Types used: `String`, `Int` only (R/packages/core/src/blocks-data.ts:11). JSON/markdown is stored as a `String` field (spec store-design:109; `state` and `review` are JSON text).
- Indexes: single file `blocks/data/acr/indexes.json` = array of `{ "schemaName", "fields": [..], "name" }`, each created with `--unique` (R/blocks/data/acr/indexes.json:1-65). Naming: `acr_<table>_<field>_unique`. ACR uses one single-field unique index per key; composite `(CreatedBy, key)` indexes were proven in gate D but not used in production (capabilities:19).
- Naming: PascalCase singular schema `AcrReview`, collection = schema + `s` (`AcrReplys`, `AcrWorkflowStates`) (store-design:109; capabilities:116). GraphQL names are plain concatenation: `get<Collection>`, `insert<Schema>`, `update<Schema>`, `delete<Schema>`.
- System fields always present: `ItemId`, `CreatedBy`, `CreatedDate`, `LastUpdatedBy`, `OrganizationId`, `Tags`, `Language` (owner-isolation plan:21; read in adapter R/packages/claude-connector/src/blocks-data-sdk.ts:62).
- Deployment: schema info/fields/indexes via CLI (section 1.3); each call "returned successful gateway reloads", no extra reload needed (capabilities:55); `rules deploy` + `data reload` for policies.
- Gotcha: a new schema starts with **User** access (any signed-in project user) until `rules deploy` makes it Custom, so it is briefly open (capabilities:111).
- Gotcha: ItemId in a policy rule matches nothing (Mongo stores `_id`); write rules on other fields (V/projects/blocks-data/DATA_ACCESS_README.md:570-571).

## 3. Data API used by the store

- Transport: **GraphQL**, not REST. SDK call `client.data.graphql({ operationName, query, variables })` (R/packages/claude-connector/src/blocks-data-sdk.ts:37). Endpoint `POST {apiUrl}/data/v4/gateway` (SDK dist/data/data-client.js: `DATA_API="/data/v4"`, route `/data/v4/gateway`). Base `apiUrl` for the dev project: `https://api.seliseblocks.com`; the web app's own domain derives `https://blocksapi.slsblx.com` (capabilities:141). (Handoff for the REST migration is a separate effort; ACR does not use REST.)
- Headers: `x-blocks-key: <tenantId>` (SDK option `xBlocksKey`; never put the key in body/query: client README:36) and `Authorization: Bearer <accessToken>` (SDK `accessToken` resolver). Client built per attempt so a retry after 401 sends the new token (sdk.ts:34-35).
- Read: `query get<Coll>($input: DynamicQueryInput) { get<Coll>(input:$input){ items{ItemId CreatedBy CreatedDate ...fields} totalCount } }` with `input: { filter: JSON.stringify({field:value}), pageNo, pageSize }`; pageNo is 1-based; loop until `rows >= totalCount` or empty page; ACR caps at 100 pages x 100 (sdk.ts:9,28,64-78). Filter is a Mongo-style JSON string.
- Typed filter/sort/page (verified live 6 Nov): `get<Coll>(where: <Schema>FilterInput, order: [DynamicSortInput!], paging: PaginationInput)`; `where: { and:[ {field:{eq:v}}, {CreatedDate:{gte:iso}} ] }`; `order: [{ field:"CreatedDate", direction:"ASC" }]` (one list item, per-field objects rejected); `paging:{pageNo,pageSize}`. String ops: eq/neq/contains/startsWith/endsWith/in (no gt/lt); DateTime ops: eq/neq/gt/gte/lt/lte/in (R/docs/superpowers/specs/2026-11-06-acr-state-compaction-design.md:36-62; capabilities:123; sdk.ts:65-69).
- Insert: `mutation insert<Schema>($input: <Schema>InsertInput!){ insert<Schema>(input:$input){ acknowledged itemId totalImpactedData } }` (sdk.ts:82). Optional columns unset come back `null`; never send undefined keys (blocks-data.ts:53-54).
- Update: `mutation update<Schema>($filter: String, $input: <Schema>UpdateInput!){ update<Schema>(filter:$filter, input:$input){ acknowledged itemId totalImpactedData message } }` with `filter: JSON.stringify({...})` (sdk.ts:89). Partial input, only listed fields change.
- Delete: `delete<Schema>(filter, input:{isHardDelete:true})` with filter `{ItemId}`; hard delete only for test cleanup, no deployed policy allows delete (sdk.ts:93-103; blocks-data.ts:45).
- Duplicate: GraphQL error text "A record with the same value for '<field>' already exists." (regex sdk.ts:11); treat as `duplicate` for inserts only.
- ItemId: server-generated string id returned as `itemId` on insert; settable on insert only (WritableFields: `OrganizationId`, `Tags`, `Language`, `ItemId`) (owner-isolation plan:16). ACR does not rely on it; it uses its own unique business keys (`workflowId`, `reviewKey`, `replyId`).
- `CreatedBy`/`CreatedDate`: stamped by gateway, not settable on insert, not changeable on update (plan:16,25). `CreatedBy` is the user's id for user tokens and **empty for machine clients** (capabilities:94,122). `CreatedDate` is server time (ISO); ACR uses it for read windows with a 10-minute overlap (human-window.ts:1-9). Version: no built-in row version; ACR adds its own `revision` Int field.
- Collections used by ACR for config rows: none need `ItemId`; rows looked up by unique business key.

## 4. Conditional (compare-and-set) updates

- Mechanism: **expected-version filter** on the update. Row has `revision` (Int) and `writeId` (String). Update filter `{ workflowId, revision: R }`, input `{ revision: R+1, writeId: <fresh uuid>, state }` (R/packages/core/src/blocks-store.ts:126-129). First write for a key is an `insert` guarded by the unique index (blocks-store.ts:118-124).
- Server answers (observed): applied = `acknowledged:true, totalImpactedData:1`; non-match = `acknowledged:false, totalImpactedData:0` (message "No data found to UPDATE or you don't have permission..."). The same non-match answer also covers a permission denial that is a row-filter denial, so a re-read is needed to tell "lost race" from "not yours" (capabilities:18; blocks-update.ts:3-8). Role-denied updates (Custom role rule) give **HTTP 403** instead (capabilities:117). Concurrent race: exactly one `1`, the other `0` (gate 5, store-design:126).
- Classification (R/packages/core/src/blocks-update.ts:17-22): `applied` iff `acknowledged===true && total===1`; `not-applied` iff total===0 (either acknowledged value); anything else (GraphQL error, HTTP error, transport error) = `unknown`. The Blocks message text is never used as a signal.
- Algorithm `settleConditionalUpdate` (blocks-update.ts:46-74): up to 2 rounds (first try, one retry). Each round: new `writeId`, send update, classify. `applied` -> success. Otherwise re-read the row (`version`,`writeId`) and `reconcileUpdate` (25-37):
  - re-read denied/GraphQL error -> UNAUTHORIZED; other non-rows -> RECONCILE_REQUIRED
  - 0 rows -> UNAUTHORIZED (`not_found_or_forbidden`); >1 rows -> RECONCILE_REQUIRED
  - stored `writeId` is one of ours (any attempt) -> applied (lost ack recovered)
  - stored version > expected -> CONFLICT (someone else won; caller reloads and reruns)
  - stored version == expected -> retry once (fresh writeId) if first round, else RECONCILE_REQUIRED
  - version < expected or non-number -> RECONCILE_REQUIRED
  - writeIds whose answer was `unknown` are returned as `pendingWriteIds` on RECONCILE_REQUIRED (a lost write may still land later; while version is unmoved at most one can).
- Caller loop (`transact`, blocks-store.ts:70-135): snapshot (read state row + human rows) -> run pure op on in-memory copy -> insert queued immutable records first (duplicate = already written) -> CAS-update state row. CONFLICT/duplicate -> reload and rerun, `maxAttempts = 3` (line 46). `pendingWriteIds` are remembered for that call: next snapshot whose `writeId` matches means "earlier commit landed" (lines 71-76, 133). Unreadable state row is never overwritten (line ~62).
- Design consequence worth copying: one small state doc per aggregate with `revision` CAS; immutable history/records in separate insert-only tables with unique keys.

## 5. Access control and identities

- Every table: `security` entry for operations 0-3 with `accessLevel: 3` (Custom), `policyType: 0`, `fieldNames: []`; then one allow policy per (operation, role). Delete gets a security entry but no policy, so nobody can delete (R/tools/blocks-store/resources.ts:51-58; R/blocks/data/rules.json:60-86).
- Numeric enums (V/projects/agent-control-room/acr-owner-isolation.md:15): policyType RLS=0; operation READ=0, WRITE(insert)=1, EDIT=2, DELETE=3; accessLevel User=1(Custom=3 observed in rules.json); rule `leftSource` AUTH=0, SCHEMA_FIELD=1, STATIC_VALUE=2; operator EQUAL=0, CONTAIN=6.
- Policy shape (resources.ts:34-46; rules.json "policies" entries):
```json
{ "schemaName":"AcrApproval","policyName":"acr-approval-insert-acr-approver","policyDescription":"...",
  "policyType":0,"operation":1,"fieldNames":[],"priority":0,"isAllowPolicy":true,
  "ruleGroup":{"logicalOperator":0,"nestedGroups":[],"rules":[
    {"leftSource":0,"leftOperand":"Roles","operator":6,"rightSource":2,"staticValue":["acr-approver"]}]}}
```
  Several allow policies on one operation OR together (connector-auth spec:102). Owner-scoped variant: `{leftSource:1,leftOperand:"CreatedBy",operator:0,rightSource:0,rightOperand:"UserId"}` (resources.ts:49).
- `fieldNames` MUST be `[]` for row-level rules, otherwise 400 `FIELD_NAMES_ARE_NOT_ALLOWED_FOR_ROW_LEVEL_SECURITY` after access has already flipped to Custom (everyone denied) (V/knowledge/blocks-functions-token-handoff.md:14).
- "Agent can read approvals but not insert": read policies for `acr-agent` and `acr-member`; insert policy only for `acr-approver` -> agent insert gets HTTP 403 (live: capabilities:91, store-design:122). Matrix source of truth `ACR_ACCESS` (R/packages/core/src/blocks-data.ts:23-32): state (insert/edit agent), review/activity (insert agent, edit none), reply (insert member), approval (insert approver). "Insert-only history" = insert policy for one role, no edit policy, no delete policy.
- Authorship: human rows' author = `CreatedBy` (unforgeable); agent code re-validates every human row, rejecting empty `CreatedBy` (blocks-data.ts:83; blocks-store.ts humanRow).
- Machine token: `POST /iam/v4/oidc/token`, grant `client_credentials`, via SDK `client.auth.oidc.clientCredentials({ clientId, clientSecret })` with `xBlocksKey`. Response camelCase `{ accessToken, tokenType, expiresIn, expiresUtc }`; OAuth `client_id` = credential `itemId` (capabilities:89; agent-token.ts:24-39). Scopes: none passed anywhere (not found). Claims: `roles` includes `acr-agent`, `client_id`, `sub`, `tenant_id`, `org_id`, no `user_id` (capabilities:90). Token life 15 min (set at client creation).
- Token source (portable): cache file 0600 with `{accessToken, expiresAt, clientId}`; refresh when < 120 s left; one in-flight mint; `invalidate()` after a 401 bumps a generation and overwrites the cache; one retry on 401 then fail closed (R/packages/claude-connector/src/agent-token.ts:11-70; sdk.ts:47-50). Credential file loader rejects symlink, group/world-readable, inside a git tree, bad shape (agent-credentials.ts:36-50).
- Function caveat: a Token function triggered by a machine client gets no caller token (`ctx.blocks.getAccessToken()` empty), so ACR chose direct Data access from the agent (connector-auth spec:44-57). Draft-function tests run as an impersonation JWT that project IAM rejects (token-handoff note:7-9).
- Human UI hosted login (public PKCE client): generated by `blocks new web` (React 18, Vite, TanStack Query) (human-ui spec:38). OIDC client created with `blocks auth oidc-clients save --display-name ... --redirect-uris "https://<app-domain>:5173/login/callback" --register-as-identity-provider` (human-ui plan:183); public, `tokenEndpointAuthMethod: none`, PKCE, client id/provider id in capabilities:142. **Scope gotcha:** created with `offline_access` only, hosted login failed "scope must include 'openid'"; fix `oidc-clients save --item-id ... --allowed-scopes openid,profile,offline_access --scope "openid profile offline_access"` and `blocks auth idp update ... --scope ...` (capabilities:143). `blocks new web --client-id` flips `isOidcEnabled` true and changes activation paths (capabilities:144). Web env: `VITE_BLOCKS_API_URL`, `VITE_BLOCKS_X_BLOCKS_KEY` (also the OIDC `tenant_id`), `VITE_BLOCKS_APP_DOMAIN`, `VITE_BLOCKS_OIDC_URL`, `VITE_BLOCKS_OIDC_CLIENT_ID`, `VITE_BLOCKS_OIDC_SCOPE` (R/apps/web/.env.example; R/apps/web/src/lib/blocks/config.ts:1-14). Client: `createBlocksClient({accessToken, apiUrl, appDomain, onUnauthorized, oidc:{clientId,scope,url}, xBlocksKey})` (apps/web/src/lib/blocks/client.ts). Roles for UI come from `blocksClient.iam.me()` at `data.roles` (capabilities:144). Session cookie is httpOnly (`useTokensCookie: true`), access cookie 15 min; the scaffold never renews, so ACR added renewal: `POST /iam/v4/oidc/token` `grant_type=refresh_token` + `client_id`, no body token, `credentials:"include"`, every 5 min and once before treating `auth/me` failure as signed out (V/knowledge/blocks-hosted-login-session-renewal.md:3-8; R/apps/web/src/lib/blocks/auth.ts `renewSession`). Remaining limits: refresh 30 min sliding, absolute 300 min (read via `blocks auth config get`).
- Human writes use the user's token against the same Data endpoint under the same role rules (store-design:52-55). Password-grant login for synthetic users also works (`createBlocksClient(...).auth.login({username,password})`, R/tools/blocks-probe/user-path.ts:53); user types passwords themselves (user-path plan:33).

## 6. Limits and gotchas

- Field size: a 256 KB `String` round-trips unchanged (gate 1; store-design:94; capabilities:119). No server maximum found; ACR self-limits state docs to `MAX_STATE_BYTES = 1_000_000` (blocks-store.ts:10). For markdown specs/plans, 256 KB per field is proven; larger is untested ("not found").
- Unbounded growth is the main risk: a state doc that accumulates all items outgrew 1 MB within weeks at ~100 cards/day; ACR added compaction + CreatedDate read windows (store-design:95-99; compaction spec). Lesson: keep per-aggregate docs small, history in insert-only rows.
- Paging: `pageNo`/`pageSize` returned every row at page size 2; typed `paging` combined with `where`/`order` works (capabilities:120,123). No documented max pageSize; ACR uses 100.
- Server time: `CreatedDate` is server-stamped; read windows use a 10-minute overlap to absorb skew/visibility lag (human-window.ts:1; compaction spec:22,95).
- Rate limits: none found for Data. Function draft tests have a 60 s cooldown / `FUNCTION_RATE_LIMITED` (token-handoff note:8).
- HTML instead of JSON: `blocks data config get` returned HTML for `/data/v4/configurations` (capabilities:13,56). It was a CLI/endpoint oddity, not a sign storage was absent. Scaffold/app routes returning HTML for unknown paths: not documented.
- 401/403/404 quirks: 401 -> invalidate token once and retry; role-denied insert/update -> 403; row-filter denial and filter non-match -> `acknowledged:false,0`; missing row and someone else's row look identical under owner policies; a duplicate leaks key existence if the unique index is not owner-scoped (acr-owner-isolation note:13).
- `rules deploy` matches policies by name and updates in place; policies removed from the file persist until `rules policy delete <id>` (capabilities:112). `rules policy get <id>` returned `[]` and `rules pull` omitted a live temporary policy; only the delete's `totalImpactedData:1` proved existence (capabilities:113). A half-failed deploy can leave access Custom with no rules.
- `data validate` does not read field or index files (capabilities:114). No CLI command inserts data rows (capabilities:115). SDK client has no timeout; ACR wraps fetch with `AbortSignal.timeout` (sdk.ts:20-25).
- Soft vs hard delete: default delete is soft and keeps unique values, blocking re-runs; hard delete needed for cleanup (sdk.ts:97). Synthetic gate rows could not be deleted by roles (capabilities:107).
- Kaniko deploy race: Blocks Release deploys can fail with a `COPY . .` race on `node_modules`; a retry works (V/projects/agent-control-room/agent-control-room-overview.md:44). Deploy: Blocks Release, env `dev` from branch `dev`, root Dockerfile (overview:41).
- Function variable `{{secret.<id>}}` resolves as the caller; only roles on the secret's read list resolve it (V/knowledge/blocks-functions-token-handoff.md:20-ish; R/blocks/functions/acr-connection-key/README.md:6).
- Agent file reads: the model can read the credential file via shell; accepted because the agent role cannot write human tables (connector-auth spec:82).
- Not found: Data API per-request size cap, max document size, GraphQL query depth/complexity limits, Data rate limits, project-creation steps.

## 7. Generic code to port (not import)

| ACR file | What it does |
|---|---|
| `packages/core/src/blocks-update.ts` | Pure CAS settle/reconcile (classify, re-read, writeId tracking, pendingWriteIds). Zero Blocks imports; port verbatim with its test `packages/core/test/blocks-update.test.ts`. |
| `packages/claude-connector/src/blocks-data-sdk.ts` | `BlocksData` port over the SDK: `list` (paged, DynamicQueryInput and typed where/order/paging), `insert`, `update` (JSON-string filter), hard `delete`, duplicate detection, 401 invalidate-and-retry, `withTimeout`. Outcome kinds carry no messages. |
| `packages/core/src/blocks-data.ts` (lines 1-60 only) | Pattern: TS tables of fields/unique keys/access feeding generators; encode/decode helpers (`compact`, `parseJson`, null handling). Domain encode/decode functions are ACR-specific. |
| `packages/core/src/blocks-store.ts` | The `transact(key, op)` loop (snapshot, pure op, insert-once records, CAS state, 3 attempts, pending writeIds, size cap). Port the skeleton; replace the ACR state tables. |
| `tools/blocks-store/resources.ts` | Generates `rules.json` (security + role policies, delete denied), field files and indexes from TS tables; idempotent, preserves unrelated entries. Port and rename `Acr` prefix. |
| `packages/claude-connector/src/agent-token.ts` | Machine-token source: client-credentials mint via SDK, 0600 cache, refresh window, single-flight, invalidate-after-401. |
| `packages/claude-connector/src/agent-credentials.ts`, `private-file.ts` | Credential file loader with permission/symlink/git-tree checks and strict zod shape; `writePrivateFile`. |
| `tools/blocks-probe/save-agent-credential.ts` | Pipe target that writes the client secret straight to a 0600 file without printing it. |
| `tools/blocks-store/gate-roles.ts`, `race.ts` | Live role-matrix and CAS-race verification with evidence that holds labels only; refuse without `--confirm-synthetic-writes`. |
| `packages/core/src/human-window.ts`, compaction | CreatedDate read window with overlap; only if the factory has unbounded human-row tables. |
| `apps/web/src/lib/blocks/{config,client,auth,jwt}.ts`, `apps/web/blocks/*` | Scaffold client config, hosted-login + cookie-renewal fix, IaC folder layout (`blocks/{data,iam,auth,logic,...}`) as generated by `blocks new web`. |
| `blocks/policies/*` pattern | Separate Blocks project folder holding one temporary/optional policy so main `rules.json` redeploys never enable it by accident. |
| ACR-specific, do not port | coordination.ts, approval.ts, sessions.ts, sync.ts, pending.ts, compaction.ts domain logic; connection-key sealing function; plugin/connector MCP server; GitHub posting. |

## Open questions for the factory plan (not answered by ACR)
- Does the factory need REST? ACR is GraphQL-only; check the data-gateway REST rulings in memory before choosing.
- Project reuse vs new project: ACR docs do not cover project creation.
- Storage of markdown >256 KB: untested.
