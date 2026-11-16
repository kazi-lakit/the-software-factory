# The software factory

## Getting started

You need Node 22 or newer, git, [Claude Code](https://docs.claude.com/claude-code) and the [GitHub CLI](https://cli.github.com).

1. Clone this repository and go into it.
2. Run `./setup.sh` (macOS, Linux) or `setup.cmd` (Windows, in cmd.exe). It checks the tools, installs and builds the core, writes the local `./factory` and `factory.cmd` launchers (git-ignored), and installs the Claude Code plugin at user scope. Run it again any time: every step checks first and skips what is done.
3. Run `./factory init` (Windows: `factory.cmd init`) and answer its questions. It sets up your GitHub login, a Project board, gates, models and repos, and writes `factories/<id>/factory.yaml`. After "Add another factory" the wizard finishes; run `./factory init` again for more changes.
4. To change settings later, run `./factory init` again: it shows a menu (models, gates, approvers, status map, repos, doctor). Your comments in `factory.yaml` are kept.
5. Open Claude Code and run `/factory:run`.

The plugin and its guard hooks are installed user-scoped by setup, so `/factory:run` works from any folder. See [plugin/README.md](plugin/README.md).

`factories/<id>/factory.yaml` holds your GitHub logins and repo links and is not git-ignored. Don't commit it into contributions to this repository upstream.

The store defaults to `local` (`FACTORY_STORE=local|factory-app`). With `FACTORY_STORE=blocks` (or `factory-app`) exported, `/factory:run` with no factory named sees only the Blocks factories: name your local factory (`/factory:run <factory>`) or use `FACTORY_STORE=local`. The file format, the checks list, the store variables and three ready templates (app only, app + GitHub, local + GitHub) are in the [factory.yaml reference](docs/setup/factory-yaml.md).
