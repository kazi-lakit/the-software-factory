import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FOR } from '../../core/src/defaults.ts';
import { parseAgentReply } from '../../core/src/agentReply.ts';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(pluginDir, rel), 'utf8');

/** Small YAML subset: `key: value` lines, with `[a, b]` inline lists. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('no frontmatter');
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    out[kv[1]] = v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : v;
  }
  return out;
}

const READ_ONLY = ['Read', 'Grep', 'Glob'];
const TOOLS = {
  'spec-writer': READ_ONLY,
  planner: READ_ONLY,
  verifier: READ_ONLY,
  reviewer: READ_ONLY,
  implementer: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
};
const skillDir = (name) => name.replace(/^factory:/, '');

describe('stage agents', () => {
  for (const [step, agent] of Object.entries(AGENT_FOR)) {
    describe(agent, () => {
      const fm = frontmatter(read(`agents/${agent}.md`));
      it('has the core agent name, description, model and turn limit', () => {
        expect(fm.name).toBe(agent);
        expect(fm.description).toBeTruthy();
        expect(fm.model).toBe('inherit');
        expect(fm.maxTurns).toBe('60');
      });
      it('has exactly the stage tools', () => {
        expect(fm.tools).toEqual(TOOLS[agent]);
      });
      it('preloads its stage skill and reply-format, both existing', () => {
        expect(fm.skills).toEqual([skillDir(step), 'reply-format'].map((s) => s));
        for (const s of fm.skills) expect(fs.existsSync(path.join(pluginDir, 'skills', skillDir(s), 'SKILL.md'))).toBe(true);
      });
    });
    describe(`${step} skill`, () => {
      const text = read(`skills/${step}/SKILL.md`);
      const fm = frontmatter(text);
      it('is hidden from users and names the reply format', () => {
        expect(fm.name).toBe(step);
        expect(fm['user-invocable']).toBe('false');
        expect(text).toMatch(/reply-format|factory-result/);
      });
    });
  }
});

describe('reply-format skill', () => {
  it('has a reply-example block that parseAgentReply accepts as done', () => {
    const m = read('skills/reply-format/SKILL.md').match(/```reply-example\n([\s\S]*?)\n```/);
    expect(m).not.toBeNull();
    expect(parseAgentReply(m[1], 'spec').status).toBe('done');
  });
});
