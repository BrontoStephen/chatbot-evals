import * as fs from 'fs';
import * as path from 'path';
import { EVAL_CASES } from './dataset';
import {
    envOrDefault,
    log,
    parseArgs,
    readJson,
    requireEnv,
    resultsDir,
    writeJson,
} from './util';

interface RawRow {
    caseId: string;
    input: string;
    output: string;
    tags: string[];
    latencyMs: number;
    firstByteMs: number;
    error: string | null;
    inputTokens?: number;
    outputTokens?: number;
}

interface ScoreRecord {
    eval_run_id: string;
    eval_case_id: string;
    eval_tags: string[];
    eval_passed: boolean;
    eval_overall_score: number;
    eval_score_correctness: number;
    eval_score_completeness: number;
    eval_score_clarity: number;
    eval_judge_rationale: string;
    eval_source: 'bronto' | 'local';
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    output_preview: string;
    error: string | null;
}

const JUDGE_MODEL = 'claude-sonnet-4-20250514';

const JUDGE_SYSTEM = [
    'You are a strict LLM-output judge. You are given a Question, the Criteria a correct answer must satisfy, and an Answer produced by another model.',
    'Score the Answer on three dimensions, each on an integer 1-5 scale:',
    '- correctness: factual accuracy and absence of misleading statements (1=wrong, 5=fully correct).',
    '- completeness: how much of the Criteria the Answer covers (1=missing most, 5=covers all key points).',
    '- clarity: how readable and well-organized the answer is (1=confusing, 5=very clear).',
    'Return STRICT JSON ONLY (no prose, no markdown fences) with exactly these keys:',
    '{"correctness":<1-5>,"completeness":<1-5>,"clarity":<1-5>,"rationale":"<one or two sentences>"}',
].join('\n');

