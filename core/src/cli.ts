#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { parseAgentReply } from './agentReply.js';
import { NO_FACTORIES, UnknownFactoryError, type Engine } from './engine.js';
import { GATE_DOC } from './gates.js';
import * as owner from './owner.js';
import { ghLoggedInUsers, isGhLoggedIn, realExecFile, type ExecFile } from './secrets.js';
import { isValidId } from './factories.js';
import { buildImport, checkMigration, migrate } from './migrate.js';
import { ForbiddenError, OwnerOnlyError } from './boardStore.js';
import type { BoardStore } from './store.js';
import type { AgentStep, Gate, Mode, RepoId } from './types.js';
import { doctor } from './doctor.js';
import type { GitHubBoardFor } from './githubBoard.js';
import { findRoot, lazyGitHubBoardFor, wire, type WireOptions } from './wire.js';

export type { WireOptions } from './wire.js';

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}
export type MakeEngine = (o: WireOptions) => Promise<{ engine: Engine; store: BoardStore }>;

class CliExit extends Error {
  constructor(
    message: string,
    public readonly code: number,
    /** Print the message as it is, without `error: `. */
    public readonly plain = false,
  ) {
    super(message);
  }
}

const STEPS = ['spec', 'plan', 'build', 'verify', 'review'];
const MODES = ['sdk', 'loop', 'session'];
const STORES = ['file', 'blocks'];

function choice<T extends string>(what: string, value: string, allowed: readonly string[]): T {
  if (!allowed.includes(value)) throw new CliExit(`${what} must be one of ${allowed.join(', ')}`, 1);
  return value as T;
}

function factoryId(value: string): string {
  if (!isValidId(value)) throw new CliExit('--factory must be a factory id (lowercase letters, digits and hyphens)', 1);
  return value;
}

function repoId(what: string, value: string): RepoId {
  if (!isValidId(value)) throw new CliExit(`${what} must be a repo id (lowercase letters, digits and hyphens)`, 1);
  return value;
}

/** `--factory` as given, or the only active factory; otherwise exit 1 naming the active ones. */
async function pickFactory(store: BoardStore, given: string | undefined): Promise<string> {
  if (given !== undefined) return factoryId(given);
  const active = (await store.listFactoryDefs()).filter((d) => d.active).map((d) => d.factoryId);
  if (active.length === 1) return active[0]!;
  throw new CliExit(`--factory is required (active: ${active.join(', ') || 'none'})`, 1);
}

const collect = (v: string, prev: string[] | undefined): string[] => [...(prev ?? []), v];

function factoryFilter(ids: string[] | undefined): string[] | undefined {
  if (!ids) return undefined;
  return ids.map(factoryId);
}

export interface CliDeps {
  /** Runs `gh auth status` (the login check of `status` and `migrate`). Tests pass a fake. */
  exec?: ExecFile;
  home?: string;
  /** GitHub client per gh login (`factory doctor`). Default: the real one over the gh logins. Tests pass a fake. */
  githubBoardFor?: GitHubBoardFor;
}

