// Frame serve orchestration. Pure command-builders (unit-tested as exact
// strings) plus thin orchestrators whose side effects — the SSH `exec` runner
// and the readiness `fetch` — are injected so tests never touch frame or the
// network. The real `exec` (used only by the CLI's main) wraps `ssh <host>`.

import { downloadUrl } from './hf.js';

export const MODELS_DIR = '/var/lib/llama-server/models';

function sshHost(): string {
  return process.env.FRAME_SSH_HOST ?? 'frame';
}

/** Idempotent download: skip the curl when the GGUF is already on frame. */
export function buildDownloadCommand(url: string, file: string): string {
  const dest = `${MODELS_DIR}/${file}`;
  return `test -f ${dest} || curl -fsSL -o ${dest} "${url}"`;
}

/** The llama-server launch line, matching the README flags exactly. */
export function buildServeCommand(file: string, port: number): string {
  return (
    `setsid bash -c 'exec llama-server --model ${MODELS_DIR}/${file} ` +
    `--host 0.0.0.0 --port ${port} --n-gpu-layers 99 --parallel 2 --ctx-size 32768 ` +
    `--jinja --temp 0.7 --top-k 20 --top-p 0.8 --min-p 0.0' ` +
    `>/tmp/llama-${port}.log 2>&1 < /dev/null &`
  );
}

/** Simple stop: kill the llama-server instance bound to the given port. */
export function buildStopCommand(port: number): string {
  return `pkill -f "port ${port}"`;
}

/** Lowest free integer port >= start that is not in usedPorts. */
export function nextFreePort(usedPorts: number[], start = 8086): number {
  let port = start;
  while (usedPorts.includes(port)) port += 1;
  return port;
}

type Exec = (cmd: string) => Promise<string>;

/**
 * Download (if needed) and launch the model on frame via the injected exec
 * runner. Returns the chosen port and the OpenAI-compatible base URL.
 */
export async function serveOnFrame(
  { repo, file, port }: { repo?: string; file: string; port: number },
  exec: Exec,
): Promise<{ port: number; baseURL: string }> {
  const url = downloadUrl(repo ?? '', file);
  await exec(buildDownloadCommand(url, file));
  await exec(buildServeCommand(file, port));
  return { port, baseURL: `http://${sshHost()}:${port}/v1` };
}

export async function stopOnFrame(port: number, exec: Exec): Promise<void> {
  await exec(buildStopCommand(port));
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `<baseURL>/models` until it answers 200 or attempts run out. The fetch
 * and the inter-attempt sleep are injected so tests resolve instantly.
 */
export async function waitReady(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
  attempts = 30,
  sleepMs = 2000,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${baseURL}/models`);
      if (res.ok) return true;
    } catch {
      // not up yet — fall through to the sleep and retry
    }
    if (attempt < attempts - 1) await sleep(sleepMs);
  }
  return false;
}