async function judge(input: string, criteria: string, answer: string): Promise<{
    correctness: number;
    completeness: number;
    clarity: number;
    rationale: string;
}> {
    const apiKey = requireEnv('ANTHROPIC_API_KEY');
    const userMsg = `Question:\n${input}\n\nCriteria:\n${criteria}\n\nAnswer:\n${answer || '(empty answer)'}`;

    let res: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: JUDGE_MODEL,
                max_tokens: 512,
                system: JUDGE_SYSTEM,
                messages: [{ role: 'user', content: userMsg }],
            }),
        });
        if (res.status !== 429) break;
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const delaySec = retryAfter > 0 ? retryAfter : Math.min(60, 8 * Math.pow(2, attempt));
        log('warn', 'Anthropic 429, backing off', { attempt, delaySec });
        await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
    if (!res || !res.ok) {
        const text = res ? await res.text() : '';
        throw new Error(`Anthropic API ${res?.status ?? 'no-response'}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = (data.content ?? []).find((b) => b.type === 'text');
    const raw = textBlock?.text ?? '';

    const match = raw.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : raw;
    const parsed = JSON.parse(jsonStr) as {
        correctness: number;
        completeness: number;
        clarity: number;
        rationale: string;
    };
    return {
        correctness: clamp(parsed.correctness),
        completeness: clamp(parsed.completeness),
        clarity: clamp(parsed.clarity),
        rationale: String(parsed.rationale ?? ''),
    };
}

function clamp(n: unknown): number {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return 1;
    return Math.max(1, Math.min(5, x));
}

async function fetchFromBronto(runId: string): Promise<RawRow[]> {
    const mode = envOrDefault('BRONTO_SOURCE', 'traces').toLowerCase();
    if (mode === 'traces') return fetchFromTraces(runId);
    return fetchFromLogs(runId);
}

// Query the .traces collection where streamText's experimental_telemetry
// lands one ai.streamText span per request with the prompt, response text,
// usage tokens, and our eval metadata as typed attributes.
async function fetchFromTraces(runId: string): Promise<RawRow[]> {
    const apiKey = requireEnv('BRONTO_API_KEY');
    const region = envOrDefault('BRONTO_REGION', 'eu').toLowerCase();
    const tracesDataset = envOrDefault('BRONTO_TRACES_DATASET', 'vercel-ai-demo');
    const tracesCollection = envOrDefault('BRONTO_TRACES_COLLECTION', '.traces');

    const url = `https://api.${region}.bronto.io/search`;
    const body = {
        from_expr: `dataset = '${tracesDataset}' AND collection = '${tracesCollection}'`,
        time_range: 'Last 1 hour',
        select: ['*'],
        where: `"$span.name"='ai.streamText' AND "$ai.telemetry.metadata.eval_run_id"='${runId}'`,
        limit: 100,
        most_recent_first: true,
    };

    log('info', 'Querying Bronto traces', { url, runId, tracesDataset, tracesCollection });

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BRONTO-API-KEY': apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bronto search ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const data = (await res.json()) as { events?: Array<{ attributes?: Record<string, unknown> }> };
    const events = data.events ?? [];
    log('info', 'Bronto trace events returned', { count: events.length });

    const byCase = new Map<string, RawRow>();
    for (const ev of events) {
        const a = ev.attributes ?? {};
        const caseId = String(a['$ai.telemetry.metadata.eval_case_id'] ?? '');
        if (!caseId) continue;
        const output = String(a['$ai.response.text'] ?? '');
        const input = extractPromptText(a['$ai.prompt']);
        const inputTokens = Number(a['$ai.usage.inputTokens'] ?? 0);
        const outputTokens = Number(a['$ai.usage.outputTokens'] ?? 0);
        const durNano = Number(a['$span.duration_nano'] ?? 0);
        const latencyMs = durNano > 0 ? Math.round(durNano / 1_000_000) : 0;
        const existing = byCase.get(caseId);
        if (!existing || (output && !existing.output)) {
            byCase.set(caseId, {
                caseId,
                input,
                output,
                tags: EVAL_CASES.find((c) => c.id === caseId)?.tags ?? [],
                latencyMs,
                firstByteMs: 0,
                error: null,
                inputTokens,
                outputTokens,
            });
        }
    }
    return Array.from(byCase.values());
}

// Legacy Log Drain path (vercel/chatbot dataset, @raw LIKE matches).
// Kept as a fallback for environments without a traces drain.
async function fetchFromLogs(runId: string): Promise<RawRow[]> {
    const apiKey = requireEnv('BRONTO_API_KEY');
    const region = envOrDefault('BRONTO_REGION', 'eu').toLowerCase();
    const dataset = requireEnv('BRONTO_DATASET');
    const collection = requireEnv('BRONTO_COLLECTION');

    const url = `https://api.${region}.bronto.io/search`;
    const body = {
        from_expr: `dataset = '${dataset}' AND collection = '${collection}'`,
        time_range: 'Last 1 hour',
        select: ['@raw', '@time'],
        where: `@raw LIKE '%${runId}%' AND @raw LIKE '%AI request completed%'`,
        limit: 100,
        most_recent_first: true,
    };

    log('info', 'Querying Bronto logs (fallback)', { url, runId, dataset });

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BRONTO-API-KEY': apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bronto search ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const data = (await res.json()) as { events?: Array<{ '@raw'?: string }> };
    const events = data.events ?? [];
    log('info', 'Bronto log events returned', { count: events.length });

    const byCase = new Map<string, RawRow>();
    for (const ev of events) {
        const inner = parseVercelLog(ev['@raw']);
        if (!inner) continue;
        const d = (inner.data ?? {}) as Record<string, unknown>;
        const caseId = String(d['eval_case_id'] ?? d['x-eval-case-id'] ?? '');
        if (!caseId) continue;
        const output = String(d['ai.output.text'] ?? d['aiOutputText'] ?? '');
        const input = extractInputText(d['ai.prompt.messages']);
        const inputTokens = Number(d['aiUsagePromptTokens'] ?? d['ai.usage.prompt_tokens'] ?? 0);
        const outputTokens = Number(d['aiUsageCompletionTokens'] ?? d['ai.usage.completion_tokens'] ?? 0);
        const existing = byCase.get(caseId);
        if (!existing || (output && !existing.output)) {
            byCase.set(caseId, {
                caseId,
                input,
                output,
                tags: EVAL_CASES.find((c) => c.id === caseId)?.tags ?? [],
                latencyMs: 0,
                firstByteMs: 0,
                error: null,
                inputTokens,
                outputTokens,
            });
        }
    }
    return Array.from(byCase.values());
}

function parseVercelLog(raw: string | undefined): { message?: string; data?: unknown } | null {
    if (!raw) return null;
    try {
        const envelope = JSON.parse(raw) as { message?: string };
        if (!envelope.message) return null;
        const inner = JSON.parse(envelope.message) as { message?: string; data?: unknown };
        return inner;
    } catch {
        return null;
    }
}

function extractPromptText(raw: unknown): string {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw) as { messages?: unknown };
            return extractInputText(parsed.messages);
        } catch {
            return raw;
        }
    }
    return extractInputText(raw);
}

