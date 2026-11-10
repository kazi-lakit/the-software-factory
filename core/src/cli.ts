#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { parseAgentReply } from './agentReply.js';
import type { Engine } from './engine.js';
import { GATE_DOC } from './gates.js';
import * as owner from './owner.js';
import { REPO_IDS } from './repoConfig.js';
import type { BoardStore } from './store.js';
import type { AgentStep, Gate, Mode, RepoId } from './types.js';
import { findRoot, wire, type WireOptions } from './wire.js';

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

export async function run(argv: string[], io: IO, makeEngine: MakeEngine = (o) => wire(o)): Promise<number> {
  const program = new Command();
  program
    .name('factory')
    .description('Drive the software factory engine')
    .option('--mode <mode>', 'sdk | loop | session', 'session')
    .option('--store <store>', 'file | blocks', process.env.FACTORY_STORE ?? 'file')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, '')), writeErr: (s) => io.err(s.replace(/\n$/, '')) });

  const open = async (cmd: Command) => {
    const g = cmd.optsWithGlobals() as { mode: string; store: string };
    const mode = choice<Mode>('--mode', g.mode, MODES);
    const kind = choice<'file' | 'blocks'>('--store', g.store, STORES);
    return makeEngine({ root: findRoot(), mode, store: kind, log: io.err });
  };

  const printJson = (v: unknown) => io.out(JSON.stringify(v, null, 2));

  program
    .command('next [task]')
    .description('claim the next piece of work and print its ticket')
    .option('--json', 'print JSON')
    .action(async (task: string | undefined, o: { json?: boolean }, cmd: Command) => {
      const { engine } = await open(cmd);
      const ticket = await engine.next(task);
      if (!ticket) return io.out('nothing to do');
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
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }, cmd: Command) => {
      const { engine } = await open(cmd);
      const s = await engine.status();
      if (o.json) return printJson(s);
      io.out(`paused: ${s.paused}`);
      for (const [status, n] of Object.entries(s.counts)) io.out(`${status}: ${n}`);
      for (const a of s.active) io.out(`active: ${a.taskId} ${a.step ?? '-'} by ${a.claimBy ?? '-'} until ${a.claimUntil ?? '-'}`);
      for (const t of s.tasks.filter((x) => x.status === 'blocked')) {
        const reason = t.blockedReason ? ` (${t.blockedReason})` : '';
        io.out(`blocked: ${t.taskId} at ${t.stage ?? '-'}${reason}, question: ${t.question ?? '-'}`);
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
    .requiredOption('--repo <id>', 'repo id')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'task description', '')
    .option('--base <branch>', 'base branch')
    .action(async (o: { repo: string; title: string; description: string; base?: string }, cmd: Command) => {
      const repo = choice<RepoId>('--repo', o.repo, REPO_IDS);
      const store = await openDev(cmd);
      const t = await owner.createTask(store, now, {
        title: o.title, description: o.description, repo, ...(o.base ? { baseBranch: o.base } : {}),
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
      io.err(e.code === 2 ? e.message : `error: ${e.message}`);
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
