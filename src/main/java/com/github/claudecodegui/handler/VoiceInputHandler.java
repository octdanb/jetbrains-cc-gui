package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.dependency.InstallResult;
import com.github.claudecodegui.voice.LocalWhisperManager;
import com.github.claudecodegui.voice.VoiceRecordingService;
import com.github.claudecodegui.voice.VoiceTranscriptionService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Voice input (speech-to-text) message handler.
 *
 * <p>The webview drives the recording lifecycle over the bridge; audio capture
 * and transcription happen entirely on the IDE side:</p>
 *
 * <pre>
 * voice_record_start / voice_record_stop / voice_record_cancel   (JS -> Java)
 * get_voice_input_config / set_voice_input_config                (JS -> Java)
 * window.onVoiceRecordingState({state, error?})                  (Java -> JS)
 * window.onVoicePartialTranscript({text})                        (Java -> JS)
 * window.onVoiceTranscript({success, text?, error?})             (Java -> JS)
 * window.updateVoiceInputConfig({enabled, baseUrl, ...})         (Java -> JS)
 * </pre>
 *
 * <p><b>Live dictation:</b> when enabled (local engine only), a background
 * ticker re-transcribes the audio captured so far every ~1.2 s and streams
 * partial text to the composer, which shows it in place and replaces it with
 * the final transcript on stop.</p>
 */
