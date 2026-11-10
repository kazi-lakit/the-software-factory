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
const fm = Object.fromEntries(
  fmText.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((k) => [k[1], k[2].trim()]),
);

describe('run skill', () => {
  it('has the frontmatter and no disable-model-invocation', () => {
    expect(m).not.toBeNull();
    expect(fm.name).toBe('run');
    expect(fm.description).toBe('Run one step of the software factory (use only when the user runs /factory:run)');
    expect(fm['argument-hint']).toBe('[T-12] [--loop]');
    expect(fm['allowed-tools']).toBe('Bash(node:*), Bash(printenv:*), Bash(rm -f:*), Bash(git -C:*), Agent, Read, Write');
    expect(fmText).not.toContain('disable-model-invocation');
  });

  it('has the numbered steps 0 to 7', () => {
    for (let i = 0; i <= 7; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(body).not.toMatch(/^8\. /m);
  });

  it('mentions the CLI, reply file, session file and every agent type', () => {
    for (const s of ['--mode', '--reply', 'nothing to do', 'runs/.sessions/', '${CLAUDE_PROJECT_DIR}', '${CLAUDE_SESSION_ID}', 'core/dist/cli.js']) {
      expect(body).toContain(s);
    }
    for (const agent of Object.values(AGENT_FOR)) expect(body).toContain(`factory:${agent}`);
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
    expect(body).toContain('--reply "${CLAUDE_PROJECT_DIR}/runs/<task>/<step>.reply.md"');
    for (const line of body.split('\n')) {
      for (const m of line.matchAll(/`((?:node|rm -f|git -C) [^`]*)`/g)) {
        expect(m[1], line).not.toMatch(/(^|\s)\$\{CLAUDE_PROJECT_DIR\}/);
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
});
