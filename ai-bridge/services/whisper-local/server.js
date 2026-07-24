/**
 * Local Whisper transcription server — bootstrap.
 *
 * Loads the model with transformers.js + onnxruntime-node, then serves the
 * OpenAI-compatible HTTP API from create-server.js on 127.0.0.1. Started and
 * supervised by the IDE plugin (LocalWhisperManager) when voice input runs in
 * "local" mode.
 *
 * Usage:
 *   node server.js --root <whisper-install-root> [--model Xenova/whisper-base]
 *                  [--port 0] [--device cpu|wasm]
 *
 * Protocol (stdout, line-oriented, parsed by the Java side):
 *   [WHISPER_LOG] <text>            progress / diagnostics
 *   [WHISPER_READY] {"port":N,...}  server is listening and the model is loaded
 *   [WHISPER_ERROR] <message>       fatal startup error (process exits 1)
 */

import { parseArgs } from 'node:util';
import { createWhisperServer } from './create-server.js';
import { DEFAULT_MODEL, DEVICE_WASM, loadTranscriber } from './whisper-runtime.js';

const { values: args } = parseArgs({
    options: {
        root: { type: 'string' },
        model: { type: 'string' },
        port: { type: 'string' },
        device: { type: 'string' },
    },
});

if (!args.root) {
    console.error('[WHISPER_ERROR] Missing required --root argument');
    process.exit(1);
}
const model = args.model || DEFAULT_MODEL;
const device = args.device === DEVICE_WASM ? DEVICE_WASM : 'cpu';

let transcriber;
try {
    console.log(`[WHISPER_LOG] Loading model ${model} (device=${device})...`);
    transcriber = await loadTranscriber(args.root, model, (progress) => {
        if (progress && progress.status === 'progress' && typeof progress.progress === 'number') {
            console.log(`[WHISPER_LOG] Downloading ${progress.file}: ${Math.round(progress.progress)}%`);
        }
    }, device);
    console.log('[WHISPER_LOG] Model loaded');
} catch (error) {
    console.error(`[WHISPER_ERROR] ${error.message}`);
    process.exit(1);
}

const server = createWhisperServer(transcriber, model, (message) => {
    console.log(`[WHISPER_LOG] ${message}`);
});

server.listen(Number(args.port || 0), '127.0.0.1', () => {
    const address = server.address();
    console.log(`[WHISPER_READY] ${JSON.stringify({ port: address.port, model })}`);
});

// Exit when the supervising IDE process closes our stdin (IDE shutdown/crash),
// so no orphaned servers accumulate.
process.stdin.resume();
process.stdin.on('end', () => {
    console.log('[WHISPER_LOG] stdin closed, shutting down');
    process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
