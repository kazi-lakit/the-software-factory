import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FOR } from '../../core/src/defaults.ts';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(pluginDir, 'skills/factory/SKILL.md'), 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const fmText = m ? m[1] : '';
const body = m ? m[2] : '';
const fm = Object.fromEntries(
  fmText.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((k) => [k[1], k[2].trim()]),
);

describe('factory skill', () => {
  it('has the frontmatter and no disable-model-invocation', () => {
    expect(m).not.toBeNull();
    expect(fm.name).toBe('factory');
    expect(fm.description).toBe('Run one step of the software factory (use only when the user runs /factory:factory)');
    expect(fm['argument-hint']).toBe('[T-12] [--loop]');
    expect(fm['allowed-tools']).toBe('Bash, Agent, Read, Write');
    expect(fmText).not.toContain('disable-model-invocation');
  });

  it('has the seven numbered steps', () => {
    for (let i = 1; i <= 7; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(body).not.toMatch(/^8\. /m);
  });

  it('mentions the CLI, reply file, session file and every agent type', () => {
    for (const s of ['--mode', '--reply', 'nothing to do', 'runs/.sessions/', '${CLAUDE_PROJECT_DIR}', '${CLAUDE_SESSION_ID}', 'core/dist/cli.js']) {
      expect(body).toContain(s);
    }
    for (const agent of Object.values(AGENT_FOR)) expect(body).toContain(`factory:${agent}`);
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
