import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(pluginDir, 'skills/new/SKILL.md'), 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const fmText = m ? m[1] : '';
const body = m ? m[2] : '';
const GROUND_RULES = "Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.";
const fm = Object.fromEntries(
  fmText.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((k) => [k[1], k[2].trim()]),
);

describe('new skill', () => {
  it('has the frontmatter', () => {
    expect(m).not.toBeNull();
    expect(fm.name).toBe('new');
    expect(fm.description).toBe("Draft a factory task from the user's words and give a Board link to create it (use only when the user runs /factory:new)");
    expect(fm['argument-hint']).toBe('<what you want done>');
    expect(fm['allowed-tools']).toBe('Read, Write, Bash(node:*), Bash(printenv:*)');
  });

  it('is started only by the user', () => {
    expect(fm['disable-model-invocation']).toBe('true');
  });

  it('has the numbered steps 0 to 5', () => {
    for (let i = 0; i <= 5; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(body).not.toMatch(/^6\. /m);
  });

  it('finds the factory root from FACTORY_ROOT, then HOME', () => {
    const step0 = body.match(/^0\. .*$/m)[0];
    expect(step0).toContain('`printenv FACTORY_ROOT`');
    expect(step0).toContain('`printenv HOME`');
    expect(step0).toContain('/scratchpad/selise/the-software-factory');
    expect(step0).toContain('/repos');
    expect(step0).toContain('`factory: factory root not found`');
  });

  it('reads the repo configs and drafts the four fields', () => {
    expect(body).toContain('<root>/repos/*.yaml');
    expect(body).toContain('baseBranch');
    for (const field of ['repo', 'base', 'title', 'description']) expect(body).toContain(`**${field}:**`);
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('Acceptance criteria');
    expect(body).toContain('Open questions');
  });

  it('writes the draft under runs/.drafts and runs link.mjs', () => {
    expect(body).toContain('runs/.drafts/');
    expect(body).toContain('${CLAUDE_SESSION_ID}');
    expect(body).toContain('link.mjs');
    expect(body).toContain('${CLAUDE_SKILL_DIR}');
    expect(body).toMatch(/Create task/);
    expect(body).toMatch(/Mark ready/);
    expect(body).toContain('/factory:run');
  });

  it('never targets main', () => {
    expect(body).toContain('never main');
    expect(body).toContain('`dev`/`stg`');
  });

  it('asks about an ambiguous repo instead of guessing', () => {
    expect(body).toMatch(/ambiguous[^\n]*ask/i);
  });

  it('has the ground-rules line', () => {
    expect(body).toContain(GROUND_RULES);
  });

  it('uses no shell variable expansion', () => {
    const stripped = text.replace(/\$\{CLAUDE_(SESSION_ID|SKILL_DIR)\}/g, '').replace(/\$ARGUMENTS/g, '');
    expect(stripped).not.toMatch(/\$[{(\w]/);
    expect(text).not.toContain('CLAUDE_PROJECT_DIR');
  });

  it('never mentions git push, security or gh', () => {
    expect(text).not.toContain('git push');
    expect(text.toLowerCase()).not.toContain('security');
    expect(text).not.toContain('gh ');
  });
});
