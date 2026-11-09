# Blocks project setup (plan 2, Task 7)

Run these yourself in a terminal on the Mac, signed in to the Blocks CLI with your own account. Each mutating command runs as `--dry-run` first. Check the output, then run the same command with `--yes` instead.

```bash
export BLOCKS_STRICT_FLAGS=1
cd ~/scratchpad/selise/the-software-factory
blocks auth status
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

Repeat this for each table: `FactoryTask`, `FactoryDoc`, `FactoryApproval`, `FactorySettings`, `FactoryRun`, `FactoryEvent`, `FactorySpike`.

```bash
S=FactoryTask
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

```bash
blocks data schema indexes create --schema-id <id> --fields <field> --unique --name <index name> --dry-run   # then --yes
```

## 4. Access rules (do this straight after step 3: until then the tables are open to any signed-in project user)

```bash
blocks data validate
blocks data rules deploy --dry-run       # then --yes
blocks data reload --dry-run             # then --yes
blocks data schema aggregation --schema-name FactoryApproval   # every operation should say Custom
```

## 5. Your account gets the owner role

```bash
blocks iam users list --json                                   # find your user id
blocks iam users update-access <userId> --roles factory-owner --dry-run   # then --yes
```

If `update-access` refuses the flags, run `blocks iam users update-access --help` and adjust.

## 6. The factory's machine login (the secret goes straight into the Keychain)

```bash
cd ~/scratchpad/selise/the-software-factory
blocks auth client-credentials save --name factory-core --roles factory-core --access-token-valid-minutes 15 --yes --json \
  | (cd core && npm run -s blocks:save-credential -- --project-key <tenantId> --api-url https://api.seliseblocks.com)
```

It should print only `saved blocks-credential (client …)`. If it prints an error, nothing was saved. Run the command again: `-U` replaces the item.

## 7. Tell Claude

Paste the tenantId and anything that failed. Don't paste the client secret, the password or any token.

## Then: the two live checks (Tasks 8 and 9)

```bash
cd ~/scratchpad/selise/the-software-factory/core
npm run -s blocks:spike-doc-size -- --confirm-synthetic-writes
npm run -s blocks:gate -- --confirm-synthetic-writes        # asks for your Blocks email and password (hidden)
```

Paste both outputs. They show only sizes or step labels with ok/pass/FAIL.
