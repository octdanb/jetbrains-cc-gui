package com.github.claudecodegui.voice;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.dependency.DependencyManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Manages the local Whisper transcription runtime:
 *
 * <ul>
 *   <li>Install state — {@code @huggingface/transformers} lives under
 *       {@code ~/.codemoss/dependencies/whisper-local} (installed via
 *       {@link DependencyManager} like the other on-demand SDKs), with ONNX
 *       models cached under {@code <root>/models}.</li>
 *   <li>Server lifecycle — a single Node process running
 *       {@code ai-bridge/services/whisper-local/server.js}, bound to
 *       127.0.0.1 on an ephemeral port. Started lazily on the first local
 *       transcription and restarted when the model changes.</li>
 * </ul>
 *
 * <p>Application-wide singleton: one server serves all open projects.</p>
 */
public final class LocalWhisperManager {

    private static final Logger LOG = Logger.getInstance(LocalWhisperManager.class);
    private static final LocalWhisperManager INSTANCE = new LocalWhisperManager();

    public static final String SDK_ID = "whisper-local";
    public static final String DEFAULT_MODEL = "Xenova/whisper-base";
    /** Max time for the server to load the model and report READY. */
    private static final long SERVER_START_TIMEOUT_SECONDS = 180;

    private final Object lock = new Object();
    private Process serverProcess;
    private int serverPort = -1;
    private String serverModel;
    private volatile boolean shutdownHookInstalled = false;

    private LocalWhisperManager() {
    }

    public static LocalWhisperManager getInstance() {
        return INSTANCE;
    }

    public Path getWhisperRoot() {
        return new DependencyManager().getSdkDir(SDK_ID);
    }

    public boolean isInstalled() {
        return new DependencyManager().isInstalled(SDK_ID);
    }

    /**
     * Whether the given model's files are present in the local cache.
     * transformers.js caches under {@code <root>/models/<org>/<name>/}.
     */
    public boolean isModelReady(String model) {
        if (model == null || model.isBlank()) {
            return false;
        }
        Path modelDir = getWhisperRoot().resolve("models");
        for (String part : model.split("/")) {
            modelDir = modelDir.resolve(part);
        }
        try {
            if (!Files.isDirectory(modelDir)) {
                return false;
            }
            try (var entries = Files.list(modelDir)) {
                return entries.findAny().isPresent();
            }
        } catch (IOException e) {
            return false;
        }
    }

    public boolean isServerRunning() {
        synchronized (lock) {
            return serverProcess != null && serverProcess.isAlive() && serverPort > 0;
        }
    }

    /**
     * Ensure the transcription server is running with the given model and
     * return its base URL (e.g. {@code http://127.0.0.1:51234/v1}).
     *
     * <p>Blocking (model load can take seconds) — call from a background thread.</p>
     */
    public String ensureServerRunning(String nodeExecutable, File bridgeDir, String model) throws IOException {
        String effectiveModel = (model == null || model.isBlank()) ? DEFAULT_MODEL : model.trim();

        synchronized (lock) {
            if (serverProcess != null && serverProcess.isAlive() && serverPort > 0
                    && effectiveModel.equals(serverModel)) {
                return baseUrl();
            }

            stopServerLocked();

            File serverScript = new File(bridgeDir, "services/whisper-local/server.js");
            if (!serverScript.exists()) {
                throw new IOException("Local Whisper server script not found: " + serverScript.getAbsolutePath());
            }

            List<String> command = new ArrayList<>();
            command.add(nodeExecutable);
            command.add(serverScript.getAbsolutePath());
            command.add("--root");
            command.add(getWhisperRoot().toString());
            command.add("--model");
            command.add(effectiveModel);

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            new EnvironmentConfigurator().updateProcessEnvironment(pb, nodeExecutable);

            LOG.info("[LocalWhisper] Starting server: " + String.join(" ", command));
            Process process = pb.start();

            BlockingQueue<String> lines = new LinkedBlockingQueue<>();
            Thread reader = new Thread(() -> {
                try (BufferedReader in = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) {
                        lines.offer(line);
                        LOG.info("[LocalWhisper] " + line);
                    }
                } catch (IOException e) {
                    LOG.debug("[LocalWhisper] Server output stream closed: " + e.getMessage());
                }
            }, "cc-gui-whisper-server-reader");
            reader.setDaemon(true);
            reader.start();

            int port;
            try {
                port = awaitReady(process, lines);
            } catch (IOException | RuntimeException e) {
                process.destroyForcibly();
                throw e;
            }

            serverProcess = process;
            serverPort = port;
            serverModel = effectiveModel;
            installShutdownHook();
            watchExit(process);
            LOG.info("[LocalWhisper] Server ready on port " + port + " (model=" + effectiveModel + ")");
            return baseUrl();
        }
    }

    public void stopServer() {
        synchronized (lock) {
            stopServerLocked();
        }
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + serverPort + "/v1";
    }

    private int awaitReady(Process process, BlockingQueue<String> lines) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(SERVER_START_TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            String line;
            try {
                line = lines.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while starting local Whisper server");
            }

            if (line == null) {
                if (!process.isAlive()) {
                    throw new IOException("Local Whisper server exited with code " + process.exitValue());
                }
                continue;
            }

            int readyIdx = line.indexOf("[WHISPER_READY]");
            if (readyIdx >= 0) {
                String json = line.substring(readyIdx + "[WHISPER_READY]".length()).trim();
                int port = parsePort(json);
                if (port > 0) {
                    return port;
                }
                throw new IOException("Local Whisper server reported an invalid port: " + json);
            }

            int errorIdx = line.indexOf("[WHISPER_ERROR]");
            if (errorIdx >= 0) {
                throw new IOException(line.substring(errorIdx + "[WHISPER_ERROR]".length()).trim());
            }
        }
        throw new IOException("Local Whisper server did not start within "
                + SERVER_START_TIMEOUT_SECONDS + " seconds");
    }

    /**
     * Extract the port from the READY payload, e.g. {@code {"port":51234,"model":"..."}}.
     * A tiny regex keeps this class free of a JSON dependency.
     */
    private static int parsePort(String json) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\"port\"\\s*:\\s*(\\d+)").matcher(json);
        if (matcher.find()) {
            try {
                return Integer.parseInt(matcher.group(1));
            } catch (NumberFormatException e) {
                return -1;
            }
        }
        return -1;
    }

    private void stopServerLocked() {
        if (serverProcess != null) {
            LOG.info("[LocalWhisper] Stopping server (port " + serverPort + ")");
            serverProcess.destroy();
            try {
                if (!serverProcess.waitFor(3, TimeUnit.SECONDS)) {
                    serverProcess.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                serverProcess.destroyForcibly();
            }
        }
        serverProcess = null;
        serverPort = -1;
        serverModel = null;
    }

    private void watchExit(Process process) {
        process.onExit().thenRun(() -> {
            synchronized (lock) {
                if (serverProcess == process) {
                    LOG.info("[LocalWhisper] Server process exited");
                    serverProcess = null;
                    serverPort = -1;
                    serverModel = null;
                }
            }
        });
    }

    private void installShutdownHook() {
        if (shutdownHookInstalled) {
            return;
        }
        shutdownHookInstalled = true;
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            synchronized (lock) {
                if (serverProcess != null) {
                    serverProcess.destroyForcibly();
                }
            }
        }, "cc-gui-whisper-shutdown"));
    }
}
