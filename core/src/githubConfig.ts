// Pure (no Node API): the browser entry validates the factory's github block with it.
import { ALL_STATUSES } from './status.js';
import type { Status } from './types.js';
import { GH_USER_PATTERN, type Validated } from './validated.js';

export type GitHubMode = 'github-only' | 'connected';
export interface ProjectRef { owner: string; number: number }
export interface GitHubSettings {
  mode: GitHubMode;
  project: ProjectRef;
  /** '' = no label filter. */
  label: string;
  /** GitHub logins, at least one. */
  approvers: string[];
  /** Project Status option name per status (trimmed). */
  statusMap: Record<Status, string>;
}

export const DEFAULT_LABEL = 'factory';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** "owner/number": owner a GitHub login, number a positive integer. */
export function parseProjectRef(v: string): ProjectRef | null {
  const m = /^([^/]+)\/(\d+)$/.exec(v.trim());
  if (!m || !GH_USER_PATTERN.test(m[1]!)) return null;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { owner: m[1]!, number } : null;
}

function statusMapOf(v: unknown): Validated<Record<Status, string>> {
  if (!isObject(v)) return fail('github.statusMap must map statuses to Project Status options');
  for (const k of Object.keys(v)) {
    if (!(ALL_STATUSES as readonly string[]).includes(k)) return fail(`github.statusMap has an unknown status: ${k}`);
  }
  const out = {} as Record<Status, string>;
  for (const s of ALL_STATUSES) {
    const o = v[s];
    if (o === undefined || o === null) return fail(`github.statusMap.${s} is required`);
    if (typeof o !== 'string' || o.trim() === '') return fail(`github.statusMap.${s} must not be blank`);
    out[s] = o.trim();
  }
  if (out.inbox === out.ready) return fail('github.statusMap: inbox and ready must map to different options');
  for (const s of ALL_STATUSES) {
    if (s === 'inbox' || s === 'ready' || s === 'done' || s === 'cancelled') continue;
    if (out[s] === out.inbox) return fail(`github.statusMap.${s} must not share the inbox option (only done and cancelled may)`);
    if (out[s] === out.ready) return fail(`github.statusMap.${s} must not share the ready option (only done and cancelled may)`);
  }
  return { ok: true, value: out };
}

export function validateGitHubSettings(input: unknown, ghUser: string): Validated<GitHubSettings | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isObject(input)) return fail('github must be an object');
  if (input.mode === undefined || input.mode === null) return fail('github.mode is required');
  if (input.mode !== 'github-only' && input.mode !== 'connected') return fail('github.mode must be github-only or connected');
  const project = typeof input.project === 'string' ? parseProjectRef(input.project) : null;
  if (!project) return fail('github.project must be owner/number');
  let label = DEFAULT_LABEL;
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== 'string') return fail('github.label must be text');
    label = input.label.trim();
  }
  let approvers = [ghUser];
  if (input.approvers !== undefined && input.approvers !== null) {
    const a = input.approvers;
    if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === 'string' && GH_USER_PATTERN.test(x.trim()))) {
      return fail('github.approvers must list at least one GitHub login');
    }
    approvers = (a as string[]).map((x) => x.trim());
  }
  const statusMap = statusMapOf(input.statusMap);
  if (!statusMap.ok) return statusMap;
  return { ok: true, value: { mode: input.mode, project, label, approvers, statusMap: statusMap.value } };
}
