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
 * window.onVoiceTranscript({success, text?, error?})             (Java -> JS)
 * window.updateVoiceInputConfig({enabled, baseUrl, ...})         (Java -> JS)
 * </pre>
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

    private final Gson gson = new Gson();
    private final VoiceRecordingService recordingService = new VoiceRecordingService();
    private final VoiceTranscriptionService transcriptionService = new VoiceTranscriptionService();

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
                handleRecordStart();
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

    private void handleRecordStart() {
        CompletableFuture.runAsync(() -> {
            try {
                recordingService.start();
                sendRecordingState("recording", null);
            } catch (Exception e) {
                LOG.warn("[VoiceInput] Failed to start recording: " + e.getMessage());
                sendRecordingState("idle", "Could not access the microphone: " + e.getMessage());
            }
        });
    }

    private void handleRecordStop() {
        CompletableFuture.runAsync(() -> {
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

            sendRecordingState("transcribing", null);
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

        String baseUrl = whisper.ensureServerRunning(nodeExecutable, bridgeDir, localModel);

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
            sendRecordingState("idle", null);
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
                runModelPrefetch(model);

                // Switch voice input to local mode so the mic works immediately.
                JsonObject config = context.getSettingsService().getVoiceInputConfig();
                config.addProperty("mode", "local");
                config.addProperty("localModel", model);
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
     * Run prefetch.js so the model download happens during setup (with
     * progress) instead of stalling the first dictation.
     */
    private void runModelPrefetch(String model) throws IOException, InterruptedException {
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

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);
        new EnvironmentConfigurator().updateProcessEnvironment(pb, nodeExecutable);

        LOG.info("[VoiceInput] Prefetching model: " + String.join(" ", command));
        Process process = pb.start();
        java.util.concurrent.atomic.AtomicReference<String> errorMessage =
                new java.util.concurrent.atomic.AtomicReference<>("");

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

        if (process.exitValue() != 0) {
            String error = errorMessage.get();
            throw new IOException(!error.isEmpty()
                    ? error
                    : "Model download failed (exit code " + process.exitValue() + ")");
        }
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

    private void sendRecordingState(String state, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("state", state);
        if (error != null) {
            payload.addProperty("error", error);
        }
        callJavaScript("window.onVoiceRecordingState", escapeJs(gson.toJson(payload)));
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
