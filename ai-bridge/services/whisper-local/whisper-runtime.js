/**
 * Loads @huggingface/transformers (transformers.js) from the on-demand install
 * root (~/.codemoss/dependencies/whisper-local) — same external-node_modules
 * pattern as utils/sdk-loader.js — and builds a Whisper ASR pipeline backed by
 * onnxruntime-node. Models are cached under <root>/models.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const DEFAULT_MODEL = 'Xenova/whisper-base';

export function getPackageDir(root) {
    return join(root, 'node_modules', '@huggingface', 'transformers');
}

export function getModelsDir(root) {
    return join(root, 'models');
}

/**
 * Resolve the entry file of @huggingface/transformers installed under root.
 * Tries Node's own resolver first (honours the package "exports" map), then
 * falls back to package.json fields and known dist locations.
 *
 * @param {string} root whisper-local install root
 * @returns {string} absolute path to the entry file
 */
export function resolveTransformersEntry(root) {
    const packageDir = getPackageDir(root);
    if (!existsSync(packageDir)) {
        throw new Error(`NOT_INSTALLED: @huggingface/transformers not found under ${root}`);
    }

    try {
        const require = createRequire(join(packageDir, 'noop.js'));
        return require.resolve('@huggingface/transformers');
    } catch {
        // ESM-only exports map — fall through to manual resolution.
    }

    const candidates = [];
    try {
        const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
        const root_ = pkg.exports && (pkg.exports['.'] ?? pkg.exports);
        const collect = (value) => {
            if (typeof value === 'string') {
                candidates.push(value);
            } else if (value && typeof value === 'object') {
                for (const key of ['node', 'import', 'require', 'default']) {
                    collect(value[key]);
                }
            }
        };
        collect(root_);
        if (typeof pkg.module === 'string') {
            candidates.push(pkg.module);
        }
        if (typeof pkg.main === 'string') {
            candidates.push(pkg.main);
        }
    } catch {
        // ignore malformed package.json, use static fallbacks below
    }
    candidates.push(
        'dist/transformers.node.mjs',
        'dist/transformers.node.cjs',
        'dist/transformers.mjs',
        'dist/transformers.cjs',
        'dist/transformers.js'
    );

    for (const candidate of candidates) {
        const full = join(packageDir, candidate);
        if (existsSync(full)) {
            return full;
        }
    }
    throw new Error(`Unable to resolve @huggingface/transformers entry file under ${packageDir}`);
}

/**
 * Import transformers.js and create the ASR pipeline for the given model.
 * Downloads model files into <root>/models on first use.
 *
 * @param {string} root whisper-local install root
 * @param {string} model HF model id, e.g. Xenova/whisper-base
 * @param {(progress: object) => void} [onProgress] transformers.js progress callback
 * @returns {Promise<Function>} the transcriber pipeline
 */
export async function loadTranscriber(root, model, onProgress) {
    const entry = resolveTransformersEntry(root);
    const imported = await import(pathToFileURL(entry).href);
    const mod = imported.pipeline ? imported : imported.default;
    if (!mod || typeof mod.pipeline !== 'function') {
        throw new Error('Loaded @huggingface/transformers but found no pipeline export');
    }

    mod.env.cacheDir = getModelsDir(root);
    mod.env.allowLocalModels = true;

    // Honour HF_ENDPOINT for users behind mirrors (e.g. hf-mirror.com) —
    // same convention as the Python huggingface_hub client.
    const hfEndpoint = (process.env.HF_ENDPOINT || '').trim();
    if (hfEndpoint) {
        mod.env.remoteHost = hfEndpoint.replace(/\/+$/, '') + '/';
    }

    return mod.pipeline('automatic-speech-recognition', model || DEFAULT_MODEL, {
        // Quantized weights: much smaller download, minor accuracy cost —
        // the right default for dictation.
        dtype: 'q8',
        ...(onProgress ? { progress_callback: onProgress } : {}),
    });
}
