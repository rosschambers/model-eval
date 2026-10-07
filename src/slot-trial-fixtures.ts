// Source-checked short P1 slice, not portal or decision qualification.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrialRequest } from './slot-trial.js';

// Reviewed production renderers and schema sources. Drift requires review, not silent reuse.
const sourceFingerprints: Record<string, string> = {
  'src/Murmur8.Infrastructure/AI/TitleGeneration/LocalLlmTitleGenerationService.cs': 'e2860b441f5eea48df2629ae618654a42b6cff44aa803e9dc090285685cf7ee2',
  'src/Murmur8.Infrastructure/AI/TitleGeneration/LocalLlmTitleGenerationServiceBase.cs': '04305625103f8e5abe71ce7e1c09567868889779f4a1d8e0b5d6b8d6b6fc24bd',
  'src/Murmur8.Infrastructure/AI/AssistantStep/LocalLlmAssistantFillService.cs': '369c909d2cce0fc0a2fff101d8486a45e42483d13d10bdb4f8bd953aa7cb50be',
  'src/Murmur8.Infrastructure/AI/AssistantStep/IAssistantFillService.cs': 'd583e02ac420740a3188ce365270c740542bde81e6d76d87449121224552014c',
  'src/Murmur8.Application/AI/AssistantStep/AssistantStepFill.cs': 'fe99084233429087f34ab70eaa44b198d600e441b0e30a3a0578cf4e8335ebb3',
  'src/Murmur8.Application/AI/AssistantStep/AssistantStepHints.cs': '925d076edfe49bed173d68d53122434346b4ee09161e4104a4ad5fa5b16bb533',
  'src/Murmur8.Application/AI/AssistantStep/AssistantTime.cs': 'd2eedce398cb257b35f08637a76ca228e9f2345012b04db687318b279438c554',
  'src/Murmur8.Application/AI/Tools/CreateTool.cs': '13c8eb4a10e2f811281ee8611e02f4f9cdb1026f381c7bddb6be272f2ebbca13',
};

export function buildP1Fixtures(sourceRoot: string): { requests: TrialRequest[]; evidence: Record<string, unknown> } {
  for (const [path, expected] of Object.entries(sourceFingerprints)) {
    const actual = createHash('sha256').update(readFileSync(join(sourceRoot, path))).digest('hex');
    if (actual !== expected) throw new Error(`P1 fixture source drift: ${path}; review the fixture before updating its fingerprint`);
  }
  const promptPath = 'src/Murmur8.Infrastructure/AI/ai-prompts.json';
  const promptSource = readFileSync(join(sourceRoot, promptPath), 'utf8');
  const titlePrompt: unknown = JSON.parse(promptSource).AI?.TitleGenerationPrompt;
  if (typeof titlePrompt !== 'string' || !titlePrompt.trim()) throw new Error('current title prompt is missing');
  const instructions = "You fill in fields for a reminder from the user's message. "
    + "Write times as local wall-clock time in the user's time zone, formatted YYYY-MM-DDTHH:MM. "
    + 'Use the Now line and the Next 7 days table for dates; never work out weekdays yourself. '
    + 'Keep am and pm as written: 11pm is 23:00, 11am is 11:00. '
    + 'A time with no day means the next time it comes after Now. '
    + 'Output compact JSON on one line. The title is what to be reminded of, short, without the time ("Move the couch").';
  const context = 'Now: Wednesday 2026-10-07 10:00 (America/New_York)\n'
    + 'Next 7 days: Wednesday 2026-10-07 (today), Thursday 2026-10-08 (tomorrow), Friday 2026-10-09, Saturday 2026-10-10, Sunday 2026-10-11, Monday 2026-10-12, Tuesday 2026-10-13\n';
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      remindAtLocal: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]$' },
    },
    required: ['title', 'remindAtLocal'], additionalProperties: false,
  };
  const requests: TrialRequest[] = [];
  const conversations = [
    ['Can you help plan a vegetable garden?', 'Start with tomatoes, beans and lettuce in a sunny bed.'],
    ['What should I pack for a weekend hike?', 'Bring water, snacks, a rain jacket and a first aid kit.'],
  ];
  const reminders = [
    ['Remind me to water plants today at 4pm', 'Water plants', '2026-10-07T16:00'],
    ['Remind me to pack lunch tomorrow at 8am', 'Pack lunch', '2026-10-08T08:00'],
  ];
  for (let index = 0; index < conversations.length; index += 1) {
    requests.push({
      requestIdentifier: `title-${index + 1}-seed`, workload: 'title', cacheState: 'unverified',
      messages: [{ role: 'system', content: titlePrompt }, { role: 'user', content: `User: ${conversations[index][0]}\n\nAssistant: ${conversations[index][1]}` }],
      foreignMarkers: [], maxOutputTokens: 50, temperature: 0.3, seed: 42,
    });
    requests.push({
      requestIdentifier: `fill-${index + 1}-seed`, workload: 'fill', cacheState: 'unverified',
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: `${context}Message: ${reminders[index][0]}` }],
      foreignMarkers: [], maxOutputTokens: 80, temperature: 0, seed: 42,
      responseFormat: { type: 'json_schema', json_schema: { name: 'create_reminder', schema } },
      expectedJson: { title: reminders[index][1], remindAtLocal: reminders[index][2] },
    });
  }
  const repeats = structuredClone(requests).map((request) => ({ ...request, requestIdentifier: request.requestIdentifier.replace('-seed', '-repeat'), cacheState: 'warm' as const }));
  return {
    requests: [...requests, ...repeats],
    evidence: {
      sourceFingerprints: { ...sourceFingerprints, [promptPath]: createHash('sha256').update(promptSource).digest('hex') },
      scope: 'Eight synthetic, single-turn title/reminder-fill requests. No portal, real tools, decision calls or private data.',
      limitations: 'Production title/fill use nonstreaming responses; this trial intentionally streams for delta timing. Seed requests have unverified cache state. Repeats intend warm prefixes; missing usage cannot prove hits. Fixed seed is trial instrumentation. This short slice does not fill the host cache or qualify its full budget.',
    },
  };
}
