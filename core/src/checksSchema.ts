import { z } from 'zod';

// Pure (no Node API): the browser entry validates repo definitions with it.
const cmd = z.string().min(1);
/** A folder inside the worktree: relative, with no `..` segment (the core joins it to the worktree). */
const cwd = z
  .string()
  .min(1)
  .refine((v) => !/^([\\/]|[A-Za-z]:)/.test(v) && !v.split(/[\\/]/).includes('..'), { message: 'must be a folder inside the repo (relative, no ..)' });

export const ChecksSchema = z.object({
  server: z.object({ cwd, build: cmd, test: cmd }),
  client: z.object({ cwd, install: cmd, typecheck: cmd, lint: cmd, test: cmd }),
  e2e: z.literal('off'),
});

export type Checks = z.infer<typeof ChecksSchema>;
