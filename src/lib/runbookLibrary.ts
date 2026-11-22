import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { logger } from './logger';

const RunbookStepSchema = z.object({
  title: z.string(),
  action: z.string(),
  command: z.string().optional().nullable(),
  tool: z.enum(['kubectl', 'docker', 'postgres', 'redis-cli', 'bash', 'api_call', 'manual', 'slack']),
  risk_level: z.enum(['safe', 'low', 'medium', 'high', 'critical']),
  requires_approval: z.boolean(),
  rollback_command: z.string().optional().nullable(),
  expected_outcome: z.string(),
  timeout_seconds: z.number(),
});

const RunbookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  title: z.string(),
  triggers: z.object({
    categories: z.array(z.string()),
    services: z.array(z.string()),
    keywords: z.array(z.string()),
  }),
  steps: z.array(RunbookStepSchema).min(1),
});

export type LibraryRunbook = z.infer<typeof RunbookSchema>;

let _library: LibraryRunbook[] | null = null;

export function loadRunbookLibrary(dir?: string): LibraryRunbook[] {
  if (_library) return _library;

  const runbookDir = dir ?? path.resolve(process.cwd(), 'runbooks');
  if (!fs.existsSync(runbookDir)) {
    logger.info('No runbooks/ directory found — library empty');
    _library = [];
    return _library;
  }

  const files = fs.readdirSync(runbookDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const loaded: LibraryRunbook[] = [];

  for (const file of files) {
    const filePath = path.join(runbookDir, file);
    try {
      const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
      const result = RunbookSchema.safeParse(raw);
      if (!result.success) {
        const msg = `Invalid runbook ${file}: ${result.error.toString().slice(0, 300)}`;
        logger.error(msg);
        throw new Error(msg);
      }
      loaded.push(result.data);
    } catch (err) {
      if ((err as Error).message.startsWith('Invalid runbook')) throw err;
      throw new Error(`Failed to parse runbook ${file}: ${(err as Error).message}`);
    }
  }

  logger.info(`Runbook library loaded`, { count: loaded.length, ids: loaded.map((r) => r.id) });
  _library = loaded;
  return _library;
}

export function findMatchingRunbooks(
  services: string[],
  category: string,
  keywords: string[]
): LibraryRunbook[] {
  const library = loadRunbookLibrary();
  return library.filter((rb) => {
    const catMatch = rb.triggers.categories.includes(category);
    const svcMatch =
      rb.triggers.services.length === 0 ||
      rb.triggers.services.some((s) => services.includes(s));
    const kwMatch = rb.triggers.keywords.some((kw) =>
      keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))
    );
    return (catMatch || kwMatch) && svcMatch;
  });
}

export function resetLibraryCache(): void {
  _library = null;
}