export async function run(argv: string[], io: IO, makeEngine: MakeEngine = (o) => wire(o), deps: CliDeps = {}): Promise<number> {
  const exec = deps.exec ?? realExecFile;
  const program = new Command();
  program
    .name('factory')
    .description('Drive the software factory engine')
    .option('--mode <mode>', 'sdk | loop | session', 'session')
    .option('--store <store>', 'file | blocks', process.env.FACTORY_STORE || 'file')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, '')), writeErr: (s) => io.err(s.replace(/\n$/, '')) });

  const open = async (cmd: Command) => {
    const g = cmd.optsWithGlobals() as { mode: string; store: string };
    const mode = choice<Mode>('--mode', g.mode, MODES);
    const kind = choice<'file' | 'blocks'>('--store', g.store, STORES);
    return makeEngine({ root: findRoot(), mode, store: kind, log: io.err });
  };

  const depends = (v?: string) => (v === undefined ? {} : { dependsOn: v.split(',').map((x) => x.trim()).filter(Boolean) });
  const printJson = (v: unknown) => io.out(JSON.stringify(v, null, 2));

  program
    .command('next [task]')
    .description('claim the next piece of work and print its ticket')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .option('--peek', 'only check: print "work <task>" and exit 0 if there is work, else the reason and exit 1; claims nothing')
    .action(async (task: string | undefined, o: { json?: boolean; peek?: boolean; factory?: string[] }, cmd: Command) => {
      if (o.peek && o.json) throw new CliExit('--peek prints one line; leave out --json', 1);
      const { engine } = await open(cmd);
      const outcome = await engine.next(task, factoryFilter(o.factory), { peek: o.peek === true }).catch((e: unknown) => {
        throw e instanceof UnknownFactoryError ? new CliExit(e.message, 1, true) : e;
      });
      if (outcome.kind === 'work') return io.out(`work ${outcome.taskId}`);
      // Paused and inactive factories also return no ticket: say so, so a loop's owner is not left guessing.
      if (outcome.kind === 'none') {
        const line = outcome.reason === 'waiting' ? `${outcome.taskId} is waiting on ${outcome.waitingOn.join(', ')}`
          : outcome.reason === 'no-factories' ? NO_FACTORIES : outcome.reason;
        io.out(line);
        // A peek's exit code is its answer: 1 means do not start a session. The line is already on stdout.
        if (o.peek) throw new CliExit('', 1, true);
        return;
      }
      const { ticket } = outcome;
      if (o.json) return printJson(ticket);
      io.out(`${ticket.taskId} ${ticket.step} (worktree ${ticket.worktree})`);
    });

  program
    .command('complete <task> <step>')
    .description('report an agent step result')
    .option('--result <file>', 'path of the agent result JSON')
    .option('--reply <file>', 'path of the agent reply text (<factory-result> and <factory-doc> blocks)')
    .action(async (task: string, step: string, o: { result?: string; reply?: string }, cmd: Command) => {
      const agentStep = choice<AgentStep>('step', step, STEPS);
      if ((o.result === undefined) === (o.reply === undefined)) throw new CliExit('pass exactly one of --result or --reply', 1);
      const { engine } = await open(cmd);
      const updated =
        o.reply !== undefined
          ? await engine.completeWith(task, agentStep, parseAgentReply(readOrUndefined(o.reply), agentStep))
          : await engine.complete(task, agentStep, readOrUndefined(o.result!));
      io.out(`${updated.taskId} ${updated.status}`);
    });

  program
    .command('check <task>')
    .description('run the repo checks')
    .action(async (task: string, _o: object, cmd: Command) => {
      const { engine } = await open(cmd);
      const updated = await engine.check(task);
      io.out(`${updated.taskId} ${updated.status}`);
    });

  program
    .command('ship <task>')
    .description('push the branch and open (or merge) the PR')
    .action(async (task: string, _o: object, cmd: Command) => {
      const { engine } = await open(cmd);
      const updated = await engine.ship(task);
      io.out(`${updated.taskId} ${updated.status}${updated.prUrl ? ` ${updated.prUrl}` : ''}`);
    });

  program
    .command('renew <task>')
    .description('extend your claim on a task by 10 minutes')
    .action(async (task: string, _o: object, cmd: Command) => {
      const { engine } = await open(cmd);
      const renewed = await engine.renew(task);
      io.out(`${renewed.taskId} claimed until ${renewed.claimUntil}`);
    });

  program
    .command('status')
    .description('counts per status and active claims')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean; factory?: string[] }, cmd: Command) => {
      const { engine, store } = await open(cmd);
      const s = await engine.status(factoryFilter(o.factory));
      // Check each factory's gh login with one `gh auth status` (no token is read) and record it for the Board page.
      const loggedIn = new Map<string, boolean>();
      const loaded = new Map(s.factories.map((f) => [f.factoryId, f]));
      const users = await ghLoggedInUsers(exec);
      for (const d of await store.listFactoryDefs()) {
        const f = loaded.get(d.factoryId);
        if (!f) continue;
        const ok = isGhLoggedIn(users, f.ghUser);
        loggedIn.set(d.factoryId, ok);
        try {
          await store.setFactoryHealth({ factoryId: d.factoryId, ghLoggedIn: ok, checkedAt: new Date().toISOString() });
        } catch (e) {
          io.err(`health of ${d.factoryId} not written: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
        }
      }
      for (const f of s.factories) f.ghLoggedIn = loggedIn.get(f.factoryId) ?? f.ghLoggedIn;
      if (o.json) return printJson(s);
      io.out(`paused: ${s.paused}`);
      for (const f of s.factories) {
        const counts = Object.entries(f.counts).filter(([, n]) => n > 0).map(([status, n]) => `${status}=${n}`);
        io.out(`factory ${f.factoryId}: ${f.active ? 'active' : 'inactive'}, paused ${f.paused}, gh ${f.ghUser} ${f.ghLoggedIn === null ? 'unknown' : f.ghLoggedIn ? 'logged in' : 'not logged in'}${counts.map((c) => `, ${c}`).join('')}`);
      }
      for (const [status, n] of Object.entries(s.counts)) io.out(`${status}: ${n}`);
      for (const a of s.active) io.out(`active: ${a.taskId} ${a.step ?? '-'} by ${a.claimBy ?? '-'} until ${a.claimUntil ?? '-'}`);
      for (const t of s.tasks.filter((x) => x.status === 'blocked')) {
        const reason = t.blockedReason ? ` (${t.blockedReason})` : '';
        io.out(`blocked: ${t.taskId} at ${t.stage ?? '-'}${reason}, question: ${t.question ?? '-'}`);
      }
    });

  program
    .command('new')
    .description('create a task in the Board (run by the owner from their session; inbox unless --ready)')
    .option('--factory <id>', 'factory id (required unless exactly one factory is active)')
    .requiredOption('--repo <id>', 'repo id')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'task description')
    .option('--description-file <path>', 'file with the task description')
    .option('--base <branch>', 'base branch (default dev; never main)')
    .option('--ready', 'start in ready instead of inbox')
    .option('--depends-on <ids>', 'comma-separated task ids this task waits for')
    .option('--json', 'print the task as JSON')
    .action(async (o: { factory?: string; repo: string; title: string; description?: string; descriptionFile?: string; base?: string; ready?: boolean; dependsOn?: string; json?: boolean }, cmd: Command) => {
      if ((o.description === undefined) === (o.descriptionFile === undefined)) {
        throw new CliExit('pass exactly one of --description or --description-file', 1);
      }
      const repo = repoId('--repo', o.repo);
      let description = o.description ?? '';
      if (o.descriptionFile !== undefined) {
        try {
          description = readFileSync(o.descriptionFile, 'utf8');
        } catch {
          throw new CliExit(`cannot read --description-file ${o.descriptionFile}`, 1);
        }
      }
      const { store } = await open(cmd);
      const t = await owner.createTaskAsCore(store, () => new Date(), {
        factoryId: await pickFactory(store, o.factory), title: o.title, description, repo, ...(o.base ? { baseBranch: o.base } : {}), ready: o.ready === true, ...depends(o.dependsOn),
      });
      if (o.json) return printJson(t);
      io.out(`${t.taskId} created in ${t.status}`);
    });

  program
    .command('factories')
    .description('list the factories and their repos (no secrets)')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }, cmd: Command) => {
      const { store } = await open(cmd);
      const [defs, repos] = await Promise.all([store.listFactoryDefs(), store.listFactoryRepos()]);
      const list = defs.map((d) => ({ ...d, repos: repos.filter((r) => r.factoryId === d.factoryId).map(({ factoryId: _f, ...r }) => r) }));
      if (o.json) return printJson({ factories: list });
      for (const f of list) {
        io.out(`${f.factoryId} (${f.name}) ${f.active ? 'active' : 'inactive'}: ${f.repos.map((r) => r.repoId).join(', ') || 'no repos'}`);
      }
    });

  program
    .command('doctor')
    .description('check each factory\'s gh login and GitHub setup (reads only; exit 1 when a check fails)')
    .option('--factory <id>', 'only this factory (repeat for several)', collect, undefined)
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean; factory?: string[] }, cmd: Command) => {
      const only = factoryFilter(o.factory);
      const kind = choice<'file' | 'blocks'>('--store', (cmd.optsWithGlobals() as { store: string }).store, STORES);
      const { store } = await open(cmd);
      const [defs, repos] = await Promise.all([store.listFactoryDefs(), store.listFactoryRepos()]);
      const unknown = (only ?? []).filter((id) => !defs.some((d) => d.factoryId === id));
      if (unknown.length > 0) throw new CliExit(`unknown factory: ${unknown.join(', ')}`, 1);
      const checks = await doctor({
        defs, repos, store: kind, loggedIn: await ghLoggedInUsers(exec), boardFor: deps.githubBoardFor ?? lazyGitHubBoardFor(undefined, undefined, exec),
        ...(only ? { only } : {}),
      });
      if (o.json) printJson({ checks });
      else for (const c of checks) io.out(`${c.ok ? 'ok' : 'FAIL'} ${c.factoryId} ${c.check}: ${c.detail}`);
      if (checks.some((c) => !c.ok)) throw new CliExit('', 1, true);
    });

  program
    .command('migrate')
    .description('one-time move of today\'s work into factory blocks (re-runnable; run by the owner)')
    .option('--dry-run', 'print the steps without taking them')
    .option('--yes', 'take the steps (file store only: on the Blocks store the owner imports on the Board, then runs --check)')
    .option('--check', 'read-only: print each step as done or pending; exit 2 while any is pending')
    .option('--export <file>', 'write the blocks factory and its repos as an import file for the Board (reads only repos/*.yaml)')
    .action(async (o: { dryRun?: boolean; yes?: boolean; check?: boolean; export?: string }, cmd: Command) => {
      const home = deps.home ?? homedir();
      if (o.export !== undefined) {
        writeFileSync(o.export, `${JSON.stringify(buildImport(findRoot(), home), null, 2)}\n`);
        return io.out(`wrote ${o.export}`);
      }
      if (o.check !== true && o.dryRun !== true && o.yes !== true) throw new CliExit('migrate changes the Board: pass --check or --dry-run to preview, --yes to run, or --export <file>', 1);
      const onBlocks = (cmd.optsWithGlobals() as { store: string }).store === 'blocks';
      if (onBlocks && o.check !== true) return io.out('nothing for the core to do on the Blocks store; import on the Board, then run factory migrate --check');
      const { store } = await open(cmd);
      const line = (s: { name: string; done: string; detail: string }) => io.out(`${s.name}: ${s.done} - ${s.detail}`);
      if (o.check === true) {
        const report = await checkMigration(store, findRoot(), home, exec, { blocks: onBlocks });
        report.steps.forEach(line);
        for (const n of report.notes) io.out(`note: ${n}`);
        if (report.steps.some((s) => s.done === 'pending')) throw new CliExit('migration pending', 2);
        return;
      }
      try {
        const report = await migrate(store, findRoot(), home, exec, { dryRun: o.dryRun === true, onStep: line });
        for (const n of report.notes) io.out(`note: ${n}`);
      } catch (e) {
        // Defence in depth: a store that refuses owner-only writes (factory definitions, settings, task factoryId) points to the Board.
        if (e instanceof OwnerOnlyError || e instanceof ForbiddenError) {
          throw new CliExit(`this step is done on the Board: Settings → Factories → Import (${e.message})`, 1);
        }
        throw e;
      }
    });

  const dev = program.command('dev').description('stand-ins for the Board page (file store only)');
  const openDev = async (cmd: Command): Promise<BoardStore> => {
    if ((cmd.optsWithGlobals() as { store: string }).store !== 'file') throw new CliExit('dev commands need --store file', 1);
    return (await open(cmd)).store;
  };
  const now = () => new Date();

  dev
    .command('add')
    .option('--factory <id>', 'factory id (required unless exactly one factory is active)')
    .requiredOption('--repo <id>', 'repo id')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'task description', '')
    .option('--base <branch>', 'base branch')
    .option('--depends-on <ids>', 'comma-separated task ids this task waits for')
    .action(async (o: { factory?: string; repo: string; title: string; description: string; base?: string; dependsOn?: string }, cmd: Command) => {
      const repo = repoId('--repo', o.repo);
      const store = await openDev(cmd);
      const t = await owner.createTask(store, now, {
        factoryId: await pickFactory(store, o.factory), title: o.title, description: o.description, repo, ...(o.base ? { baseBranch: o.base } : {}), ...depends(o.dependsOn),
      });
      io.out(t.taskId);
    });

  dev
    .command('ready <task>')
    .action(async (id: string, _o: object, cmd: Command) => {
      await owner.markReady(await openDev(cmd), now, id);
      io.out(`${id} ready`);
    });

  dev
    .command('approve <task> <gate>')
    .option('--changes <comment>', 'ask for changes instead of approving')
    .action(async (id: string, gate: string, o: { changes?: string }, cmd: Command) => {
      const g = choice<Gate>('gate', gate, ['spec', 'plan', 'pr']);
      const store = await openDev(cmd);
      await store.getTask(id);
      const kind = GATE_DOC[g];
      const doc = await store.currentDoc(id, kind);
      if (!doc) throw new CliExit(`no current ${kind} doc for ${id}`, 1);
      const decision = o.changes === undefined ? 'approve' : 'changes';
      await owner.decideGate(store, now, id, g, decision, doc.version, o.changes ?? '');
      io.out(`${id} ${g} ${decision} v${doc.version}`);
    });

  dev
    .command('answer <task> <text>')
    .action(async (id: string, text: string, _o: object, cmd: Command) => {
      const store = await openDev(cmd);
      await owner.answerTask(store, now, id, text, (await store.getTask(id)).version);
      io.out(`${id} answered`);
    });

  dev
    .command('cancel <task>')
    .action(async (id: string, _o: object, cmd: Command) => {
      await owner.cancelTask(await openDev(cmd), now, id);
      io.out(`${id} cancelled`);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof CliExit) {
      if (e.message !== '') io.err(e.code === 2 || e.plain ? e.message : `error: ${e.message}`);
      return e.code;
    }
    io.err(`error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    return 1;
  }
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await run(process.argv.slice(2), { out: console.log, err: console.error });
}
