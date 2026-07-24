/**
 * Pure helpers for the local Whisper server: WAV decoding and multipart
 * form-data parsing. Kept dependency-free and side-effect-free so they can be
 * unit tested with node:test.
 */

const TARGET_SAMPLE_RATE = 16000;

/**
 * Decode a WAV file (PCM16 or IEEE float32) into a mono Float32Array at 16 kHz.
 *
 * The IDE-side recorder always produces 16 kHz / 16-bit / mono, but the server
 * also accepts other rates/channel counts (downmixed and linearly resampled)
 * so third-party OpenAI-compatible clients can use it too.
 *
 * @param {Buffer} buffer WAV file contents
 * @returns {Float32Array} mono PCM at 16 kHz, values in [-1, 1]
 */
export function decodeWavToMono16k(buffer) {
    if (!buffer || buffer.length < 44) {
        throw new Error('Invalid WAV file: too short');
    }
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Invalid WAV file: missing RIFF/WAVE header');
    }

    let offset = 12;
    let format = null;
    let dataChunk = null;

    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;

        if (chunkId === 'fmt ') {
            format = {
                audioFormat: buffer.readUInt16LE(chunkStart),
                numChannels: buffer.readUInt16LE(chunkStart + 2),
                sampleRate: buffer.readUInt32LE(chunkStart + 4),
                bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
            };
        } else if (chunkId === 'data') {
            dataChunk = buffer.subarray(chunkStart, Math.min(chunkStart + chunkSize, buffer.length));
        }

        // Chunks are word-aligned: odd sizes are padded with one byte.
        offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (!format) {
        throw new Error('Invalid WAV file: missing fmt chunk');
    }
    if (!dataChunk || dataChunk.length === 0) {
        throw new Error('Invalid WAV file: missing data chunk');
    }

    const { audioFormat, numChannels, sampleRate, bitsPerSample } = format;
    if (numChannels < 1 || numChannels > 8) {
        throw new Error(`Unsupported channel count: ${numChannels}`);
    }

    let samples;
    if (audioFormat === 1 && bitsPerSample === 16) {
        samples = pcm16ToFloat32(dataChunk, numChannels);
    } else if (audioFormat === 3 && bitsPerSample === 32) {
        samples = float32ToMono(dataChunk, numChannels);
    } else {
        throw new Error(`Unsupported WAV encoding: format=${audioFormat}, bits=${bitsPerSample}`);
    }

    if (sampleRate === TARGET_SAMPLE_RATE) {
        return samples;
    }
    return resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
}

function pcm16ToFloat32(data, numChannels) {
    const frameCount = Math.floor(data.length / (2 * numChannels));
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
        let sum = 0;
        for (let c = 0; c < numChannels; c++) {
            sum += data.readInt16LE((i * numChannels + c) * 2);
        }
        out[i] = (sum / numChannels) / 32768;
    }
    return out;
}

function float32ToMono(data, numChannels) {
    const frameCount = Math.floor(data.length / (4 * numChannels));
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
        let sum = 0;
        for (let c = 0; c < numChannels; c++) {
            sum += data.readFloatLE((i * numChannels + c) * 4);
        }
        out[i] = sum / numChannels;
    }
    return out;
}

/**
 * Linear-interpolation resampler. Quality is sufficient for speech recognition
 * input and avoids a native dependency.
 */
export function resampleLinear(samples, fromRate, toRate) {
    if (fromRate === toRate || samples.length === 0) {
        return samples;
    }
    const ratio = fromRate / toRate;
    const outLength = Math.max(1, Math.round(samples.length / ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const pos = i * ratio;
        const left = Math.floor(pos);
        const right = Math.min(left + 1, samples.length - 1);
        const frac = pos - left;
        out[i] = samples[left] * (1 - frac) + samples[right] * frac;
    }
    return out;
}

/**
 * Extract the multipart boundary from a Content-Type header value.
 *
 * @param {string} contentType e.g. 'multipart/form-data; boundary=----abc'
 * @returns {string|null}
 */
export function extractBoundary(contentType) {
    if (!contentType) {
        return null;
    }
    const match = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
    return match ? (match[1] || match[2]) : null;
}

/**
 * Minimal multipart/form-data parser covering the OpenAI transcription
 * request shape (text fields + one file field). Not a general-purpose
 * implementation: nested multiparts and content-transfer-encodings are not
 * supported.
 *
 * @param {Buffer} body raw request body
 * @param {string} boundary boundary token (without leading dashes)
 * @returns {{fields: Record<string, string>, files: Record<string, {filename: string, contentType: string, data: Buffer}>}}
 */
export function parseMultipart(body, boundary) {
    const fields = {};
    const files = {};
    const delimiter = Buffer.from(`--${boundary}`);
    const headerSeparator = Buffer.from('\r\n\r\n');

    let position = body.indexOf(delimiter);
    while (position !== -1) {
        const partStart = position + delimiter.length;
        // Terminal delimiter: --boundary--
        if (body.slice(partStart, partStart + 2).toString('ascii') === '--') {
            break;
        }

        const nextDelimiter = body.indexOf(delimiter, partStart);
        if (nextDelimiter === -1) {
            break;
        }

        // Part = \r\n headers \r\n\r\n content \r\n
        const headerEnd = body.indexOf(headerSeparator, partStart);
        if (headerEnd === -1 || headerEnd >= nextDelimiter) {
            position = nextDelimiter;
            continue;
        }

        const headerText = body.slice(partStart, headerEnd).toString('utf8');
        const content = body.slice(headerEnd + headerSeparator.length, nextDelimiter - 2); // strip trailing \r\n

        // Anchor on ";" so `name=` never matches the tail of `filename=`.
        const dispositionLine = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0];
        const nameMatch = dispositionLine ? /;\s*name="([^"]*)"/i.exec(dispositionLine) : null;
        if (nameMatch) {
            const name = nameMatch[1];
            const filename = /;\s*filename="([^"]*)"/i.exec(dispositionLine)?.[1];
            if (filename !== undefined) {
                const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
                files[name] = {
                    filename,
                    contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
                    data: content,
                };
            } else {
                fields[name] = content.toString('utf8');
            }
        }

        position = nextDelimiter;
    }

    return { fields, files };
}
