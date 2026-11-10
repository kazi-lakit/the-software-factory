import { z } from 'zod';

// Pure (no Node API): the browser entry validates repo definitions with it.
const cmd = z.string().min(1);

export const ChecksSchema = z.object({
  server: z.object({ cwd: cmd, build: cmd, test: cmd }),
  client: z.object({ cwd: cmd, install: cmd, typecheck: cmd, lint: cmd, test: cmd }),
  e2e: z.literal('off'),
});

export type Checks = z.infer<typeof ChecksSchema>;
