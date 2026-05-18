import * as path from 'path';
import { randomUUID } from 'crypto';
import { EVAL_CASES, type EvalCase } from './dataset';
import {
    log,
    pLimit,
    requireEnv,
    resolveRunId,
    resultsDir,
    writeJson,
} from './util';

interface CaseResult {
    caseId: string;
    input: string;
    output: string;
    tags: string[];
    latencyMs: number;
    firstByteMs: number;
    startedAt: string;
    finishedAt: string;
    error: string | null;
    status: number | null;
}

async function runCase(chatbotUrl: string, runId: string, c: EvalCase): Promise<CaseResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let firstByteMs = -1;
    let output = '';
    let status: number | null = null;
    let error: string | null = null;

    try {
        const body = {
            messages: [
                {
                    id: `${c.id}-msg`,
                    role: 'user',
                    parts: [{ type: 'text', text: c.input }],
                },
            ],
        };

        const res = await fetch(`${chatbotUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-eval-run-id': runId,
                'x-eval-case-id': c.id,
                'x-eval-request-id': randomUUID(),
            },
            body: JSON.stringify(body),
        });
        status = res.status;

        if (!res.ok || !res.body) {
            const text = res.body ? await res.text() : '';
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (firstByteMs < 0) firstByteMs = Date.now() - startedAtMs;
            buffer += decoder.decode(value, { stream: true });

            let sepIdx: number;
            while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
                const chunk = buffer.slice(0, sepIdx);
                buffer = buffer.slice(sepIdx + 2);
                for (const line of chunk.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]' || payload === '') continue;
                    try {
                        const event = JSON.parse(payload);
                        if (event?.type === 'text-delta' && typeof event.delta === 'string') {
                            output += event.delta;
                        }
                    } catch {
                        // ignore malformed event, the SDK can emit non-JSON keepalives
                    }
                }
            }
        }
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }

    const finishedAtMs = Date.now();
    return {
        caseId: c.id,
        input: c.input,
        output,
        tags: c.tags,
        latencyMs: finishedAtMs - startedAtMs,
        firstByteMs: firstByteMs < 0 ? 0 : firstByteMs,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        error,
        status,
    };
}

async function main(): Promise<void> {
    const chatbotUrl = requireEnv('CHATBOT_URL').replace(/\/$/, '');
    const runId = resolveRunId();
    const outDir = resultsDir(runId);
    const outFile = path.join(outDir, 'raw-responses.json');

    log('info', 'Phase 1 starting', { runId, chatbotUrl, cases: EVAL_CASES.length });

    const startedAt = new Date().toISOString();
    const results = await pLimit(3, EVAL_CASES, (c) => {
        log('info', 'Case starting', { caseId: c.id, runId });
        return runCase(chatbotUrl, runId, c).then((r) => {
            log(r.error ? 'error' : 'info', 'Case finished', {
                caseId: r.caseId,
                runId,
                latencyMs: r.latencyMs,
                firstByteMs: r.firstByteMs,
                outputLength: r.output.length,
                error: r.error,
                status: r.status,
            });
            return r;
        });
    });
    const finishedAt = new Date().toISOString();

    const succeeded = results.filter((r) => r.error === null && r.output.length > 0).length;
    const failed = results.length - succeeded;

    writeJson(outFile, {
        runId,
        startedAt,
        finishedAt,
        chatbotUrl,
        results,
    });

    log('info', 'Phase 1 complete', {
        runId,
        succeeded,
        failed,
        outFile,
        totalMs: Date.parse(finishedAt) - Date.parse(startedAt),
    });

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((e) => {
    log('error', 'Phase 1 fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
});
