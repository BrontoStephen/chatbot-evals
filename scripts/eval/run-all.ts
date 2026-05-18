import { spawn } from 'child_process';
import { log, parseArgs, resolveRunId } from './util';

function runPhase(phaseFile: string, extraArgs: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'npx',
            ['tsx', `scripts/eval/${phaseFile}`, ...extraArgs],
            { stdio: 'inherit', env },
        );
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', reject);
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const skipRun = args['skip-run'] === true || args['skip-run'] === 'true';
    const skipScore = args['skip-score'] === true || args['skip-score'] === 'true';
    const source = (typeof args.source === 'string' ? args.source : 'bronto') as 'bronto' | 'local';
    const waitSec = typeof args.wait === 'string' ? Number(args.wait) : 45;

    const runId = resolveRunId();
    const env = { ...process.env, EVAL_RUN_ID: runId };

    log('info', 'run-all starting', { runId, skipRun, skipScore, source, waitSec });

    if (!skipRun) {
        const code = await runPhase('run-eval.ts', [], env);
        if (code !== 0) {
            log('error', 'run-eval exited non-zero', { code });
            process.exit(code);
        }
        if (!skipScore && source === 'bronto') {
            log('info', `Waiting ${waitSec}s for Bronto ingestion...`, { runId });
            await sleep(waitSec * 1000);
        }
    } else {
        log('info', 'Skipping Phase 1', { runId });
    }

    if (!skipScore) {
        const code = await runPhase('score-eval.ts', ['--run', runId, '--source', source], env);
        if (code !== 0) {
            log('error', 'score-eval exited non-zero', { code });
            process.exit(code);
        }
    } else {
        log('info', 'Skipping Phase 2', { runId });
    }

    const code = await runPhase('report.ts', ['--run', runId], env);
    if (code !== 0) {
        log('error', 'report exited non-zero', { code });
        process.exit(code);
    }

    log('info', 'run-all complete', { runId });
}

main().catch((e) => {
    log('error', 'run-all fatal', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
});
