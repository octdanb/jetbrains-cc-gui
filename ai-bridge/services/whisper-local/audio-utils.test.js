import test from 'node:test';
import assert from 'node:assert/strict';

import {
    decodeWavToMono16k,
    extractBoundary,
    parseMultipart,
    resampleLinear,
} from './audio-utils.js';

/**
 * Build a minimal PCM16 WAV buffer for tests.
 */
function buildWav({ sampleRate = 16000, channels = 1, samples }) {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
    buffer.writeUInt16LE(channels * bytesPerSample, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    samples.forEach((value, i) => buffer.writeInt16LE(value, 44 + i * 2));
    return buffer;
}

test('decodeWavToMono16k decodes 16kHz mono PCM16 without resampling', () => {
    const wav = buildWav({ samples: [0, 16384, -16384, 32767] });
    const audio = decodeWavToMono16k(wav);
    assert.equal(audio.length, 4);
    assert.ok(Math.abs(audio[0]) < 1e-6);
    assert.ok(Math.abs(audio[1] - 0.5) < 1e-3);
    assert.ok(Math.abs(audio[2] + 0.5) < 1e-3);
    assert.ok(audio[3] > 0.99);
});

test('decodeWavToMono16k downmixes stereo to mono', () => {
    // Interleaved L/R frames: (16384, -16384) should average to ~0
    const wav = buildWav({ channels: 2, samples: [16384, -16384, 8192, 8192] });
    const audio = decodeWavToMono16k(wav);
    assert.equal(audio.length, 2);
    assert.ok(Math.abs(audio[0]) < 1e-3);
    assert.ok(Math.abs(audio[1] - 0.25) < 1e-3);
});

test('decodeWavToMono16k resamples 32kHz input to 16kHz', () => {
    const samples = new Array(3200).fill(1000);
    const wav = buildWav({ sampleRate: 32000, samples });
    const audio = decodeWavToMono16k(wav);
    // 3200 samples at 32kHz -> ~1600 samples at 16kHz
    assert.ok(Math.abs(audio.length - 1600) <= 1);
});

test('decodeWavToMono16k rejects non-WAV payloads', () => {
    assert.throws(() => decodeWavToMono16k(Buffer.from('definitely not a wav file, but long enough to pass the length check')), /RIFF/);
    assert.throws(() => decodeWavToMono16k(Buffer.alloc(4)), /too short/);
});

test('resampleLinear halves the sample count when downsampling 2:1', () => {
    const input = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    const output = resampleLinear(input, 32000, 16000);
    assert.equal(output.length, 50);
    // Values should still be monotonically increasing
    for (let i = 1; i < output.length; i++) {
        assert.ok(output[i] >= output[i - 1]);
    }
});

test('extractBoundary reads quoted and unquoted boundaries', () => {
    assert.equal(extractBoundary('multipart/form-data; boundary=----abc123'), '----abc123');
    assert.equal(extractBoundary('multipart/form-data; boundary="with spaces ok"'), 'with spaces ok');
    assert.equal(extractBoundary('application/json'), null);
    assert.equal(extractBoundary(undefined), null);
});

test('parseMultipart extracts text fields and a binary file part', () => {
    const boundary = '----testboundary';
    const fileData = Buffer.from([0x00, 0x01, 0xff, 0x0d, 0x0a, 0x7f]);
    const body = Buffer.concat([
        Buffer.from(
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="model"\r\n\r\n' +
            'whisper-1\r\n' +
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="language"\r\n\r\n' +
            'en\r\n' +
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n' +
            'Content-Type: audio/wav\r\n\r\n'
        ),
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const { fields, files } = parseMultipart(body, boundary);
    assert.equal(fields.model, 'whisper-1');
    assert.equal(fields.language, 'en');
    assert.ok(files.file);
    assert.equal(files.file.filename, 'recording.wav');
    assert.equal(files.file.contentType, 'audio/wav');
    assert.deepEqual([...files.file.data], [...fileData]);
});

test('parseMultipart handles a missing file part gracefully', () => {
    const boundary = 'b';
    const body = Buffer.from(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="model"\r\n\r\n' +
        'whisper-1\r\n' +
        `--${boundary}--\r\n`
    );
    const { fields, files } = parseMultipart(body, boundary);
    assert.equal(fields.model, 'whisper-1');
    assert.equal(Object.keys(files).length, 0);
});
