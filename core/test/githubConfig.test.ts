import { expect, test } from 'vitest';
import { validateGitHubSettings } from '../src/githubConfig.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
const input = (over = {}) => ({ mode: 'github-only', project: 'kazi-lakit/3', statusMap: map, ...over });

test('absent or null is no GitHub', () => {
  expect(validateGitHubSettings(undefined, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
  expect(validateGitHubSettings(null, 'kazi-lakit')).toEqual({ ok: true, value: undefined });
});
test('defaults label and approvers', () => {
  const r = validateGitHubSettings(input(), 'kazi-lakit');
  expect(r).toEqual({ ok: true, value: { mode: 'github-only', project: { owner: 'kazi-lakit', number: 3 }, label: 'factory', approvers: ['kazi-lakit'], statusMap: map } });
});
test('empty label is kept as no filter', () => {
  expect(validateGitHubSettings(input({ label: '' }), 'u')).toMatchObject({ ok: true, value: { label: '' } });
});
test('{} needs a mode', () => {
  expect(validateGitHubSettings({}, 'u')).toEqual({ ok: false, error: 'github.mode is required' });
});
test.each([
  [{ mode: 'mirror' }, 'github.mode must be github-only or connected'],
  [{ project: 'kazi-lakit' }, 'github.project must be owner/number'],
  [{ project: 'kazi-lakit/0' }, 'github.project must be owner/number'],
  [{ approvers: [] }, 'github.approvers must list at least one GitHub login'],
  [{ approvers: ['not a login'] }, 'github.approvers must list at least one GitHub login'],
  [{ statusMap: { ...map, testing: 'Testing' } }, 'github.statusMap has an unknown status: testing'],
  [{ statusMap: { ...map, verify: undefined } }, 'github.statusMap.verify is required'],
  [{ statusMap: { ...map, verify: '  ' } }, 'github.statusMap.verify must not be blank'],
  [{ statusMap: { ...map, ready: 'Backlog' } }, 'github.statusMap: inbox and ready must map to different options'],
  [{ statusMap: { ...map, blocked: 'Todo' } }, 'github.statusMap.blocked must not share the ready option (only done and cancelled may)'],
  [{ statusMap: { ...map, spec: 'Backlog' } }, 'github.statusMap.spec must not share the inbox option (only done and cancelled may)'],
  [{ label: 5 }, 'github.label must be text'],
  [{ project: 5 }, 'github.project must be owner/number'],
  [{ statusMap: 'x' }, 'github.statusMap must map statuses to Project Status options'],
])('rejects %j', (over, error) => {
  expect(validateGitHubSettings(input(over), 'u')).toEqual({ ok: false, error });
});
test('done and cancelled may share inbox/ready options; names are trimmed', () => {
  const r = validateGitHubSettings(input({ statusMap: { ...map, done: 'Todo ', cancelled: 'Backlog' } }), 'u');
  expect(r).toMatchObject({ ok: true, value: { statusMap: { done: 'Todo', cancelled: 'Backlog' } } });
});
