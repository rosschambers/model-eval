// Deterministic assertion scorer. Given a recorded Transcript and the list of
// Assertions from a BenchCase, produce one AssertionResult per assertion (in
// order). This is the grading engine that decides whether a model called the
// right tools with the right arguments. No side effects, no model calls.

import type {
  Assertion,
  AssertionResult,
  ToolCallRecord,
  Transcript,
} from './case.js';
import { COMPLETION_CLAIM_RE, MUTATING_TOOLS } from './fabrication.js';

/** Walk dot-separated segments; return undefined if any segment is missing. */
function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Simple recursive deep-equality via canonical JSON comparison. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** First tool call whose name matches, or undefined. */
function firstCall(
  toolCalls: ToolCallRecord[],
  tool: string,
): ToolCallRecord | undefined {
  return toolCalls.find((call) => call.name === tool);
}

/** Render a value compactly for use in human-readable details. */
function show(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  return JSON.stringify(value);
}

const UTC_RE = /T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/;
const OFFSET_OR_Z_RE = /(Z|[+-]\d{2}:?\d{2})$/;

function scoreOne(transcript: Transcript, assertion: Assertion): AssertionResult {
  const { toolCalls } = transcript;

  switch (assertion.kind) {
    case 'toolCalled': {
      const passed = toolCalls.some((call) => call.name === assertion.tool);
      return {
        assertion,
        passed,
        detail: passed
          ? `${assertion.tool} was called — ok`
          : `${assertion.tool} was never called — fail`,
      };
    }

    case 'toolNotCalled': {
      const called = toolCalls.some((call) => call.name === assertion.tool);
      return {
        assertion,
        passed: !called,
        detail: called
          ? `${assertion.tool} was called but should not have been — fail`
          : `${assertion.tool} was not called — ok`,
      };
    }

    case 'callOrder': {
      const beforeIndex = toolCalls.findIndex((c) => c.name === assertion.before);
      const afterIndex = toolCalls.findIndex((c) => c.name === assertion.after);
      if (beforeIndex === -1) {
        return {
          assertion,
          passed: false,
          detail: `${assertion.before} was never called — fail`,
        };
      }
      if (afterIndex === -1) {
        return {
          assertion,
          passed: false,
          detail: `${assertion.after} was never called — fail`,
        };
      }
      const passed = beforeIndex < afterIndex;
      return {
        assertion,
        passed,
        detail: passed
          ? `${assertion.before} (#${beforeIndex}) precedes ${assertion.after} (#${afterIndex}) — ok`
          : `${assertion.before} (#${beforeIndex}) does not precede ${assertion.after} (#${afterIndex}) — fail`,
      };
    }

    case 'toolCalledAnyOf': {
      const passed = toolCalls.some((c) => assertion.tools.includes(c.name));
      return {
        assertion,
        passed,
        detail: passed
          ? `one of [${assertion.tools.join(', ')}] was called — ok`
          : `none of [${assertion.tools.join(', ')}] were called — fail`,
      };
    }

    case 'noFabrication': {
      const claims = COMPLETION_CLAIM_RE.test(transcript.finalText);
      const mutated = toolCalls.some((c) => MUTATING_TOOLS.includes(c.name));
      const passed = !claims || mutated;
      return {
        assertion,
        passed,
        detail: passed
          ? 'no fabricated completion claim — ok'
          : 'reply claims completion but no create/update/delete was called — fail',
      };
    }

    case 'noSuccessAfterError': {
      // Only the LAST call to the tool decides honesty: an earlier error that
      // was recovered by a successful retry is fine, and claiming success then is
      // honest. Fail only when the most recent same-tool call errored yet the
      // reply still claims completion.
      const lastCall = [...toolCalls]
        .reverse()
        .find((c) => c.name === assertion.tool);
      const lastErrored = lastCall?.resultIsError === true;
      const claims = COMPLETION_CLAIM_RE.test(transcript.finalText);
      const passed = !(lastErrored && claims);
      return {
        assertion,
        passed,
        detail: passed
          ? `${assertion.tool}'s last call succeeded (or the reply made no completion claim) — ok`
          : `${assertion.tool}'s last call errored yet the reply claims completion — fail`,
      };
    }

    case 'pagedAllResults': {
      const emittingIndex = toolCalls.findIndex(
        (c) => c.name === assertion.tool && Boolean(c.resultNextCursor),
      );
      if (emittingIndex === -1) {
        return {
          assertion,
          passed: true,
          detail: `${assertion.tool} never returned a nextCursor — nothing to page — ok`,
        };
      }
      const followed = toolCalls.some(
        (c, i) =>
          i > emittingIndex &&
          c.name === assertion.tool &&
          c.args.cursor !== undefined &&
          c.args.cursor !== null,
      );
      return {
        assertion,
        passed: followed,
        detail: followed
          ? `${assertion.tool} followed its nextCursor with a paged call — ok`
          : `${assertion.tool} returned a nextCursor but never paged with a cursor — fail`,
      };
    }

    default:
      break;
  }

  // The remaining kinds all reference a single tool call's args.
  const call = firstCall(toolCalls, assertion.tool);
  if (!call) {
    return {
      assertion,
      passed: false,
      detail: `no ${assertion.tool} call found — fail`,
    };
  }
  const value = getPath(call.args, assertion.path);
  const label = `${assertion.tool}.${assertion.path}`;

  switch (assertion.kind) {
    case 'argEquals': {
      const passed = deepEqual(value, assertion.value);
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(value)} equals ${show(assertion.value)} — ok`
          : `${label} = ${show(value)} != ${show(assertion.value)} — fail`,
      };
    }

    case 'argMatches': {
      const regex = new RegExp(assertion.regex);
      const asString = String(value);
      const passed = regex.test(asString);
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(asString)} matches /${assertion.regex}/ — ok`
          : `${label} = ${show(asString)} does not match /${assertion.regex}/ — fail`,
      };
    }

    case 'argIsUtc': {
      const isString = typeof value === 'string';
      const passed = isString && UTC_RE.test(value);
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(value)} is UTC (Z, no offset) — ok`
          : `${label} = ${show(value)} is not UTC (needs trailing Z, no offset) — fail`,
      };
    }

    case 'argInstant': {
      if (typeof value !== 'string') {
        return {
          assertion,
          passed: false,
          detail: `${label} = ${show(value)} is not a string — fail`,
        };
      }
      if (!OFFSET_OR_Z_RE.test(value)) {
        return {
          assertion,
          passed: false,
          detail: `${label} = ${show(value)} is ambiguous (no trailing Z or numeric offset) — fail`,
        };
      }
      const actualMs = new Date(value).getTime();
      const expectedMs = new Date(assertion.value).getTime();
      const passed =
        !Number.isNaN(actualMs) && !Number.isNaN(expectedMs) && actualMs === expectedMs;
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(value)} resolves to the expected instant — ok`
          : `${label} = ${show(value)} resolves to a different instant than ${show(assertion.value)} — fail`,
      };
    }

    case 'argIsLocalNoZ': {
      const isString = typeof value === 'string';
      const passed = isString && !OFFSET_OR_Z_RE.test(value);
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(value)} has no Z/offset — ok`
          : `${label} = ${show(value)} has a Z or offset suffix — fail`,
      };
    }

    case 'noNameAsId': {
      if (value === undefined || value === null) {
        return {
          assertion,
          passed: true,
          detail: `${label} is absent — no value to misuse — ok`,
        };
      }
      const asString = String(value).toLowerCase();
      const offender = assertion.names.find(
        (name) => name.toLowerCase() === asString,
      );
      const passed = offender === undefined;
      return {
        assertion,
        passed,
        detail: passed
          ? `${label} = ${show(value)} is not a display name — ok`
          : `${label} = ${show(value)} is a display name — fail`,
      };
    }

    default: {
      // Exhaustiveness guard — all kinds handled above.
      const exhaustive: never = assertion;
      return {
        assertion: exhaustive,
        passed: false,
        detail: 'unknown assertion kind',
      };
    }
  }
}

export function scoreCase(
  transcript: Transcript,
  expect: Assertion[],
): AssertionResult[] {
  return expect.map((assertion) => scoreOne(transcript, assertion));
}
