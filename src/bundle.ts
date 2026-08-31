// judging-bundle.md emitter. Lays out one section per non-error record (profile,
// model, caseId, the case's replyRubric, and the model's final reply) for the
// downstream reply-quality judging pass, and lists errored records separately.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AgentProfile } from './profile.js';
import type { BenchCase } from './case.js';
import type { RawRecord } from './run.js';

function fileInDir(dir: URL | string, name: string): URL {
  if (typeof dir === 'string') {
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return new URL(name, pathToFileURL(base));
  }
  return new URL(name, dir);
}

/** profileId -> (caseId -> case), for rubric lookup. */
function caseIndex(profiles: AgentProfile[]): Map<string, Map<string, BenchCase>> {
  const index = new Map<string, Map<string, BenchCase>>();
  for (const profile of profiles) {
    const byId = new Map<string, BenchCase>();
    for (const c of profile.cases) byId.set(c.id, c);
    index.set(profile.id, byId);
  }
  return index;
}

export function buildBundle(records: RawRecord[], profiles: AgentProfile[]): string {
  const index = caseIndex(profiles);
  const lines: string[] = ['# Judging Bundle', ''];

  const ok = records.filter((r) => !r.error);
  const errored = records.filter((r) => r.error);

  for (const record of ok) {
    const rubric = index.get(record.profile)?.get(record.caseId)?.replyRubric ?? '(no rubric)';
    lines.push(`## ${record.profile} / ${record.model} / ${record.caseId}`);
    lines.push('');
    lines.push(`**Rubric:** ${rubric}`);
    lines.push('');
    lines.push('**Reply:**');
    lines.push('');
    lines.push(record.transcript?.finalText ?? '');
    lines.push('');
  }

  if (errored.length > 0) {
    lines.push('## Skipped (errored)');
    lines.push('');
    for (const record of errored) {
      lines.push(`- ${record.profile} / ${record.model} / ${record.caseId}: ${record.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeBundle(dir: URL | string, records: RawRecord[], profiles: AgentProfile[]): void {
  writeFileSync(fileInDir(dir, 'judging-bundle.md'), buildBundle(records, profiles), 'utf8');
}
