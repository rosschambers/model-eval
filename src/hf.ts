// HuggingFace GGUF resolver. Looks up a model repo's GGUF siblings via the HF
// API, picks a quant, and builds a download URL. The network call is injected
// (fetchImpl) so unit tests never touch the internet.

/**
 * List the `.gguf` sibling filenames for a HuggingFace model repo. Sends an
 * `Authorization: Bearer <token>` header only when a token is given. Throws
 * `HF API <status> for <repo>` on a non-ok response.
 */
export async function listGgufFiles(
  repo: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`https://huggingface.co/api/models/${repo}`, { headers });
  if (!res.ok) throw new Error(`HF API ${res.status} for ${repo}`);
  const data = (await res.json()) as { siblings?: { rfilename: string }[] };
  return (data.siblings ?? []).map((s) => s.rfilename).filter((f) => f.endsWith('.gguf'));
}

/**
 * Choose a GGUF file. Returns the first file whose name includes the preferred
 * quant (case-insensitive), else the first file. Throws when there are none.
 */
export function pickQuant(files: string[], preferred = 'Q4_K_M'): string {
  if (files.length === 0) throw new Error('no GGUF found in repo');
  const match = files.find((f) => f.toLowerCase().includes(preferred.toLowerCase()));
  return match ?? files[0];
}

/**
 * Resolve a spec of the form `repo` or `repo:file` into `{ repo, file }`. With
 * an explicit file, validate it exists in the listing. Otherwise pick a quant.
 */
export async function resolveGguf(
  spec: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ repo: string; file: string }> {
  const sep = spec.indexOf(':');
  const repo = sep === -1 ? spec : spec.slice(0, sep);
  const explicit = sep === -1 ? undefined : spec.slice(sep + 1);
  const files = await listGgufFiles(repo, token, fetchImpl);
  if (explicit) {
    if (!files.includes(explicit)) throw new Error(`${explicit} not found in ${repo}`);
    return { repo, file: explicit };
  }
  return { repo, file: pickQuant(files) };
}

export function downloadUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
