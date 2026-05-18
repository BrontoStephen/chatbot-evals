import * as fs from 'fs';
import * as path from 'path';

export function resolveRunId(): string {
    return process.env.EVAL_RUN_ID ?? `run-${Date.now()}`;
}

export function resultsDir(runId: string): string {
    const dir = path.join(process.cwd(), 'eval-results', runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v || v.length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return v;
}

export function envOrDefault(name: string, fallback: string): string {
    const v = process.env[name];
    return v && v.length > 0 ? v : fallback;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const payload = {
        level,
        timestamp: new Date().toISOString(),
        message,
        ...(data ?? {}),
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
        console.error(line);
    } else {
        console.log(line);
    }
}

export type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]): Args {
    const out: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

export async function pLimit<T, R>(
    concurrency: number,
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const run = async (): Promise<void> => {
        while (true) {
            const idx = cursor++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run);
    await Promise.all(workers);
    return results;
}

export function writeJson(filepath: string, data: unknown): void {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

export function readJson<T = unknown>(filepath: string): T {
    return JSON.parse(fs.readFileSync(filepath, 'utf8')) as T;
}

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}
