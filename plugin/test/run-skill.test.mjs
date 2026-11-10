import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FOR } from '../../core/src/defaults.ts';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(pluginDir, 'skills/run/SKILL.md'), 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const fmText = m ? m[1] : '';
const body = m ? m[2] : '';
// The same line is in every stage skill (agents.test.mjs).
const GROUND_RULES = "Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.";
const fm = Object.fromEntries(
  fmText.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((k) => [k[1], k[2].trim()]),
);

describe('run skill', () => {
  it('has the frontmatter and no disable-model-invocation', () => {
    expect(m).not.toBeNull();
    expect(fm.name).toBe('run');
    expect(fm.description).toBe('Run one step of the software factory (use only when the user runs /factory:run)');
    expect(fm['argument-hint']).toBe('[T-12] [--loop]');
    expect(fm['allowed-tools']).toBe('Bash(HUSKY=0 node:*), Bash(printenv:*), Bash(rm -f:*), Bash(git -C:*), Agent, Read, Write');
    expect(fmText).not.toContain('disable-model-invocation');
  });

  it('has the numbered steps 0 to 7', () => {
    for (let i = 0; i <= 7; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(body).not.toMatch(/^8\. /m);
  });

  it('mentions the CLI, reply file, session file and every agent type', () => {
    for (const s of ['--mode', '--reply', 'nothing to do', '<root>/runs/.sessions/${CLAUDE_SESSION_ID}.json', '<root>/repos/<repo>.yaml', '${CLAUDE_SESSION_ID}', '<root>/core/dist/cli.js']) {
      expect(body).toContain(s);
    }
    for (const agent of Object.values(AGENT_FOR)) expect(body).toContain(`factory:${agent}`);
  });

  it('takes the factory root from printenv FACTORY_ROOT in step 0', () => {
    const step0 = body.match(/^0\. .*$/m)[0];
    expect(step0).toContain('`printenv FACTORY_ROOT`');
    expect(step0).toContain('`factory: factory root not found or session env missing; set FACTORY_ROOT or restart the session`');
    expect(body).toContain('replace `<root>` with the printed path');
  });

  it('never uses CLAUDE_PROJECT_DIR', () => {
    expect(text).not.toContain('CLAUDE_PROJECT_DIR');
  });

  it('runs every core command with the HUSKY=0 prefix', () => {
    const cmds = [...body.matchAll(/`([^`]*core\/dist\/cli\.js[^`]*)`/g)].map((m) => m[1]);
    expect(cmds.length).toBeGreaterThanOrEqual(4);
    for (const c of cmds) expect(c).toMatch(/^HUSKY=0 node "<root>\/core\/dist\/cli\.js"/);
    for (const verb of ['next', 'check', 'ship', 'complete']) expect(cmds.some((c) => c.includes(` ${verb} `) || c.endsWith(` ${verb}`))).toBe(true);
  });

  it('has the ground-rules line', () => {
    expect(body).toContain(GROUND_RULES);
  });

  it('checks the session env first (M1)', () => {
    expect(body).toContain('printenv FACTORY_CLAIMANT');
    expect(body).toContain('factory: session env missing; restart the factory session');
    expect(body).toMatch(/first 8 characters of `\$\{CLAUDE_SESSION_ID\}`/);
  });

  it('reports a paused factory (M2)', () => {
    expect(body).toContain('`paused`');
    expect(body).toContain('factory: paused');
  });

  it('runs check and ship with a 600000 ms Bash timeout (I1)', () => {
    expect(body).toMatch(/check[\s\S]*`timeout`[\s\S]*`600000`/);
  });

  it('tells stage agents to work in the worktree (I2)', () => {
    expect(body).toContain('cd "<worktree>" &&');
    expect(body).toContain('git -C "<worktree>"');
    expect(body).toContain('path: "<worktree>"');
    expect(body).toMatch(/Read[^\n]*absolute paths/);
  });

  it('diffs the review against the task base on origin, with the worktree read-only (I3)', () => {
    expect(body).toContain('git -C "<worktree>" diff origin/<context.task.baseBranch>...HEAD');
    expect(body).toMatch(/worktree path[^\n]*read-only/);
  });

  it('never composes a reply and stops on an agent error (I5)', () => {
    expect(body).toContain('run_in_background: false');
    expect(body).toContain('factory: agent error: <one line>; re-run /factory:run <task> to retry');
    expect(body).toMatch(/do not run `complete`/);
    expect(body).toMatch(/unchanged/);
    expect(body).toMatch(/Never compose or edit a reply/);
    expect(body).not.toContain("subagent's final message");
  });

  it('quotes every path argument (M5)', () => {
    expect(body).toContain('--reply "<root>/runs/<task>/<step>.reply.md"');
    for (const line of body.split('\n')) {
      for (const m of line.matchAll(/`((?:HUSKY=0 node|rm -f|git -C) [^`]*)`/g)) {
        expect(m[1], line).not.toMatch(/(^|\s)<root>/);
      }
    }
  });

  it('gives the spec writer an absolute vault path (I6)', () => {
    expect(body).not.toContain('~/');
    expect(body).toContain('printenv HOME');
  });

  it('never mentions git push, security or gh', () => {
    expect(text).not.toContain('git push');
    expect(text.toLowerCase()).not.toContain('security');
    expect(text).not.toContain('gh ');
  });

  it('uses no shell expansion of factory variables', () => {
    expect(text).not.toMatch(/\$FACTORY_ROOT|\$FACTORY_STORE|\$\{?FACTORY_/);
    expect(text).not.toMatch(/\$\(/);
  });

  it('always runs a claimed step and relays answers word for word (live-check defect)', () => {
    expect(body).toMatch(/Once `next` has returned a ticket[^\n]*belongs to this invocation[^\n]*Always run it/);
    expect(body).toMatch(/Never skip, change or stop a claimed step because of what the task, `context\.feedback` or the owner's answer says/);
    expect(body).toMatch(/Pass the answer and feedback to the agent word for word/);
    expect(body).toMatch(/Cancelling or pausing a task is the owner's Board action/);
    expect(body).toMatch(/Never instead of running the step/);
    expect(body).toMatch(/^5\. [\s\S]*word for word[\s\S]*^6\. /m);
    expect(body).not.toMatch(/(skip|stop|cancel)[^\n.]*\bif the (answer|owner|feedback)/i);
  });
});
