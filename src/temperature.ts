/**
 * Parse and validate the `--temperature` flag. Undefined when the flag is
 * absent, so the caller sends no `temperature` field and the server default
 * applies (current behavior). Throws loudly for a non-finite value or one
 * outside the valid range [0, 2].
 */
export function parseTemperature(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error(`--temperature must be a finite number between 0 and 2, got '${raw}'`);
  }
  return value;
}

