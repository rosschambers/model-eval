import { describe, it, expect } from 'vitest';
import {
  MODELS_DIR,
  buildDownloadCommand,
  buildServeCommand,
  buildStopCommand,
  nextFreePort,
  serveOnFrame,
  stopOnFrame,
  waitReady,
} from './frame.js';

const noSleep = async (): Promise<void> => {};

describe('command builders', () => {
  it('MODELS_DIR is the frame models path', () => {
    expect(MODELS_DIR).toBe('/var/lib/llama-server/models');
  });

  it('buildDownloadCommand is idempotent', () => {
    expect(buildDownloadCommand('https://h/f.gguf', 'f.gguf')).toBe(
      'test -f /var/lib/llama-server/models/f.gguf || curl -fsSL -o /var/lib/llama-server/models/f.gguf "https://h/f.gguf"',
    );
  });

  it('buildServeCommand matches the README flags exactly', () => {
    expect(buildServeCommand('f.gguf', 8086)).toBe(
      "setsid bash -c 'exec llama-server --model /var/lib/llama-server/models/f.gguf --host 0.0.0.0 --port 8086 --n-gpu-layers 99 --parallel 2 --ctx-size 32768 --jinja --temp 0.7 --top-k 20 --top-p 0.8 --min-p 0.0' >/tmp/llama-8086.log 2>&1 < /dev/null &",
    );
  });

  it('buildStopCommand pkills by port', () => {
    expect(buildStopCommand(8086)).toBe('pkill -f "port 8086"');
  });
});

describe('nextFreePort', () => {
  it('returns the start port when free', () => {
    expect(nextFreePort([])).toBe(8086);
  });

  it('skips used ports', () => {
    expect(nextFreePort([8086, 8087])).toBe(8088);
  });

  it('honors a custom start', () => {
    expect(nextFreePort([9000], 9000)).toBe(9001);
  });
});

describe('serveOnFrame', () => {
  it('runs download then serve and returns the baseURL', async () => {
    const calls: string[] = [];
    const exec = async (cmd: string): Promise<string> => {
      calls.push(cmd);
      return '';
    };
    const out = await serveOnFrame({ repo: 'owner/repo', file: 'f.gguf', port: 8086 }, exec);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(
      buildDownloadCommand('https://huggingface.co/owner/repo/resolve/main/f.gguf', 'f.gguf'),
    );
    expect(calls[1]).toBe(buildServeCommand('f.gguf', 8086));
    expect(out).toEqual({ port: 8086, baseURL: 'http://frame:8086/v1' });
  });
});

describe('stopOnFrame', () => {
  it('execs the stop command', async () => {
    const calls: string[] = [];
    await stopOnFrame(8086, async (cmd) => {
      calls.push(cmd);
      return '';
    });
    expect(calls).toEqual(['pkill -f "port 8086"']);
  });
});

describe('waitReady', () => {
  it('returns true on the first 200', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    expect(await waitReady('http://frame:8086/v1', fetchImpl, 2, 0, noSleep)).toBe(true);
  });

  it('returns false when never ready within attempts', async () => {
    const fetchImpl = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await waitReady('http://frame:8086/v1', fetchImpl, 2, 0, noSleep)).toBe(false);
  });
});
