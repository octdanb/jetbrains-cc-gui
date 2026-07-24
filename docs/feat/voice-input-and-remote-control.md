# Voice Input (Speech-to-Text) & Remote Control

Two features added on top of the stock plugin:

1. **Voice input** — dictate prompts with your voice in Plan Mode and Agent Mode.
2. **Remote Control** — pair a `claude remote-control` session with the Claude
   mobile app / claude.ai so permission prompts and questions can be answered
   from your phone.

Both are configured under **Settings → Voice & Remote**.

---

## 1. Voice Input

### UX

- A microphone button appears on the right side of the composer toolbar when the
  permission mode is **Plan Mode** (`plan`) or **Agent Mode** (`acceptEdits`),
  and the feature is enabled in settings (default: enabled).
- Click to start recording (button pulses red), click again to stop. The audio
  is transcribed and the text is inserted at the caret in the input box.
- Recording is capped at 4 minutes as a safety limit.
- **When dictation is not set up yet** the mic is still shown but dimmed
  (`.is-unavailable`), and its tooltip — plus a toast on click — says exactly
  what to do ("open Settings → Voice & Remote and click Set up local Whisper",
  or "the model has not been downloaded yet", or for cloud mode "add an API
  key"). It stays clickable on purpose: a dead button explains nothing.
  Readiness comes from `useVoiceInput`, which combines the voice config with
  the shared local-Whisper status store.

### Architecture

Audio is captured on the **Java side**, not in the webview:

- JCEF does not reliably expose `getUserMedia` (the plugin runs the browser in
  off-screen-rendering mode on Linux and installs no Chromium media permission
  handler), so browser-side capture would be fragile.
- `javax.sound.sampled` works on every IDE platform. Capture format is
  16 kHz / 16-bit / mono PCM, wrapped as WAV.

Transcription supports two engines (Settings → Voice & Remote → "Transcription
engine"):

- **Local Whisper (default)** — a one-click "Set up local Whisper" flow installs
  a fully offline transcription runtime; no API key, audio never leaves the
  machine. See "Local Whisper" below.
- **Cloud API** — posts the WAV to an OpenAI-compatible endpoint
  (`{baseUrl}/audio/transcriptions`, Whisper API shape) using
  `java.net.http.HttpClient`. Any proxy that implements this API works.

### Message flow

```
webview                          Java (plugin)
-------                          -------------
voice_record_start        ->     VoiceInputHandler -> VoiceRecordingService.start()
                          <-     window.onVoiceRecordingState({state:'recording'})
voice_record_stop         ->     stop() -> WAV bytes
                          <-     window.onVoiceRecordingState({state:'transcribing'})
                                 VoiceTranscriptionService.transcribe(wav, config)
                          <-     window.onVoiceTranscript({success, text?, error?})
voice_record_cancel       ->     cancel(), discard audio
get_voice_input_config    ->
                          <-     window.updateVoiceInputConfig({...})
set_voice_input_config    ->     persist, echo stored config back
```

### Key files

| Layer | File |
|---|---|
| Composer hook | `webview/src/components/ChatInputBox/hooks/useVoiceInput.ts` |
| Mic button | `webview/src/components/ChatInputBox/ButtonArea.tsx` |
| Shared config store | `webview/src/utils/voiceInputConfig.ts` |
| Settings UI | `webview/src/components/settings/VoiceRemoteSection/` |
| Bridge handler | `src/main/java/com/github/claudecodegui/handler/VoiceInputHandler.java` |
| Recording | `src/main/java/com/github/claudecodegui/voice/VoiceRecordingService.java` |
| Transcription | `src/main/java/com/github/claudecodegui/voice/VoiceTranscriptionService.java` |
| Persistence | `CodemossSettingsService.getVoiceInputConfig()` / `setVoiceInputConfig()` (`voiceInput` key) |

### Settings

Stored in the Codemoss config under `voiceInput`:

```json
{
  "voiceInput": {
    "enabled": true,
    "mode": "local",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "whisper-1",
    "language": "",
    "localModel": "Xenova/whisper-base",
    "localDevice": "cpu"
  }
}
```

`mode` is `"local"` (default) or `"cloud"`. `language` is an optional ISO-639-1
hint; empty means auto-detect. `localDevice` is `"cpu"` (native ONNX) or
`"wasm"` (portable fallback) — see "Execution backends" below. It must survive
config round-trips through the webview store, or a working `wasm` fallback would
be reset to `cpu` and the native crash would return.

### Local Whisper

"Set up local Whisper" (Settings → Voice & Remote) makes dictation fully
offline:

1. **Install** — `@huggingface/transformers` (transformers.js v3 +
   onnxruntime-node, no compilers needed) is npm-installed into
   `~/.codemoss/dependencies/whisper-local` via the existing
   `DependencyManager` machinery (new `SdkDefinition.WHISPER_LOCAL`), with all
   its retry/cache/WSL handling.
2. **Prefetch** — `ai-bridge/services/whisper-local/prefetch.js` downloads the
   chosen ONNX model (q8-quantized) from Hugging Face into `<root>/models`,
   streaming progress lines (`[WHISPER_PROGRESS] {...}`) that the settings UI
   shows live. `HF_ENDPOINT` is honoured for mirror users.
3. **Switch** — on success the voice config flips to `mode: "local"` with the
   chosen `localModel`.

At transcription time, `LocalWhisperManager` (application-wide singleton)
lazily starts `ai-bridge/services/whisper-local/server.js` — a small
OpenAI-compatible HTTP server on `127.0.0.1:<ephemeral>` — waits for its
`[WHISPER_READY] {"port":N}` line, and the normal `VoiceTranscriptionService`
posts to it with no API key (loopback requests bypass any HTTP proxy). The
server is restarted when the model changes, exits when the IDE closes its
stdin, and is killed by a JVM shutdown hook as a belt-and-braces measure.

Model choices offered in the UI: `Xenova/whisper-tiny` (~40 MB),
`Xenova/whisper-base` (~80 MB, default), `Xenova/whisper-small` (~250 MB).
All are multilingual; the server drops the language hint for `.en` models.

#### Execution backends (and the exit-134 fallback)

`onnxruntime-node` (the fast native backend) aborts the whole process — SIGABRT,
**exit code 134** — on some CPU/glibc combinations. Setup handles this
automatically:

1. Prefetch runs with `--device cpu`. Because it also *instantiates* the ONNX
   session (not just downloads weights), a machine that cannot run the native
   backend fails here, at setup time, rather than on the user's first dictation.
2. A hard crash is distinguishable from an ordinary failure: the script emits no
   `[WHISPER_ERROR]` line when it is killed, so a non-zero exit *without* that
   marker raises `PrefetchCrashException`, while a diagnosed failure (bad model
   id, no network) is reported as-is and not retried.
3. On a crash, setup retries with `--device wasm` (onnxruntime-web, single
   threaded — SharedArrayBuffer threading is the other common abort source),
   tells the user in the progress line, and persists `localDevice: "wasm"` so
   `LocalWhisperManager` starts the server on the same backend.

Both the prefetch and server processes also get `NODE_OPTIONS
--max-old-space-size=4096` (unless already set), since Whisper weight buffers
can otherwise exhaust the default heap mid-load. When a crash yields no
diagnosis, the last few non-`[WHISPER_LOG]` output lines are quoted in the error
message instead of a bare exit code.

The settings panel shows a note whenever `localDevice` is `wasm` so the slower
transcription is not a mystery; re-running setup retries the native backend.

Message flow:

```
get_local_whisper_status  ->
                          <-  window.onLocalWhisperStatus({installed, modelReady, serverRunning, localModel})
setup_local_whisper {model} ->  npm install -> prefetch model -> switch config to local
                          <-  window.onLocalWhisperSetupProgress({phase, message})  (streamed)
                          <-  window.onLocalWhisperSetupResult({success, error?})
```

Key files:

| Layer | File |
|---|---|
| HTTP server | `ai-bridge/services/whisper-local/server.js` (+ `create-server.js`) |
| Runtime loader | `ai-bridge/services/whisper-local/whisper-runtime.js` |
| WAV/multipart | `ai-bridge/services/whisper-local/audio-utils.js` (unit + HTTP tests alongside) |
| Model prefetch | `ai-bridge/services/whisper-local/prefetch.js` |
| Server lifecycle | `src/main/java/com/github/claudecodegui/voice/LocalWhisperManager.java` |
| Install definition | `SdkDefinition.WHISPER_LOCAL` (`@huggingface/transformers`) |

---

## 2. Remote Control

### What it does

**Settings → Voice & Remote → Launch Remote Control** opens a new IDE terminal
tab running:

```
claude remote-control --name "<project name>" [-c]
```

- The terminal prints a session URL; pressing **Space** shows a QR code.
- Scan the QR with the Claude iOS/Android app (or open the URL / find the
  session on claude.ai/code) to pair.
- Sessions started from the phone run on your machine in the project directory,
  and permission prompts / `AskUserQuestion` prompts are answered from the app.
- The `-c` checkbox resumes the most recent Remote Control session for the
  project (Claude Code v2.1.200+).

The custom claude CLI path from **Settings → Basic** is used when configured
(same property the daemon uses); otherwise `claude` is resolved from `PATH`.

### Why the IDE terminal, not the ai-bridge daemon

This plugin drives Claude through the **Agent SDK** (`query()` over a managed
subprocess). The Claude CLI **does not support Remote Control for
programmatically driven sessions** — it cannot be combined with
`--input-format stream-json` / `--print` and requires an interactive TTY.
That means the plugin's own chat sessions can never be remote-controlled;
the supported integration is running the Remote Control server as a real
interactive terminal session, which the IDE terminal provides (including
native QR rendering).

Requirements (enforced by the CLI itself, surfaced in the settings UI):

- Claude Code **v2.1.52+**
- Signed in with a **claude.ai** account (Pro/Max/Team/Enterprise); not
  available with plain API keys, Bedrock, or other non-Anthropic endpoints
- Team/Enterprise: an Owner must enable Remote Control in admin settings
- The **Terminal** plugin must be enabled in the IDE (it is an optional
  dependency of this plugin)

### Key files

| Layer | File |
|---|---|
| Settings UI | `webview/src/components/settings/VoiceRemoteSection/` |
| Bridge handler | `src/main/java/com/github/claudecodegui/handler/RemoteControlHandler.java` |

`RemoteControlHandler` reaches the terminal API via reflection (same approach
as `TerminalMonitorService`) so the Terminal plugin stays optional:
`TerminalToolWindowManager.createShellWidget(...)` on 2024.1+, falling back to
`createLocalShellWidget(...)` / legacy `TerminalView`.

**Reflection gotcha (fixed):** `createShellWidget` returns a *package-private*
implementation — `JBTerminalWidget$TerminalWidgetBridge`. Resolving
`sendCommandToExecute` on that runtime class yields a `Method` whose declaring
class is inaccessible from our package, so `invoke` throws

```
class ...RemoteControlHandler cannot access a member of class
com.intellij.terminal.JBTerminalWidget$TerminalWidgetBridge with modifiers "public"
```

`invokeWidgetMethod` therefore resolves the method against a **public
supertype** (interface or superclass) via `findPubliclyAccessibleMethod`, which
walks the hierarchy and only considers classes/interfaces that are themselves
public. `trySetAccessible()` remains as a last-resort fallback.

### Message flow

```
remote_control_launch {continueSession}  ->  open terminal tab + run command
                                         <-  window.onRemoteControlLaunched({success, error?})
```
