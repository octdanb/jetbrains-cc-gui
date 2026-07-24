package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.voice.VoiceRecordingService;
import com.github.claudecodegui.voice.VoiceTranscriptionService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;

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
        "set_voice_input_config"
    };

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
                String text = transcriptionService.transcribe(wavBytes, config);
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
