import { expect, test } from 'vitest';
import { realGhCli } from '../../src/init/ghCli.js';
import type { ExecFile } from '../../src/secrets.js';

const status = (logins: { login: string; state: string }[]) => JSON.stringify({ hosts: { 'github.com': logins } });

function fakes(out: string, code = 0) {
  const execs: string[][] = [];
  const runs: string[][] = [];
  const exec: ExecFile = async (_f, args) => { execs.push(args); return { code, stdout: out, stderr: '' }; };
  const run = async (args: string[]) => { runs.push(args); return 0; };
  return { execs, runs, cli: realGhCli(exec, run) };
}

test('logins keeps the spelling and only working logins', async () => {
  const { cli } = fakes(status([{ login: 'Me', state: 'success' }, { login: 'old', state: 'error' }]));
  expect(await cli.logins()).toEqual(['Me']);
  expect(await fakes('not json').cli.logins()).toEqual([]);
  expect(await fakes(status([{ login: 'me', state: 'success' }]), 1).cli.logins()).toEqual([]);
});

test('login runs auth login interactively', async () => {
  const f = fakes(status([]));
  await f.cli.login();
  expect(f.runs).toEqual([['auth', 'login', '--hostname', 'github.com']]);
});

test('refresh switches to the login first only when there are several', async () => {
  const one = fakes(status([{ login: 'me', state: 'success' }]));
  await one.cli.refreshProjectScope('me');
  expect(one.execs.some((a) => a.includes('switch'))).toBe(false);
  expect(one.runs).toEqual([['auth', 'refresh', '--hostname', 'github.com', '-s', 'project']]);

  const two = fakes(status([{ login: 'me', state: 'success' }, { login: 'work', state: 'success' }]));
  await two.cli.refreshProjectScope('work');
  expect(two.execs.at(-1)).toEqual(['auth', 'switch', '--hostname', 'github.com', '--user', 'work']);
  expect(two.runs).toHaveLength(1);
});
