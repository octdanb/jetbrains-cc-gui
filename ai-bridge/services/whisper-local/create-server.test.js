import test from 'node:test';
import assert from 'node:assert/strict';

import { createWhisperServer } from './create-server.js';

function buildWav(sampleCount = 1600) {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16000, 24);
    buffer.writeUInt32LE(32000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
}

function buildMultipartBody(boundary, wav, fields = {}) {
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        ));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\n` +
        'Content-Type: audio/wav\r\n\r\n'
    ));
    parts.push(wav);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(parts);
}

async function withServer(transcriber, model, run) {
    const server = createWhisperServer(transcriber, model);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await run(port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('POST /v1/audio/transcriptions returns transcript from the pipeline', async () => {
    const seen = [];
    const fakeTranscriber = async (audio, options) => {
        seen.push({ length: audio.length, options });
        return { text: '  hello from whisper  ' };
    };

    await withServer(fakeTranscriber, 'Xenova/whisper-base', async (port) => {
        const boundary = '----e2e';
        const body = buildMultipartBody(boundary, buildWav(), { model: 'whisper-1', language: 'en' });
        const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.text, 'hello from whisper');
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, 1600);
    assert.equal(seen[0].options.language, 'en');
});

test('language hint is dropped for English-only (.en) models', async () => {
    const seen = [];
    const fakeTranscriber = async (_audio, options) => {
        seen.push(options);
        return { text: 'ok' };
    };

    await withServer(fakeTranscriber, 'Xenova/whisper-base.en', async (port) => {
        const boundary = '----e2e';
        const body = buildMultipartBody(boundary, buildWav(), { language: 'fr' });
        const response = await fetch(`http://127.0.0.1:${port}/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        assert.equal(response.status, 200);
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].language, undefined);
});

test('rejects requests without a file part', async () => {
    await withServer(async () => ({ text: 'x' }), 'm', async (port) => {
        const boundary = '----e2e';
        const body = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`
        );
        const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        assert.equal(response.status, 400);
        const json = await response.json();
        assert.match(json.error.message, /file/);
    });
});

test('rejects undecodable audio with 400', async () => {
    await withServer(async () => ({ text: 'x' }), 'm', async (port) => {
        const boundary = '----e2e';
        const body = buildMultipartBody(boundary, Buffer.from('this is not audio data at all, definitely'));
        const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        assert.equal(response.status, 400);
        const json = await response.json();
        assert.match(json.error.message, /decode/i);
    });
});

test('pipeline failures surface as 500 with a message', async () => {
    const failing = async () => {
        throw new Error('onnx exploded');
    };
    await withServer(failing, 'm', async (port) => {
        const boundary = '----e2e';
        const body = buildMultipartBody(boundary, buildWav());
        const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        assert.equal(response.status, 500);
        const json = await response.json();
        assert.match(json.error.message, /onnx exploded/);
    });
});

test('GET /health reports the model, unknown routes get 404', async () => {
    await withServer(async () => ({ text: '' }), 'Xenova/whisper-tiny', async (port) => {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true, model: 'Xenova/whisper-tiny' });

        const missing = await fetch(`http://127.0.0.1:${port}/nope`);
        assert.equal(missing.status, 404);
    });
});
