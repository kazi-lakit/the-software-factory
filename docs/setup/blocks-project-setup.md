# Blocks project setup (plan 2, Task 7)

Run these yourself in a terminal on the Mac, signed in to the Blocks CLI with your own account. Each mutating command runs as `--dry-run` first. Check the output, then run the same command with `--yes` instead.

```bash
export BLOCKS_STRICT_FLAGS=1
cd ~/scratchpad/selise/the-software-factory
blocks auth status        # if the account tokens say "missing": blocks login   (device-code sign-in in the browser)
```

## 1. Project

```bash
blocks projects create the-software-factory --dry-run
blocks projects create the-software-factory --yes          # prints the tenantId
blocks use <tenantId>                                       # writes blocks.json here
blocks init                                                 # adds missing workspace files; never overwrites blocks/data/*
```

## 2. Roles

```bash
blocks iam roles create --name "Factory Core" --slug factory-core --description "Factory core machine identity" --dry-run
blocks iam roles create --name "Factory Owner" --slug factory-owner --description "The factory's single user" --dry-run
```

## 3. Tables, fields, indexes

There are 12 tables: `FactoryTask`, `FactoryDoc`, `FactoryApproval`, `FactorySettings`, `FactoryRun`, `FactoryEvent`, `FactorySpike`; (plan 6, multiple factories) `FactoryDef`, `FactoryRepo` and `FactoryHealth`; and (stage 4, GitHub connected mode) `FactoryGitHubLink` and `FactorySyncRequest`. Each table's fields are in `blocks/data/factory/<Table>.fields.json` and its unique index is in `blocks/data/factory/indexes.json`. The core generates these files; `cd core && npm run -s blocks:resources -- --check` confirms they are current.

**Warning:** a new table is open to any signed-in project user until step 4 deploys its rules. `FactoryRepo.checks` holds shell commands that the core runs on the owner's Mac. Run step 4 in the same sitting, straight after this step, before anything else touches the project.

A project set up from scratch creates all 12 tables. For each table, create its schema, its fields and its unique index from the table below. A project set up before plan 6 creates `FactoryDef`, `FactoryRepo` and `FactoryHealth` here (its other 7 tables already exist, see "Existing tables" below) and then does step 8 for the two stage 4 tables. A project set up after plan 6 but before stage 4 does only step 8.

For each new table, create the schema, then its fields:

```bash
S=FactoryTask     # repeat for each of the 12 tables: FactoryTask, FactoryDoc, FactoryApproval, FactorySettings, FactoryRun, FactoryEvent, FactorySpike, FactoryDef, FactoryRepo, FactoryHealth, FactoryGitHubLink, FactorySyncRequest
blocks data schema info save --schema-name $S --collection-name ${S}s --schema-type 1 --dry-run   # then --yes; note the schema id it prints
blocks data schema fields --schema-id <id> --file blocks/data/factory/$S.fields.json --dry-run    # then --yes
```

Each table has one unique index:

| Table | Field | Index name |
|---|---|---|
| FactoryTask | taskId | factory_task_taskid_unique |
| FactoryDoc | docKey | factory_doc_dockey_unique |
| FactoryApproval | approvalId | factory_approval_approvalid_unique |
| FactorySettings | scope | factory_settings_scope_unique |
| FactoryRun | runId | factory_run_runid_unique |
| FactoryEvent | eventId | factory_event_eventid_unique |
| FactorySpike | spikeKey | factory_spike_spikekey_unique |
| FactoryDef | factoryId | factory_def_factoryid_unique |
| FactoryRepo | repoKey | factory_repo_repokey_unique |
| FactoryHealth | factoryId | factory_health_factoryid_unique |
| FactoryGitHubLink | taskId | factory_githublink_taskid_unique |
| FactorySyncRequest | requestId | factory_syncrequest_requestid_unique |

```bash
blocks data schema indexes create --schema-id <id> --fields <field> --unique --name <index name> --dry-run   # then --yes
```

For the three plan-6 tables, the index commands are shown as examples. A fresh project runs the generic command above for every table in the index table; a project set up before plan 6 runs only these three:

```bash
blocks data schema indexes create --schema-id <FactoryDef id>    --fields factoryId --unique --name factory_def_factoryid_unique --dry-run     # then --yes
blocks data schema indexes create --schema-id <FactoryRepo id>   --fields repoKey   --unique --name factory_repo_repokey_unique --dry-run      # then --yes
blocks data schema indexes create --schema-id <FactoryHealth id> --fields factoryId --unique --name factory_health_factoryid_unique --dry-run  # then --yes
```

### Existing tables (a project set up before plan 6)