public class VoiceInputHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(VoiceInputHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "voice_record_start",
        "voice_record_stop",
        "voice_record_cancel",
        "get_voice_input_config",
        "set_voice_input_config",
        "get_local_whisper_status",
        "setup_local_whisper"
    };

    /** Generous ceiling for npm install + model download during setup. */
    private static final long SETUP_STEP_TIMEOUT_MINUTES = 20;
    /** How many trailing output lines to quote when prefetch crashes. */
    private static final int PREFETCH_TAIL_LINES = 6;

    /**
     * How often to attempt a live (partial) transcription while recording.
     * A new pass is only started when the previous one has finished, so a slow
     * model self-regulates to fewer updates instead of building a backlog.
     */
    private static final long LIVE_TICK_MILLIS = 1200;
    /** Don't bother transcribing until there is at least this much audio. */
    private static final double LIVE_MIN_SECONDS = 1.0;
    /**
     * Safety cap on how much trailing audio each live pass transcribes. Live
     * passes re-transcribe the whole recording so the preview never jumps
     * backwards; this only bounds the worst case for very long dictations.
     * The final pass after stop is always the complete recording.
     */
    private static final double LIVE_WINDOW_SECONDS = 180;

    private final Gson gson = new Gson();
    private final VoiceRecordingService recordingService = new VoiceRecordingService();
    private final VoiceTranscriptionService transcriptionService = new VoiceTranscriptionService();

    /** Ticker driving live partial transcriptions; null when not live. */
    private volatile java.util.concurrent.ScheduledExecutorService liveExecutor;
    /**
     * Incremented on every stop/cancel so in-flight live passes from a previous
     * recording cannot emit partials into the next one.
     */
    private final java.util.concurrent.atomic.AtomicLong recordingGeneration =
            new java.util.concurrent.atomic.AtomicLong();
    /** True while a live pass is running, so ticks don't pile up. */
    private final java.util.concurrent.atomic.AtomicBoolean livePassInFlight =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    /** Last partial text emitted, to suppress duplicate updates. */
    private final java.util.concurrent.atomic.AtomicReference<String> lastPartialText =
            new java.util.concurrent.atomic.AtomicReference<>("");

    public VoiceInputHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "voice_record_start":
                handleRecordStart(content);
                return true;
            case "voice_record_stop":
                handleRecordStop();
                return true;
            case "voice_record_cancel":
                handleRecordCancel();
                return true;
            case "get_voice_input_config":
                handleGetConfig();
                return true;
            case "set_voice_input_config":
                handleSetConfig(content);
                return true;
            case "get_local_whisper_status":
                handleGetLocalWhisperStatus();
                return true;
            case "setup_local_whisper":
                handleSetupLocalWhisper(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Start recording.
     *
     * @param content {"live": boolean} — the composer has separate Record and
     *        Dictation buttons, so which mode to use is an explicit request
     *        rather than something inferred from settings here.
     */
    private void handleRecordStart(String content) {
        boolean requestedLive = false;
        try {
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            if (payload != null && payload.has("live") && !payload.get("live").isJsonNull()) {
                requestedLive = payload.get("live").getAsBoolean();
            }
        } catch (RuntimeException e) {
            LOG.debug("[VoiceInput] No/invalid start payload, defaulting to plain recording");
        }
        final boolean live = requestedLive;

        CompletableFuture.runAsync(() -> {
            try {
                recordingService.start();
                lastPartialText.set("");
                boolean liveStarted = live && maybeStartLiveDictation();
                sendRecordingState("recording", liveStarted, null);
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to start recording: " + e.getMessage());
                sendRecordingState("idle", false, "Could not access the microphone: " + e.getMessage());
            }
        });
    }

    private void handleRecordStop() {
        CompletableFuture.runAsync(() -> {
            // Bump the generation first so no late live pass can emit a partial
            // that overwrites the final transcript.
            recordingGeneration.incrementAndGet();
            stopLiveDictation();

            byte[] wavBytes;
            try {
                wavBytes = recordingService.stop();
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to stop recording: " + e.getMessage());
                sendTranscript(false, null, "Recording failed: " + e.getMessage());
                return;
            }

            if (wavBytes.length == 0) {
                sendTranscript(true, "", null);
                return;
            }

            sendRecordingState("transcribing", false, null);
            try {
                JsonObject config = context.getSettingsService().getVoiceInputConfig();
                JsonObject target = resolveTranscriptionTarget(config);
                String text = transcriptionService.transcribe(wavBytes, target);
                sendTranscript(true, text, null);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                sendTranscript(false, null, "Transcription was interrupted");
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Transcription failed: " + e.getMessage());
                sendTranscript(false, null, e.getMessage());
            }
        });
    }

    /**
     * Start streaming partial transcripts for a dictation request.
     *
     * <p>Live mode is deliberately local-only: each pass is a full
     * transcription request, so running it against a paid cloud endpoint would
     * bill the user roughly once per second of speech. When live is not
     * possible the recording still proceeds as a plain one, and the caller is
     * told so the UI can reflect it.</p>
     *
     * @return true when live passes were actually started
     */
    private boolean maybeStartLiveDictation() {
        JsonObject config;
        try {
            config = context.getSettingsService().getVoiceInputConfig();
        } catch (Exception e) {
            LOG.warn("[VoiceInput] Could not read config for live dictation: " + e.getMessage());
            return false;
        }

        boolean isLocal = config.has("mode")
                && !config.get("mode").isJsonNull()
                && "local".equals(config.get("mode").getAsString());
        if (!isLocal) {
            LOG.info("[VoiceInput] Live dictation needs the local engine; recording without partials");
            return false;
        }

        final long generation = recordingGeneration.get();
        java.util.concurrent.ScheduledExecutorService executor =
                java.util.concurrent.Executors.newSingleThreadScheduledExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "cc-gui-voice-live");
                    thread.setDaemon(true);
                    return thread;
                });
        liveExecutor = executor;

        executor.scheduleWithFixedDelay(
                () -> runLivePass(generation, config),
                LIVE_TICK_MILLIS, LIVE_TICK_MILLIS, TimeUnit.MILLISECONDS);
        LOG.info("[VoiceInput] Live dictation started");
        return true;
    }

    /**
     * One live pass: snapshot the audio so far, transcribe it, and emit the
     * text as a partial. Skipped when a previous pass is still running, so a
     * slow model degrades to fewer updates instead of building a backlog.
     */
    private void runLivePass(long generation, JsonObject config) {
        if (generation != recordingGeneration.get() || !recordingService.isRecording()) {
            return;
        }
        if (!livePassInFlight.compareAndSet(false, true)) {
            return;
        }

        try {
            if (recordingService.getCapturedSeconds() < LIVE_MIN_SECONDS) {
                return;
            }
            byte[] wav = recordingService.snapshot(LIVE_WINDOW_SECONDS);
            if (wav.length == 0) {
                return;
            }

            JsonObject target = resolveTranscriptionTarget(config);
            String text = transcriptionService.transcribe(wav, target);

            // Recording may have ended while this pass was running.
            if (generation != recordingGeneration.get()) {
                return;
            }
            String trimmed = text == null ? "" : text.trim();
            if (!trimmed.isEmpty() && !trimmed.equals(lastPartialText.get())) {
                lastPartialText.set(trimmed);
                sendPartialTranscript(trimmed);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // Partial failures are non-fatal: the final transcription on stop is
            // what the user actually receives.
            LOG.debug("[VoiceInput] Live pass failed: " + e.getMessage());
        } finally {
            livePassInFlight.set(false);
        }
    }

    private void stopLiveDictation() {
        java.util.concurrent.ScheduledExecutorService executor = liveExecutor;
        liveExecutor = null;
        if (executor != null) {
            executor.shutdownNow();
            LOG.info("[VoiceInput] Live dictation stopped");
        }
    }

    /**
     * Turn the stored voice config into the effective transcription target.
     *
     * <p>In "local" mode this lazily starts the local Whisper server (loading
     * the model takes a few seconds on first use) and points the request at it
     * with no API key. In "cloud" mode it validates the key up front so the
     * user gets a friendly error instead of an HTTP 401.</p>
     */
    private JsonObject resolveTranscriptionTarget(JsonObject config) throws IOException {
        String mode = config.has("mode") && !config.get("mode").isJsonNull()
                ? config.get("mode").getAsString()
                : "cloud";

        if (!"local".equals(mode)) {
            String apiKey = config.has("apiKey") && !config.get("apiKey").isJsonNull()
                    ? config.get("apiKey").getAsString().trim()
                    : "";
            if (apiKey.isEmpty()) {
                throw new IOException("Transcription API key is not configured. "
                        + "Add one in Settings > Voice & Remote, or set up local Whisper.");
            }
            return config;
        }

        LocalWhisperManager whisper = LocalWhisperManager.getInstance();
        if (!whisper.isInstalled()) {
            throw new IOException("Local Whisper is not set up yet. "
                    + "Use \"Set up local Whisper\" in Settings > Voice & Remote.");
        }

        String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
        if (nodeExecutable == null || nodeExecutable.isBlank()) {
            throw new IOException("Node.js is not configured. Set the Node.js path in Settings > Basic.");
        }
        File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
        if (bridgeDir == null || !bridgeDir.exists()) {
            throw new IOException("AI Bridge directory is not available");
        }

        String localModel = config.has("localModel") && !config.get("localModel").isJsonNull()
                ? config.get("localModel").getAsString().trim()
                : LocalWhisperManager.DEFAULT_MODEL;
        String localDevice = config.has("localDevice") && !config.get("localDevice").isJsonNull()
                ? config.get("localDevice").getAsString().trim()
                : "cpu";

        String baseUrl = whisper.ensureServerRunning(nodeExecutable, bridgeDir, localModel, localDevice);

        JsonObject target = new JsonObject();
        target.addProperty("baseUrl", baseUrl);
        target.addProperty("apiKey", "");
        target.addProperty("model", localModel);
        if (config.has("language") && !config.get("language").isJsonNull()) {
            target.addProperty("language", config.get("language").getAsString());
        }
        return target;
    }

    private void handleRecordCancel() {
        CompletableFuture.runAsync(() -> {
            recordingService.cancel();
            sendRecordingState("idle", false, null);
        });
    }

    private void handleGetConfig() {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject config = context.getSettingsService().getVoiceInputConfig();
                callJavaScript("window.updateVoiceInputConfig", escapeJs(gson.toJson(config)));
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to read voice input config: " + e.getMessage());
            }
        });
    }

    private void handleSetConfig(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject newConfig = gson.fromJson(content, JsonObject.class);
                context.getSettingsService().setVoiceInputConfig(newConfig);
                // Echo the persisted config back so every subscriber converges
                // on the stored (normalized) values.
                JsonObject stored = context.getSettingsService().getVoiceInputConfig();
                callJavaScript("window.updateVoiceInputConfig", escapeJs(gson.toJson(stored)));
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to save voice input config: " + e.getMessage());
            }
        });
    }

    /**
     * Report the local Whisper install/model/server state to the settings UI.
     */
    private void handleGetLocalWhisperStatus() {
        CompletableFuture.runAsync(() -> {
            try {
                LocalWhisperManager whisper = LocalWhisperManager.getInstance();
                JsonObject config = context.getSettingsService().getVoiceInputConfig();
                String localModel = config.get("localModel").getAsString();

                JsonObject payload = new JsonObject();
                payload.addProperty("installed", whisper.isInstalled());
                payload.addProperty("modelReady", whisper.isModelReady(localModel));
                payload.addProperty("serverRunning", whisper.isServerRunning());
                payload.addProperty("localModel", localModel);
                callJavaScript("window.onLocalWhisperStatus", escapeJs(gson.toJson(payload)));
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to get local Whisper status: " + e.getMessage());
            }
        });
    }

    /**
     * "Set up local Whisper" button: npm-install the transformers.js runtime
     * (via DependencyManager, like the other on-demand SDKs), prefetch the
     * chosen model with progress, then switch the voice config to local mode.
     */
    private void handleSetupLocalWhisper(String content) {
        CompletableFuture.runAsync(() -> {
            String model = LocalWhisperManager.DEFAULT_MODEL;
            try {
                JsonObject payload = gson.fromJson(content, JsonObject.class);
                if (payload != null && payload.has("model") && !payload.get("model").isJsonNull()) {
                    String requested = payload.get("model").getAsString().trim();
                    if (!requested.isEmpty()) {
                        model = requested;
                    }
                }
            } catch (RuntimeException e) {
                LOG.debug("[VoiceInput] No/invalid setup payload, using default model");
            }

            try {
                DependencyManager dependencyManager = new DependencyManager();
                if (!dependencyManager.checkNodeEnvironment()) {
                    sendSetupResult(false, "Node.js is not configured. Set the Node.js path in Settings > Basic.");
                    return;
                }

                sendSetupProgress("install", "Installing local Whisper runtime (@huggingface/transformers)...");
                InstallResult installResult = dependencyManager.installSdkSync(
                        LocalWhisperManager.SDK_ID, null,
                        (line) -> sendSetupProgress("install", line));
                if (!installResult.isSuccess()) {
                    sendSetupResult(false, installResult.getErrorMessage());
                    return;
                }

                sendSetupProgress("download", "Downloading model " + model + "...");
                String device = prefetchModelWithFallback(model);

                // Switch voice input to local mode so the mic works immediately,
                // remembering which execution backend actually worked.
                JsonObject config = context.getSettingsService().getVoiceInputConfig();
                config.addProperty("mode", "local");
                config.addProperty("localModel", model);
                config.addProperty("localDevice", device);
                context.getSettingsService().setVoiceInputConfig(config);
                JsonObject stored = context.getSettingsService().getVoiceInputConfig();
                callJavaScript("window.updateVoiceInputConfig", escapeJs(gson.toJson(stored)));

                sendSetupResult(true, null);
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Local Whisper setup failed: " + e.getMessage());
                sendSetupResult(false, e.getMessage());
            } finally {
                handleGetLocalWhisperStatus();
            }
        });
    }

    /**
     * Download the model, falling back from the native ONNX backend to the
     * portable WASM one when the native one hard-crashes.
     *
     * <p>onnxruntime-node aborts the process (SIGABRT, exit 134) on some
     * CPU/glibc combinations. An abort produces no {@code [WHISPER_ERROR]}
     * line, which is how {@link PrefetchCrashException} is distinguished from
     * an ordinary failure (bad model id, no network) that a retry would not
     * fix.</p>
     *
     * @return the device that succeeded ("cpu" or "wasm")
     */
    private String prefetchModelWithFallback(String model) throws IOException, InterruptedException {
        try {
            runModelPrefetch(model, "cpu");
            return "cpu";
        } catch (PrefetchCrashException crash) {
            LOG.warn("[VoiceInput] Native ONNX backend crashed (" + crash.getMessage()
                    + "), retrying with the WASM backend");
            sendSetupProgress("download",
                    "The native speech runtime crashed on this machine — retrying with the portable "
                    + "WASM backend (slower but more compatible)...");
            runModelPrefetch(model, "wasm");
            return "wasm";
        }
    }

    /** Thrown when prefetch.js dies without reporting a diagnosable error. */
    private static final class PrefetchCrashException extends IOException {
        PrefetchCrashException(String message) {
            super(message);
        }
    }

    /**
     * Run prefetch.js so the model download happens during setup (with
     * progress) instead of stalling the first dictation.
     */
    private void runModelPrefetch(String model, String device) throws IOException, InterruptedException {
        String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
        if (nodeExecutable == null || nodeExecutable.isBlank()) {
            throw new IOException("Node.js is not configured");
        }
        File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
        if (bridgeDir == null || !bridgeDir.exists()) {
            throw new IOException("AI Bridge directory is not available");
        }
        File prefetchScript = new File(bridgeDir, "services/whisper-local/prefetch.js");
        if (!prefetchScript.exists()) {
            throw new IOException("Prefetch script not found: " + prefetchScript.getAbsolutePath());
        }

        List<String> command = new ArrayList<>();
        command.add(nodeExecutable);
        command.add(prefetchScript.getAbsolutePath());
        command.add("--root");
        command.add(LocalWhisperManager.getInstance().getWhisperRoot().toString());
        command.add("--model");
        command.add(model);
        command.add("--device");
        command.add(device);

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);
        new EnvironmentConfigurator().updateProcessEnvironment(pb, nodeExecutable);
        // Whisper weight buffers are large; the default heap can abort the
        // process mid-download on 32-bit-ish default limits.
        String existingNodeOptions = pb.environment().getOrDefault("NODE_OPTIONS", "");
        if (!existingNodeOptions.contains("--max-old-space-size")) {
            pb.environment().put("NODE_OPTIONS",
                    (existingNodeOptions + " --max-old-space-size=4096").trim());
        }

        LOG.info("[VoiceInput] Prefetching model: " + String.join(" ", command));
        Process process = pb.start();
        java.util.concurrent.atomic.AtomicReference<String> errorMessage =
                new java.util.concurrent.atomic.AtomicReference<>("");
        // Keep the last few output lines so a hard crash still yields a
        // description instead of a bare exit code.
        java.util.Deque<String> outputTail = new java.util.concurrent.ConcurrentLinkedDeque<>();

        // Drain output on a separate thread so the timeout below stays
        // effective even when the download stalls without producing output.
        Thread outputReader = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.info("[VoiceInput] prefetch: " + line);
                    int progressIdx = line.indexOf("[WHISPER_PROGRESS]");
                    int errorIdx = line.indexOf("[WHISPER_ERROR]");
                    if (progressIdx >= 0) {
                        forwardPrefetchProgress(line.substring(progressIdx + "[WHISPER_PROGRESS]".length()).trim());
                    } else if (errorIdx >= 0) {
                        errorMessage.set(line.substring(errorIdx + "[WHISPER_ERROR]".length()).trim());
                    } else if (!line.contains("[WHISPER_LOG]")) {
                        outputTail.addLast(line);
                        while (outputTail.size() > PREFETCH_TAIL_LINES) {
                            outputTail.removeFirst();
                        }
                    }
                }
            } catch (IOException e) {
                LOG.debug("[VoiceInput] Prefetch output stream closed: " + e.getMessage());
            }
        }, "cc-gui-whisper-prefetch-reader");
        outputReader.setDaemon(true);
        outputReader.start();

        boolean finished = process.waitFor(SETUP_STEP_TIMEOUT_MINUTES, TimeUnit.MINUTES);
        if (!finished) {
            process.destroyForcibly();
            throw new IOException("Model download timed out after " + SETUP_STEP_TIMEOUT_MINUTES + " minutes");
        }
        outputReader.join(5000);

        int exitCode = process.exitValue();
        if (exitCode == 0) {
            return;
        }

        String reportedError = errorMessage.get();
        if (!reportedError.isEmpty()) {
            // The script diagnosed the failure itself (bad model id, no
            // network, ...) — retrying on another backend would not help.
            throw new IOException(reportedError);
        }

        // No diagnosis: the process died on us (SIGABRT from the native ONNX
        // runtime is exit 134). Let the caller retry on the WASM backend.
        String tail = String.join(" | ", outputTail);
        String detail = "exit code " + exitCode
                + (tail.isEmpty() ? "" : ": " + truncate(tail, 400));
        throw new PrefetchCrashException(detail);
    }

    private static String truncate(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max) + "...";
    }

    private void forwardPrefetchProgress(String json) {
        try {
            JsonObject progress = gson.fromJson(json, JsonObject.class);
            String file = progress.has("file") ? progress.get("file").getAsString() : "model";
            int percent = progress.has("progress") ? progress.get("progress").getAsInt() : 0;
            sendSetupProgress("download", file + ": " + percent + "%");
        } catch (RuntimeException e) {
            LOG.debug("[VoiceInput] Unparseable prefetch progress: " + json);
        }
    }

    private void sendSetupProgress(String phase, String message) {
        JsonObject payload = new JsonObject();
        payload.addProperty("phase", phase);
        payload.addProperty("message", message);
        callJavaScript("window.onLocalWhisperSetupProgress", escapeJs(gson.toJson(payload)));
    }

    private void sendSetupResult(boolean success, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", success);
        if (error != null) {
            payload.addProperty("error", error);
        }
        callJavaScript("window.onLocalWhisperSetupResult", escapeJs(gson.toJson(payload)));
    }

    private void sendRecordingState(String state, boolean live, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("state", state);
        // Tells the composer which button is active, so it can show the right
        // stop affordance.
        payload.addProperty("live", live);
        if (error != null) {
            payload.addProperty("error", error);
        }
        callJavaScript("window.onVoiceRecordingState", escapeJs(gson.toJson(payload)));
    }

    private void sendPartialTranscript(String text) {
        JsonObject payload = new JsonObject();
        payload.addProperty("text", text);
        callJavaScript("window.onVoicePartialTranscript", escapeJs(gson.toJson(payload)));
    }

    private void sendTranscript(boolean success, String text, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", success);
        if (text != null) {
            payload.addProperty("text", text);
        }
        if (error != null) {
            payload.addProperty("error", error);
        }
        callJavaScript("window.onVoiceTranscript", escapeJs(gson.toJson(payload)));
    }
}