function extractOutputText(raw: unknown): string {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return extractOutputText(parsed);
        } catch {
            return raw;
        }
    }
    if (Array.isArray(raw)) {
        return raw.map((m) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
                const content = (m as { content?: unknown }).content;
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    return content
                        .map((part) => {
                            if (typeof part === 'string') return part;
                            if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                                return (part as { text: string }).text;
                            }
                            return '';
                        })
                        .join('');
                }
            }
            return '';
        }).join('\n');
    }
    return '';
}

function extractInputText(raw: unknown): string {
    return extractOutputText(raw);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const runId = (typeof args.run === 'string' && args.run) || process.env.EVAL_RUN_ID;
    if (!runId) {
        throw new Error('Missing --run <run-id> argument (or EVAL_RUN_ID env)');
    }
    const source = (typeof args.source === 'string' ? args.source : 'bronto') as 'bronto' | 'local';
    const outDir = resultsDir(runId);
    const localFile = path.join(outDir, 'raw-responses.json');
    const scoresFile = path.join(outDir, 'scores.json');

    log('info', 'Phase 2 starting', { runId, source });

    let rows: RawRow[] = [];
    let resolvedSource: 'bronto' | 'local' = source;

    if (source === 'bronto') {
        try {
            rows = await fetchFromBronto(runId);
            if (rows.length === 0) {
                log('warn', 'Bronto returned 0 events, falling back to local', { runId });
                resolvedSource = 'local';
            }
        } catch (e) {
            log('warn', 'Bronto fetch failed, falling back to local', {
                error: e instanceof Error ? e.message : String(e),
            });
            resolvedSource = 'local';
        }
    }

    if (resolvedSource === 'local') {
        if (!fs.existsSync(localFile)) {
            throw new Error(`No raw-responses.json at ${localFile} and Bronto returned nothing.`);
        }
        const raw = readJson<{ results: RawRow[] }>(localFile);
        rows = raw.results;
    }

    log('info', 'Scoring rows', { count: rows.length, source: resolvedSource });

    // Anthropic rate limit on claude-sonnet-4-20250514 is ~5 req/min, so pace.
    const PACER_MS = 13_000;
    let lastJudgeAt = 0;

    const scores: ScoreRecord[] = [];
    for (const row of rows) {
        const c = EVAL_CASES.find((x) => x.id === row.caseId);
        if (!c) {
            log('warn', 'Skipping unknown case', { caseId: row.caseId });
            continue;
        }
        let scoreRec: ScoreRecord;
        try {
            if (row.error) {
                scoreRec = makeFailedRecord(runId, c.id, row, resolvedSource, `Run error: ${row.error}`);
            } else if (!row.output || row.output.trim().length === 0) {
                scoreRec = makeFailedRecord(runId, c.id, row, resolvedSource, 'Empty output');
            } else {
                const sinceLast = Date.now() - lastJudgeAt;
                if (lastJudgeAt > 0 && sinceLast < PACER_MS) {
                    await new Promise((r) => setTimeout(r, PACER_MS - sinceLast));
                }
                lastJudgeAt = Date.now();
                const j = await judge(row.input || c.input, c.criteria, row.output);
                const overall = Math.round((j.correctness + j.completeness + j.clarity) / 3);
                scoreRec = {
                    eval_run_id: runId,
                    eval_case_id: c.id,
                    eval_tags: c.tags,
                    eval_passed: overall >= 4,
                    eval_overall_score: overall,
                    eval_score_correctness: j.correctness,
                    eval_score_completeness: j.completeness,
                    eval_score_clarity: j.clarity,
                    eval_judge_rationale: j.rationale,
                    eval_source: resolvedSource,
                    input_tokens: row.inputTokens ?? 0,
                    output_tokens: row.outputTokens ?? 0,
                    latency_ms: row.latencyMs,
                    output_preview: row.output.slice(0, 280),
                    error: row.error,
                };
            }
        } catch (e) {
            scoreRec = makeFailedRecord(
                runId,
                c.id,
                row,
                resolvedSource,
                `Judge error: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        scores.push(scoreRec);
        log('info', 'Case scored', {
            caseId: scoreRec.eval_case_id,
            overall: scoreRec.eval_overall_score,
            passed: scoreRec.eval_passed,
        });
    }

    const ingestStatus = await writeScoresToBronto(runId, scores);

    writeJson(scoresFile, {
        meta: {
            runId,
            source: resolvedSource,
            count: scores.length,
            generatedAt: new Date().toISOString(),
            judgeModel: JUDGE_MODEL,
            ingestStatus,
        },
        scores,
    });

    const passed = scores.filter((s) => s.eval_passed).length;
    log('info', 'Phase 2 complete', {
        runId,
        scored: scores.length,
        passed,
        failed: scores.length - passed,
        scoresFile,
    });
}

function makeFailedRecord(
    runId: string,
    caseId: string,
    row: RawRow,
    source: 'bronto' | 'local',
    rationale: string,
): ScoreRecord {
    return {
        eval_run_id: runId,
        eval_case_id: caseId,
        eval_tags: row.tags,
        eval_passed: false,
        eval_overall_score: 1,
        eval_score_correctness: 1,
        eval_score_completeness: 1,
        eval_score_clarity: 1,
        eval_judge_rationale: rationale,
        eval_source: source,
        input_tokens: row.inputTokens ?? 0,
        output_tokens: row.outputTokens ?? 0,
        latency_ms: row.latencyMs,
        output_preview: (row.output ?? '').slice(0, 280),
        error: row.error ?? rationale,
    };
}

async function writeScoresToBronto(
    runId: string,
    scores: ScoreRecord[],
): Promise<{ ok: boolean; status: number; body?: string; skipped?: string }> {
    const apiKey = process.env.BRONTO_API_KEY;
    if (!apiKey) return { ok: false, status: 0, skipped: 'BRONTO_API_KEY not set' };
    const region = envOrDefault('BRONTO_REGION', 'eu').toLowerCase();
    const dataset = process.env.BRONTO_DATASET;
    const collection = process.env.BRONTO_COLLECTION;
    if (!dataset || !collection) {
        return { ok: false, status: 0, skipped: 'BRONTO_DATASET/COLLECTION not set' };
    }

    // Per https://docs.bronto.io/getting-started/bronto-endpoints.md the base
    // ingestion endpoint takes NDJSON with a top-level `message` field and
    // `x-bronto-dataset` / `x-bronto-collection` headers for routing.
    const url = `https://ingestion.${region}.bronto.io/`;
    const lines = scores.map((s) =>
        JSON.stringify({
            message: `llm_eval_score run=${s.eval_run_id} case=${s.eval_case_id} passed=${s.eval_passed} overall=${s.eval_overall_score}`,
            timestamp: new Date().toISOString(),
            event_type: 'llm_eval_score',
            ...s,
        }),
    );
    const body = lines.join('\n');

    log('info', 'Writing scores to Bronto ingestion', { url, count: scores.length, dataset, collection, runId });
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-ndjson',
                'x-bronto-api-key': apiKey,
                'x-bronto-dataset': dataset,
                'x-bronto-collection': collection,
                'x-bronto-tags': `eval_run_id=${runId}`,
            },
            body,
        });
        const text = await res.text().catch(() => '');
        log(res.ok ? 'info' : 'warn', 'Bronto ingestion response', {
            status: res.status,
            body: text.slice(0, 300),
        });
        return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
    } catch (e) {
        log('warn', 'Bronto ingestion failed', { error: e instanceof Error ? e.message : String(e) });
        return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
    }
}

main().catch((e) => {
    log('error', 'Phase 2 fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
});