`FactoryTask` and `FactoryEvent` gain a `factoryId` field, and the description of `FactorySettings.scope` changes. `schema fields` adds and updates fields, so save each table's regenerated file again. Find each schema id with `blocks data schema list --json` (or `blocks data schema get-by-name <Table> --json`).

```bash
blocks data schema fields --schema-id <FactoryTask id>     --file blocks/data/factory/FactoryTask.fields.json --dry-run       # then --yes (adds factoryId)
blocks data schema fields --schema-id <FactoryEvent id>    --file blocks/data/factory/FactoryEvent.fields.json --dry-run      # then --yes (adds factoryId)
blocks data schema fields --schema-id <FactorySettings id> --file blocks/data/factory/FactorySettings.fields.json --dry-run   # then --yes (scope description)
```

Then create the three new tables above, then step 4 at once.

## 4. Access rules (do this straight after step 3: until then the tables are open to any signed-in project user)

```bash
blocks data validate
blocks data rules deploy --dry-run       # then --yes
blocks data reload --dry-run             # then --yes
blocks data schema aggregation --schema-name FactoryApproval   # every operation should say Custom
blocks data schema aggregation --schema-name FactoryRepo       # every operation should say Custom
```

## 5. Your account gets the owner role

```bash
blocks iam users list --json                                   # find your user id
blocks iam users update-access <userId> --roles factory-owner --dry-run   # then --yes
```

If `update-access` refuses the flags, run `blocks iam users update-access --help` and adjust.

## 6. The factory's machine login (the secret goes straight into the Keychain, or the keyring on Linux)

```bash
cd ~/scratchpad/selise/the-software-factory
blocks auth client-credentials save --name factory-core --roles factory-core --access-token-valid-minutes 15 --yes --json \
  | (cd core && npm run -s blocks:save-credential -- --project-key <tenantId> --api-url https://api.seliseblocks.com)
```

It should print only `saved blocks-credential (client …)`. If it prints an error, nothing was saved. Run the command again: `-U` replaces the item.

**On Linux (Ubuntu)** the same command saves into the desktop keyring with `secret-tool`, under the same service and account names (`the-software-factory`, `blocks-credential`); saving again replaces it. Install it first with `sudo apt install libsecret-tools`. The keyring must be unlocked, which it is in a normal desktop login; over plain SSH with no desktop session there is no keyring, and the Blocks store can't load. Each machine gets its own machine login this way: run the command once per machine instead of copying the secret between them.

## 7. Tell Claude

Paste the tenantId and anything that failed. Don't paste the client secret, the password or any token.

## 8. GitHub connected mode (stage 4)

Until this is applied, connected mode is off and the Board shows the schema message. A project set up before stage 4 does this once, in the same sitting (the new tables are open to any signed-in project user until the rules are deployed).

```bash
cd core && npm run -s blocks:resources -- --check && cd ..    # the generated files are current
# 1. Create the two schemas, their fields and their unique indexes
for S in FactoryGitHubLink FactorySyncRequest; do
  blocks data schema info save --schema-name $S --collection-name ${S}s --schema-type 1 --dry-run   # then --yes; note the schema id it prints
  blocks data schema fields --schema-id <id> --file blocks/data/factory/$S.fields.json --dry-run    # then --yes
done
blocks data schema indexes create --schema-id <FactoryGitHubLink id>   --fields taskId    --unique --name factory_githublink_taskid_unique --dry-run      # then --yes
blocks data schema indexes create --schema-id <FactorySyncRequest id>  --fields requestId --unique --name factory_syncrequest_requestid_unique --dry-run  # then --yes
# 2. Save the two changed files again (adds FactoryDef.github, FactoryHealth.watcherSeenAt and githubProblems)
blocks data schema fields --schema-id <FactoryDef id>    --file blocks/data/factory/FactoryDef.fields.json --dry-run      # then --yes
blocks data schema fields --schema-id <FactoryHealth id> --file blocks/data/factory/FactoryHealth.fields.json --dry-run   # then --yes
# 3. Rules (the step 4 commands), then check the new table
blocks data validate
blocks data rules deploy --dry-run       # then --yes
blocks data reload --dry-run             # then --yes
blocks data schema aggregation --schema-name FactoryGitHubLink   # every operation should say Custom
# 4. Check
factory doctor --store blocks
```

## Then: the two live checks (Tasks 8 and 9)

```bash
cd ~/scratchpad/selise/the-software-factory/core
npm run -s blocks:spike-doc-size -- --confirm-synthetic-writes
npm run -s blocks:gate -- --confirm-synthetic-writes        # asks for your Blocks email and password (hidden); steps 1-15 must pass
```

Paste both outputs. They show only sizes or step labels with ok/pass/FAIL.
