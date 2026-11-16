# factory.yaml reference

One file per factory: `factories/<id>/factory.yaml`. `./factory init` writes it for you and keeps your comments and key order when it changes it later. You can also edit it by hand; run `./factory doctor` afterwards to check it. A typo makes the factory unavailable until fixed (doctor names the file, the field path and the fix). It never falls back to an older copy.

## Fields

| Field | Meaning |
| --- | --- |
| `factory.id` | Lowercase letters, digits and hyphens. Must match the folder name. |
| `factory.name` | Display name. |
| `factory.source` | `local` (this machine's store) or `factory-app` (the Blocks Board). |
| `factory.docsPath` | Optional folder the spec writer may read. |
| `factory.git` | Optional commit identity: `{ name, email }`. |
| `factory.active` | `false` pauses the factory out of every run. |
| `factory.agents` | Model per stage (`spec`, `plan`, `build`, `verify`, `review`): `opus`, `sonnet`, `haiku` or `fable`. Left out means the session's model. |
| `accounts.github` | The gh login to use. Logins only, never tokens. |
| `board.source` | `none`, `github` or `factory-app`. `trello` and `jira` are not supported yet. |
| `board.mirror` | `none` or `github`; only with `board.source: factory-app`. |
| `board.project` | `<owner>/<number>` of the GitHub Project (source `github`). |
| `board.label` | The label on issues the factory owns (default `factory`). |
| `board.approvers` | GitHub logins whose `/approve` counts. |
| `board.statusMap` | Optional: status to Project column. Left out means the default 13 columns. |
| `gates` | `spec`, `plan`, `pr`: which steps wait for a human. Read in local mode only; in app modes gates are set on the Board. |
| `repos.host` | Default host for the repos (`github`; other hosts are not supported yet). |
| `repos.protectedBranches` | Default for every repo. `main` is always protected, and is never a base branch. Default `[dev, stg, main]`. |
| `repos.list[]` | `id`, `remote`, optional `host`, `baseBranch`, `protectedBranches`, and `checks`. |

Rules:

- `factory.source: local` takes `board.source: github` or `none`. `board.source: factory-app` needs `factory.source: factory-app`. A `mirror` other than `none` needs `board.source: factory-app`.
- `accounts.<service>` must exist for every service the factory uses: the board's source (or mirror) and every repo host.
- Every repo needs a `baseBranch` that is not `main`.
- In app modes only the checks list reaches the Board; the other new fields are local-only.

## Checks

`checks` is an ordered list per repo. Each item is `{ name, cwd, run, needs? }`:

- `name`: unique in the repo; shown in the check report.
- `cwd`: a folder inside the repo (relative, no `..`).
- `run`: a shell command.
- `needs`: optional name of an earlier check; this check is skipped when that one did not pass.
- An empty list means no checks: the check step passes.

The wizard detects checks from the repo's files (`package.json` scripts, `*.sln`, `go.mod`, `pyproject.toml`, `Cargo.toml`, a `Makefile` with `test`) and lets you edit the list.

## Store variables

- `FACTORY_STORE`: `local` (default) or `factory-app`. `file` and `blocks` are still accepted for `local` and `factory-app`. `--store` takes the same values.
- `FACTORY_STORE_LOCAL_PATH`: an absolute folder for the store data only (`board.json` and its locks). Empty means `<root>/.factory`. `factories/` stays in the clone.
- A command that names a factory (`--factory`) whose YAML says `factory.source: local` uses the local store, whatever the variable says.

## Templates

Replace the ids, logins and repos with your own.

### App only

The Blocks Board holds the tasks; GitHub is used only for pull requests.

```yaml
factory:
  id: myapp
  name: My App
  source: factory-app
accounts:
  github: my-login
board:
  source: factory-app
  mirror: none
repos:
  host: github
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```

### App + GitHub

The Blocks Board holds the tasks and mirrors them to a GitHub Project.

```yaml
factory:
  id: myapp
  name: My App
  source: factory-app
accounts:
  github: my-login
board:
  source: factory-app
  mirror: github
  project: my-login/7
  label: factory
  approvers: [my-login]
repos:
  host: github
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```

### Local + GitHub

Tasks live on a GitHub Project and in the local store; nothing else is needed.

```yaml
factory:
  id: myapp
  name: My App
  source: local
  agents:
    spec: opus
    build: sonnet
accounts:
  github: my-login
board:
  source: github
  project: my-login/7
  label: factory
  approvers: [my-login]
gates: { spec: true, plan: false, pr: true }
repos:
  host: github
  protectedBranches: [dev, stg, main]
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```
