package com.github.claudecodegui.voice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

/**
 * Sends recorded audio to an OpenAI-compatible {@code /audio/transcriptions}
 * endpoint (Whisper API shape) and returns the transcript text.
 *
 * <p>The endpoint, key and model come from the {@code voiceInput} section of
 * the Codemoss settings, so any OpenAI-compatible proxy works.</p>
 */
public class VoiceTranscriptionService {

    private static final Logger LOG = Logger.getInstance(VoiceTranscriptionService.class);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(60);

    /**
     * Transcribe a WAV recording.
     *
     * @param wavBytes recorded audio (WAV container)
     * @param config voice input config: {baseUrl, apiKey, model, language}
     * @return transcript text (may be empty when no speech was detected)
     * @throws IOException on network/HTTP/parsing failure or missing configuration
     */
    public String transcribe(byte[] wavBytes, JsonObject config) throws IOException, InterruptedException {
        String baseUrl = getString(config, "baseUrl");
        String apiKey = getString(config, "apiKey");
        String model = getString(config, "model");
        String language = getString(config, "language");

        if (baseUrl.isEmpty()) {
            throw new IOException("Transcription base URL is not configured");
        }
        if (apiKey.isEmpty()) {
            throw new IOException("Transcription API key is not configured");
        }
        if (model.isEmpty()) {
            model = "whisper-1";
        }

        String endpoint = baseUrl.replaceAll("/+$", "") + "/audio/transcriptions";
        String boundary = "----cc-gui-voice-" + UUID.randomUUID();

        byte[] body = buildMultipartBody(boundary, wavBytes, model, language);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .timeout(REQUEST_TIMEOUT)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .build();

        LOG.info("[VoiceTranscription] POST " + endpoint + " (model=" + model + ", "
                + wavBytes.length + " bytes)");
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            String detail = summarizeErrorBody(response.body());
            throw new IOException("Transcription request failed (HTTP " + response.statusCode() + ")"
                    + (detail.isEmpty() ? "" : ": " + detail));
        }

        try {
            JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
            if (json.has("text") && !json.get("text").isJsonNull()) {
                return json.get("text").getAsString();
            }
            return "";
        } catch (RuntimeException e) {
            throw new IOException("Unexpected transcription response format", e);
        }
    }

    private static byte[] buildMultipartBody(String boundary, byte[] wavBytes, String model, String language)
            throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String lineEnd = "\r\n";

        writeFormField(out, boundary, "model", model);
        if (!language.isEmpty()) {
            writeFormField(out, boundary, "language", language);
        }
        writeFormField(out, boundary, "response_format", "json");

        out.write(("--" + boundary + lineEnd).getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"" + lineEnd)
                .getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Type: audio/wav" + lineEnd + lineEnd).getBytes(StandardCharsets.UTF_8));
        out.write(wavBytes);
        out.write(lineEnd.getBytes(StandardCharsets.UTF_8));

        out.write(("--" + boundary + "--" + lineEnd).getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    private static void writeFormField(ByteArrayOutputStream out, String boundary, String name, String value)
            throws IOException {
        String lineEnd = "\r\n";
        out.write(("--" + boundary + lineEnd).getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Disposition: form-data; name=\"" + name + "\"" + lineEnd + lineEnd)
                .getBytes(StandardCharsets.UTF_8));
        out.write((value + lineEnd).getBytes(StandardCharsets.UTF_8));
    }

    private static String getString(JsonObject config, String key) {
        if (config != null && config.has(key) && !config.get(key).isJsonNull()) {
            try {
                return config.get(key).getAsString().trim();
            } catch (RuntimeException e) {
                return "";
            }
        }
        return "";
    }

    /**
     * Extract a short, key-free error description from an API error body.
     * Never returns the raw body to avoid echoing sensitive request data into
     * logs or the UI.
     */
    private static String summarizeErrorBody(String body) {
        if (body == null || body.isEmpty()) {
            return "";
        }
        try {
            JsonObject json = JsonParser.parseString(body).getAsJsonObject();
            if (json.has("error") && json.get("error").isJsonObject()) {
                JsonObject error = json.getAsJsonObject("error");
                if (error.has("message") && !error.get("message").isJsonNull()) {
                    String message = error.get("message").getAsString();
                    return message.length() > 300 ? message.substring(0, 300) : message;
                }
            }
        } catch (RuntimeException ignored) {
            // Not JSON — fall through to a generic message.
        }
        return "";
    }
}
