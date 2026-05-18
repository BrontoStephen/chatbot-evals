import * as fs from 'fs';
import * as path from 'path';
import { envOrDefault, log, parseArgs, percentile, readJson, resultsDir } from './util';

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

interface ScoresFile {
    meta: { runId: string; source: string; count: number; generatedAt: string; judgeModel: string; ingestStatus?: unknown };
    scores: ScoreRecord[];
}

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(n: number, digits = 2): string {
    return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function bar(count: number, total: number, width = 20): string {
    if (total === 0) return ' '.repeat(width);
    const fill = Math.round((count / total) * width);
    return '█'.repeat(fill) + ' '.repeat(width - fill);
}

function distribution(scores: ScoreRecord[], key: keyof ScoreRecord, label: string): string {
    const buckets = new Map<number, number>();
    for (let i = 1; i <= 5; i++) buckets.set(i, 0);
    for (const s of scores) {
        const v = Number(s[key]);
        if (buckets.has(v)) buckets.set(v, (buckets.get(v) ?? 0) + 1);
    }
    const total = scores.length;
    const lines = [`**${label}** distribution (n=${total}):`, '```'];
    for (let i = 5; i >= 1; i--) {
        const c = buckets.get(i) ?? 0;
        lines.push(`  ${i}  [${bar(c, total)}]  ${c}/${total}`);
    }
    lines.push('```');
    return lines.join('\n');
}

function tagAggregates(scores: ScoreRecord[]): Map<string, ScoreRecord[]> {
    const m = new Map<string, ScoreRecord[]>();
    for (const s of scores) {
        for (const tag of s.eval_tags) {
            if (!m.has(tag)) m.set(tag, []);
            m.get(tag)!.push(s);
        }
    }
    return m;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const runId = (typeof args.run === 'string' && args.run) || process.env.EVAL_RUN_ID;
    if (!runId) {
        throw new Error('Missing --run <run-id> argument (or EVAL_RUN_ID env)');
    }
    const outDir = resultsDir(runId);
    const scoresFile = path.join(outDir, 'scores.json');
    if (!fs.existsSync(scoresFile)) {
        throw new Error(`scores.json not found at ${scoresFile}`);
    }
    const reportFile = path.join(outDir, 'report.md');
    const region = envOrDefault('BRONTO_REGION', 'eu').toLowerCase();

    const data = readJson<ScoresFile>(scoresFile);
    const { meta, scores } = data;

    const total = scores.length;
    const passed = scores.filter((s) => s.eval_passed).length;
    const passRate = total > 0 ? (passed / total) * 100 : 0;
    const latencies = scores.map((s) => s.latency_ms).filter((n) => n > 0);
    const totalInTokens = scores.reduce((a, s) => a + (s.input_tokens || 0), 0);
    const totalOutTokens = scores.reduce((a, s) => a + (s.output_tokens || 0), 0);

    const tagMap = tagAggregates(scores);
    const tagRows = Array.from(tagMap.entries())
        .map(([tag, list]) => ({
            tag,
            n: list.length,
            passRate: (list.filter((s) => s.eval_passed).length / list.length) * 100,
            correctness: avg(list.map((s) => s.eval_score_correctness)),
            completeness: avg(list.map((s) => s.eval_score_completeness)),
            clarity: avg(list.map((s) => s.eval_score_clarity)),
            overall: avg(list.map((s) => s.eval_overall_score)),
        }))
        .sort((a, b) => b.overall - a.overall);

    const md: string[] = [];
    md.push(`# Eval Report — ${runId}`);
    md.push('');
    md.push(`_Generated ${meta.generatedAt} from ${meta.source} source. Judge: \`${meta.judgeModel}\`._`);
    md.push('');
    md.push('## Summary');
    md.push('');
    md.push('| Metric | Value |');
    md.push('| --- | --- |');
    md.push(`| Cases | ${total} |`);
    md.push(`| Passed (overall ≥ 4) | ${passed} |`);
    md.push(`| Pass rate | ${fmt(passRate, 1)}% |`);
    md.push(`| Avg correctness | ${fmt(avg(scores.map((s) => s.eval_score_correctness)))} |`);
    md.push(`| Avg completeness | ${fmt(avg(scores.map((s) => s.eval_score_completeness)))} |`);
    md.push(`| Avg clarity | ${fmt(avg(scores.map((s) => s.eval_score_clarity)))} |`);
    md.push(`| Avg overall | ${fmt(avg(scores.map((s) => s.eval_overall_score)))} |`);
    md.push(`| Avg latency (ms) | ${fmt(avg(latencies), 0)} |`);
    md.push(`| p50 latency (ms) | ${fmt(percentile(latencies, 50), 0)} |`);
    md.push(`| p95 latency (ms) | ${fmt(percentile(latencies, 95), 0)} |`);
    md.push(`| Total input tokens | ${totalInTokens} |`);
    md.push(`| Total output tokens | ${totalOutTokens} |`);
    md.push('');
    md.push('## Score distribution');
    md.push('');
    md.push(distribution(scores, 'eval_score_correctness', 'Correctness'));
    md.push('');
    md.push(distribution(scores, 'eval_score_completeness', 'Completeness'));
    md.push('');
    md.push(distribution(scores, 'eval_score_clarity', 'Clarity'));
    md.push('');
    md.push(distribution(scores, 'eval_overall_score', 'Overall'));
    md.push('');
    md.push('## By category (tag)');
    md.push('');
    md.push('| Tag | N | Pass rate | Correctness | Completeness | Clarity | Overall |');
    md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of tagRows) {
        md.push(`| \`${r.tag}\` | ${r.n} | ${fmt(r.passRate, 0)}% | ${fmt(r.correctness)} | ${fmt(r.completeness)} | ${fmt(r.clarity)} | ${fmt(r.overall)} |`);
    }
    md.push('');
    md.push('## Per-case results');
    md.push('');
    for (const s of scores) {
        const badge = s.eval_passed ? '✅ PASS' : '❌ FAIL';
        md.push(`### \`${s.eval_case_id}\` — ${badge} (overall ${s.eval_overall_score}/5)`);
        md.push('');
        md.push(`- **tags:** ${s.eval_tags.map((t) => `\`${t}\``).join(', ')}`);
        md.push(`- **correctness:** ${s.eval_score_correctness}/5 · **completeness:** ${s.eval_score_completeness}/5 · **clarity:** ${s.eval_score_clarity}/5`);
        md.push(`- **latency:** ${s.latency_ms} ms · **tokens:** in=${s.input_tokens}, out=${s.output_tokens}`);
        md.push(`- **judge rationale:** ${s.eval_judge_rationale}`);
        if (s.error) md.push(`- **error:** ${s.error}`);
        md.push('');
        md.push('<details><summary>Output preview</summary>');
        md.push('');
        md.push('```');
        md.push(s.output_preview);
        md.push('```');
        md.push('');
        md.push('</details>');
        md.push('');
    }

    md.push('## Reproduce in Bronto');
    md.push('');
    md.push('Search for raw chat traces from this run:');
    md.push('');
    md.push('```bash');
    md.push(`curl -X POST https://api.${region}.bronto.io/search \\`);
    md.push('  -H "X-BRONTO-API-KEY: $BRONTO_API_KEY" \\');
    md.push('  -H "Content-Type: application/json" \\');
    md.push(`  -d '{"from":"'\\$\\{BRONTO_DATASET\\}'","time_range":"Last 24 hours","where":"\\"\\$x-eval-run-id\\"=\\"${runId}\\""}'`);
    md.push('```');
    md.push('');
    md.push('Search for the score events written by Phase 2:');
    md.push('');
    md.push('```bash');
    md.push(`curl -X POST https://api.${region}.bronto.io/search \\`);
    md.push('  -H "X-BRONTO-API-KEY: $BRONTO_API_KEY" \\');
    md.push('  -H "Content-Type: application/json" \\');
    md.push(`  -d '{"from":"'\\$\\{BRONTO_DATASET\\}'","time_range":"Last 24 hours","where":"\\"\\$eval_run_id\\"=\\"${runId}\\""}'`);
    md.push('```');
    md.push('');
    md.push('Or via the Bronto MCP (Claude Code):');
    md.push('');
    md.push('```');
    md.push(`mcp__bronto__search_logs where="\\"\\$eval_run_id\\"='${runId}'" limit=100`);
    md.push('```');
    md.push('');

    fs.writeFileSync(reportFile, md.join('\n'), 'utf8');

    // Stdout summary
    log('info', 'Phase 3 complete', {
        runId,
        reportFile,
        total,
        passed,
        passRate: Number(passRate.toFixed(1)),
        avgOverall: Number(avg(scores.map((s) => s.eval_overall_score)).toFixed(2)),
    });
    console.log(`\nReport written to ${reportFile}`);
    console.log(`Run ${runId}: ${passed}/${total} passed (${fmt(passRate, 1)}%) — avg overall ${fmt(avg(scores.map((s) => s.eval_overall_score)))}`);
}

try {
    main();
} catch (e) {
    log('error', 'Phase 3 fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
}
