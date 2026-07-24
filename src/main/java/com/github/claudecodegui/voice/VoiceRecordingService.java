package com.github.claudecodegui.voice;

import com.intellij.openapi.diagnostic.Logger;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.DataLine;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.TargetDataLine;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * Records microphone audio on the IDE (JVM) side.
 *
 * <p>Capture happens in Java instead of the webview because JCEF — especially
 * in off-screen-rendering mode on Linux — does not reliably expose
 * {@code getUserMedia}, and the plugin installs no Chromium media permission
 * handler. {@code javax.sound.sampled} works on all IDE platforms without
 * touching the browser layer.</p>
 *
 * <p>Audio is captured as 16 kHz / 16-bit / mono PCM (the standard input format
 * for Whisper-style transcription models) and returned as an in-memory WAV file.</p>
 */
public class VoiceRecordingService {

    private static final Logger LOG = Logger.getInstance(VoiceRecordingService.class);

    private static final float SAMPLE_RATE = 16000f;
    private static final int SAMPLE_SIZE_BITS = 16;
    private static final int CHANNELS = 1;
    /** Hard cap so a forgotten recording cannot grow unbounded (~4 min ≈ 7.7 MB). */
    private static final long MAX_RECORDING_MILLIS = 4 * 60 * 1000L;

    private final Object lock = new Object();
    private TargetDataLine line;
    private Thread captureThread;
    private ByteArrayOutputStream captureBuffer;
    private volatile boolean capturing = false;

    public boolean isRecording() {
        return capturing;
    }

    /**
     * Start capturing from the default microphone.
     *
     * @throws LineUnavailableException when no capture device is available
     * @throws IllegalStateException when a recording is already in progress
     */
    public void start() throws LineUnavailableException {
        synchronized (lock) {
            if (capturing) {
                throw new IllegalStateException("Recording already in progress");
            }

            AudioFormat format = new AudioFormat(SAMPLE_RATE, SAMPLE_SIZE_BITS, CHANNELS, true, false);
            DataLine.Info info = new DataLine.Info(TargetDataLine.class, format);
            if (!AudioSystem.isLineSupported(info)) {
                throw new LineUnavailableException("No microphone line supports 16kHz/16-bit/mono PCM");
            }

            line = (TargetDataLine) AudioSystem.getLine(info);
            line.open(format);
            line.start();

            captureBuffer = new ByteArrayOutputStream();
            capturing = true;

            long maxBytes = (long) (SAMPLE_RATE * (SAMPLE_SIZE_BITS / 8) * CHANNELS
                    * (MAX_RECORDING_MILLIS / 1000.0));

            // Capture a local reference: the stop path nulls the field while the
            // capture thread may still be blocked inside read().
            final TargetDataLine captureLine = line;
            captureThread = new Thread(() -> {
                byte[] chunk = new byte[4096];
                try {
                    while (capturing) {
                        int read = captureLine.read(chunk, 0, chunk.length);
                        if (read <= 0) {
                            continue;
                        }
                        synchronized (lock) {
                            if (captureBuffer == null) {
                                break;
                            }
                            captureBuffer.write(chunk, 0, read);
                            if (captureBuffer.size() >= maxBytes) {
                                LOG.warn("[VoiceRecording] Max recording length reached, stopping capture");
                                capturing = false;
                            }
                        }
                    }
                } catch (RuntimeException e) {
                    LOG.warn("[VoiceRecording] Capture loop terminated: " + e.getMessage());
                }
            }, "cc-gui-voice-capture");
            captureThread.setDaemon(true);
            captureThread.start();

            LOG.info("[VoiceRecording] Recording started");
        }
    }

