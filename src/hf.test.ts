import { describe, it, expect } from 'vitest';
import { listGgufFiles, pickQuant, resolveGguf, downloadUrl } from './hf.js';

function stubFetch(
  siblings: { rfilename: string }[],
  ok = true,
  status = 200,
): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => ({ siblings }),
  })) as unknown as typeof fetch;
}

const SIBLINGS = [
  { rfilename: 'a-Q4_K_M.gguf' },
  { rfilename: 'a-Q8_0.gguf' },
  { rfilename: 'README.md' },
];

describe('listGgufFiles', () => {
  it('returns only the .gguf filenames', async () => {
    const files = await listGgufFiles('owner/repo', undefined, stubFetch(SIBLINGS));
    expect(files).toEqual(['a-Q4_K_M.gguf', 'a-Q8_0.gguf']);
  });

  it('throws with status and repo when the response is not ok', async () => {
    await expect(
      listGgufFiles('owner/repo', undefined, stubFetch([], false, 404)),
    ).rejects.toThrow('HF API 404 for owner/repo');
  });

  it('sends an Authorization header only when a token is given', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seenHeaders = init?.headers;
      return { ok: true, status: 200, json: async () => ({ siblings: SIBLINGS }) };
    }) as unknown as typeof fetch;

    await listGgufFiles('owner/repo', 'tok', fetchImpl);
    expect(seenHeaders).toMatchObject({ Authorization: 'Bearer tok' });

    await listGgufFiles('owner/repo', undefined, fetchImpl);
    expect(seenHeaders).toEqual({});
  });
});

describe('pickQuant', () => {
  it('picks the preferred quant (case-insensitive)', () => {
    expect(pickQuant(['a-q4_k_m.gguf', 'a-Q8_0.gguf'])).toBe('a-q4_k_m.gguf');
  });

  it('falls back to the first gguf when the preferred quant is absent', () => {
    expect(pickQuant(['a-Q8_0.gguf', 'b-Q5_K.gguf'])).toBe('a-Q8_0.gguf');
  });

  it('throws when there are no files', () => {
    expect(() => pickQuant([])).toThrow('no GGUF found in repo');
  });
});

describe('resolveGguf', () => {
  it('picks a quant when no explicit file is given', async () => {
    const out = await resolveGguf('owner/repo', undefined, stubFetch(SIBLINGS));
    expect(out).toEqual({ repo: 'owner/repo', file: 'a-Q4_K_M.gguf' });
  });

  it('uses an explicit file when present in the listing', async () => {
    const out = await resolveGguf('owner/repo:a-Q8_0.gguf', undefined, stubFetch(SIBLINGS));
    expect(out).toEqual({ repo: 'owner/repo', file: 'a-Q8_0.gguf' });
  });

  it('throws when the explicit file is not in the listing', async () => {
    await expect(
      resolveGguf('owner/repo:missing.gguf', undefined, stubFetch(SIBLINGS)),
    ).rejects.toThrow('missing.gguf not found in owner/repo');
  });
});

describe('downloadUrl', () => {
  it('builds the resolve/main url', () => {
    expect(downloadUrl('owner/repo', 'a-Q4_K_M.gguf')).toBe(
      'https://huggingface.co/owner/repo/resolve/main/a-Q4_K_M.gguf',
    );
  });
});
