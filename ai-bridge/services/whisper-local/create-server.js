/**
 * HTTP layer of the local Whisper transcription server, separated from the
 * model bootstrap so it can be integration-tested with a stub transcriber.
 *
 * Exposes an OpenAI-compatible POST /v1/audio/transcriptions (and
 * /audio/transcriptions) plus GET /health.
 */

import http from 'node:http';
import { decodeWavToMono16k, extractBoundary, parseMultipart } from './audio-utils.js';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * @param {Function} transcriber ASR pipeline: (Float32Array, options) => Promise<{text: string}>
 * @param {string} model model id, echoed in /health and used to detect .en-only models
 * @param {(message: string) => void} [log] diagnostic logger
 * @returns {http.Server}
 */
export function createWhisperServer(transcriber, model, log = () => {}) {
    // The ONNX pipeline is not safely reentrant — serialize transcriptions.
    let queue = Promise.resolve();
    const enqueue = (task) => {
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result;
    };

    const sendJson = (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    };
    const sendError = (res, status, message) => sendJson(res, status, { error: { message } });

    const handleTranscription = async (req, res, body) => {
        const boundary = extractBoundary(req.headers['content-type']);
        if (!boundary) {
            sendError(res, 400, 'Expected multipart/form-data with a boundary');
            return;
        }

        const { fields, files } = parseMultipart(body, boundary);
        const file = files.file;
        if (!file || !file.data || file.data.length === 0) {
            sendError(res, 400, 'Missing "file" form field');
            return;
        }

        let audio;
        try {
            audio = decodeWavToMono16k(file.data);
        } catch (error) {
            sendError(res, 400, `Could not decode audio: ${error.message}`);
            return;
        }

        const language = (fields.language || '').trim();
        const isEnglishOnlyModel = /\.en$/.test(model);
        const options = {
            chunk_length_s: 30,
            stride_length_s: 5,
            ...(language && !isEnglishOnlyModel ? { language, task: 'transcribe' } : {}),
        };

        try {
            const output = await enqueue(() => transcriber(audio, options));
            const text = typeof output?.text === 'string' ? output.text.trim() : '';
            sendJson(res, 200, { text });
        } catch (error) {
            log(`Transcription failed: ${error.message}`);
            sendError(res, 500, `Transcription failed: ${error.message}`);
        }
    };

    return http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];

        if (req.method === 'GET' && url === '/health') {
            sendJson(res, 200, { ok: true, model });
            return;
        }

        if (req.method === 'POST' && (url === '/v1/audio/transcriptions' || url === '/audio/transcriptions')) {
            const chunks = [];
            let total = 0;
            req.on('data', (chunk) => {
                total += chunk.length;
                if (total > MAX_BODY_BYTES) {
                    sendError(res, 413, 'Request body too large');
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                handleTranscription(req, res, Buffer.concat(chunks)).catch((error) => {
                    log(`Unhandled request error: ${error.message}`);
                    if (!res.headersSent) {
                        sendError(res, 500, 'Internal error');
                    }
                });
            });
            req.on('error', () => {
                // Client disconnected mid-upload — nothing to do.
            });
            return;
        }

        sendError(res, 404, `No route for ${req.method} ${url}`);
    });
}