    /**
     * Stop capturing and return the recorded audio as a WAV file.
     *
     * @return WAV bytes, or an empty array if nothing was captured
     */
    public byte[] stop() throws IOException {
        byte[] pcm = stopInternal();
        if (pcm.length == 0) {
            return new byte[0];
        }

        AudioFormat format = new AudioFormat(SAMPLE_RATE, SAMPLE_SIZE_BITS, CHANNELS, true, false);
        long frameCount = pcm.length / format.getFrameSize();
        try (AudioInputStream audioStream = new AudioInputStream(new ByteArrayInputStream(pcm), format, frameCount);
             ByteArrayOutputStream wavOut = new ByteArrayOutputStream()) {
            AudioSystem.write(audioStream, javax.sound.sampled.AudioFileFormat.Type.WAVE, wavOut);
            LOG.info("[VoiceRecording] Recording stopped, " + pcm.length + " PCM bytes captured");
            return wavOut.toByteArray();
        }
    }

    /**
     * Snapshot the audio captured so far <em>without</em> stopping the
     * recording, as a self-contained WAV file. Used for live (rolling-window)
     * dictation: each snapshot is re-transcribed to produce a partial result.
     *
     * <p>Whisper consumes fixed 30-second windows, so only the most recent
     * {@code maxSeconds} of audio is returned. Re-transcribing the tail keeps
     * latency bounded no matter how long the user talks; text older than the
     * window has already been committed by the caller.</p>
     *
     * @param maxSeconds how many trailing seconds to include (<= 0 means all)
     * @return WAV bytes, or an empty array when nothing has been captured yet
     */
    public byte[] snapshot(double maxSeconds) throws IOException {
        byte[] pcm;
        synchronized (lock) {
            if (captureBuffer == null) {
                return new byte[0];
            }
            pcm = captureBuffer.toByteArray();
        }
        if (pcm.length == 0) {
            return new byte[0];
        }

        AudioFormat format = new AudioFormat(SAMPLE_RATE, SAMPLE_SIZE_BITS, CHANNELS, true, false);
        int frameSize = format.getFrameSize();

        if (maxSeconds > 0) {
            int maxBytes = (int) (SAMPLE_RATE * frameSize * maxSeconds);
            if (pcm.length > maxBytes) {
                // Trim from the start, keeping the offset frame-aligned so we
                // never slice a sample in half (which would inject a click).
                int offset = pcm.length - maxBytes;
                offset -= offset % frameSize;
                pcm = java.util.Arrays.copyOfRange(pcm, offset, pcm.length);
            }
        }

        long frameCount = pcm.length / frameSize;
        try (AudioInputStream audioStream = new AudioInputStream(new ByteArrayInputStream(pcm), format, frameCount);
             ByteArrayOutputStream wavOut = new ByteArrayOutputStream()) {
            AudioSystem.write(audioStream, javax.sound.sampled.AudioFileFormat.Type.WAVE, wavOut);
            return wavOut.toByteArray();
        }
    }

    /**
     * Duration of audio captured so far, in seconds.
     */
    public double getCapturedSeconds() {
        synchronized (lock) {
            if (captureBuffer == null) {
                return 0;
            }
            return captureBuffer.size() / (SAMPLE_RATE * (SAMPLE_SIZE_BITS / 8.0) * CHANNELS);
        }
    }

    /** Stop capturing and discard everything recorded so far. */
    public void cancel() {
        try {
            stopInternal();
            LOG.info("[VoiceRecording] Recording cancelled");
        } catch (RuntimeException e) {
            LOG.warn("[VoiceRecording] Cancel failed: " + e.getMessage());
        }
    }

    private byte[] stopInternal() {
        Thread threadToJoin;
        synchronized (lock) {
            if (!capturing && captureBuffer == null) {
                return new byte[0];
            }
            capturing = false;
            threadToJoin = captureThread;

            if (line != null) {
                try {
                    line.stop();
                    line.close();
                } catch (RuntimeException e) {
                    LOG.warn("[VoiceRecording] Failed to close microphone line: " + e.getMessage());
                }
                line = null;
            }
        }

        if (threadToJoin != null) {
            try {
                threadToJoin.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        synchronized (lock) {
            captureThread = null;
            byte[] pcm = captureBuffer != null ? captureBuffer.toByteArray() : new byte[0];
            captureBuffer = null;
            return pcm;
        }
    }
}
