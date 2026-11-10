#!/usr/bin/env node
// Builds the Board link that opens the New task form pre-filled (/factory:new).
// Usage: node link.mjs <draft.json>   (draft: {title, description, repo, base})
// Plain Node, no dependencies. The caps match the Board page (BoardView.tsx).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BOARD_URL = 'https://dfrsgz-eseqz.slsblx.com';
export const REPOS = ['os', 'iam', 'monitor', 'logic', 'data', 'localization', 'release'];
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 8000;
const MAX_LINK = 8000;

const text = (value) => (typeof value === 'string' ? value : '');

export function buildLink(draft, boardUrl) {
  const repo = text(draft?.repo).trim();
  if (!REPOS.includes(repo)) throw new Error(`factory: unknown repo ${text(draft?.repo)}`);
  const base = text(draft?.base).trim();
  if (base === 'main') throw new Error('factory: the factory never targets main');
  const title = text(draft?.title);
  if (title.trim() === '') throw new Error('factory: title must not be blank');
  const params = new URLSearchParams({
    new: '1',
    title: title.slice(0, TITLE_MAX),
    description: text(draft?.description).slice(0, DESCRIPTION_MAX),
    repo,
    base,
  });
  return `${boardUrl.replace(/\/+$/, '')}/?${params.toString()}`;
}

function main(file) {
  try {
    if (!file) throw new Error('factory: usage: node link.mjs <draft.json>');
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`factory: cannot read the draft: ${error.message}`);
    }
    const board = process.env.FACTORY_BOARD_URL || DEFAULT_BOARD_URL;
    const link = buildLink(draft, board);
    if (link.length > MAX_LINK) process.stderr.write('factory: long link; some browsers or proxies may refuse it — shorten the description\n');
    process.stdout.write(`${link}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main(process.argv[2]);
