/**
 * Prefetches a Whisper model for the local transcription server.
 *
 * Run once during "Set up local Whisper" so the model download happens with
 * visible progress in the settings UI instead of stalling the first dictation.
 *
 * Usage:
 *   node prefetch.js --root <whisper-install-root> [--model Xenova/whisper-base] [--device cpu|wasm]
 *
 * Protocol (stdout, line-oriented, parsed by the Java side):
 *   [WHISPER_PROGRESS] {"file":"...","progress":42}   download progress
 *   [WHISPER_LOG] <text>                              diagnostics
 *   [WHISPER_DONE] {"model":"...","device":"..."}     model ready (exit 0)
 *   [WHISPER_ERROR] <message>                         failure (exit 1)
 *
 * A hard native crash (onnxruntime-node abort => exit 134/SIGABRT) produces no
 * [WHISPER_ERROR] line; the Java side treats a non-zero exit without one as a
 * signal to retry with --device wasm.
 */

import { parseArgs } from 'node:util';
import { DEFAULT_MODEL, DEVICE_WASM, loadTranscriber } from './whisper-runtime.js';

const { values: args } = parseArgs({
    options: {
        root: { type: 'string' },
        model: { type: 'string' },
        device: { type: 'string' },
    },
});

if (!args.root) {
    console.error('[WHISPER_ERROR] Missing required --root argument');
    process.exit(1);
}
const model = args.model || DEFAULT_MODEL;
const device = args.device === DEVICE_WASM ? DEVICE_WASM : 'cpu';

// Throttle progress lines: only emit when a file's integer percentage changes.
const lastReported = new Map();

try {
    console.log(`[WHISPER_LOG] Prefetching model ${model} (device=${device})...`);
    await loadTranscriber(args.root, model, (progress) => {
        if (!progress || typeof progress !== 'object') {
            return;
        }
        if (progress.status === 'progress' && typeof progress.progress === 'number') {
            const percent = Math.min(100, Math.round(progress.progress));
            if (lastReported.get(progress.file) !== percent) {
                lastReported.set(progress.file, percent);
                console.log(`[WHISPER_PROGRESS] ${JSON.stringify({ file: progress.file, progress: percent })}`);
            }
        } else if (progress.status === 'done' && progress.file) {
            console.log(`[WHISPER_LOG] Downloaded ${progress.file}`);
        }
    }, device);
    console.log(`[WHISPER_DONE] ${JSON.stringify({ model, device })}`);
    process.exit(0);
} catch (error) {
    console.error(`[WHISPER_ERROR] ${error.message}`);
    process.exit(1);
}
