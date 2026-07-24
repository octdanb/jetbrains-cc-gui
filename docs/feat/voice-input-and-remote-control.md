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

### Architecture

Audio is captured on the **Java side**, not in the webview:

- JCEF does not reliably expose `getUserMedia` (the plugin runs the browser in
  off-screen-rendering mode on Linux and installs no Chromium media permission
  handler), so browser-side capture would be fragile.
- `javax.sound.sampled` works on every IDE platform. Capture format is
  16 kHz / 16-bit / mono PCM, wrapped as WAV.

Transcription posts the WAV to an **OpenAI-compatible** endpoint
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
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "whisper-1",
    "language": ""
  }
}
```

`language` is an optional ISO-639-1 hint; empty means auto-detect.

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

### Message flow

```
remote_control_launch {continueSession}  ->  open terminal tab + run command
                                         <-  window.onRemoteControlLaunched({success, error?})
```
