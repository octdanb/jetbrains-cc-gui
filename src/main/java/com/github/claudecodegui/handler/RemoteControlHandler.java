package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.lang.reflect.Method;

/**
 * Remote Control message handler.
 *
 * <p>Launches {@code claude remote-control} in the IDE's integrated terminal so
 * the user can pair the session with the Claude mobile app / claude.ai (QR code
 * or session URL) and answer permission prompts and questions from their phone.</p>
 *
 * <p>Why the terminal instead of the ai-bridge daemon: the Claude CLI only
 * supports Remote Control for interactive terminal sessions. It cannot be
 * enabled on programmatically driven sessions (Agent SDK / stream-json), which
 * is how this plugin runs Claude, and the CLI refuses to start Remote Control
 * without a TTY. The IDE terminal gives it a real interactive PTY, and the QR
 * code renders natively there.</p>
 *
 * <p>The Terminal plugin is an optional dependency, so all terminal API access
 * goes through reflection (same approach as {@code TerminalMonitorService}).</p>
 */
public class RemoteControlHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(RemoteControlHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "remote_control_launch"
    };

    private static final String TERMINAL_TAB_NAME = "Claude Remote Control";

    private final Gson gson = new Gson();

    public RemoteControlHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("remote_control_launch".equals(type)) {
            handleLaunch(content);
            return true;
        }
        return false;
    }

    private void handleLaunch(String content) {
        boolean continueSession = false;
        try {
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            if (payload != null && payload.has("continueSession") && !payload.get("continueSession").isJsonNull()) {
                continueSession = payload.get("continueSession").getAsBoolean();
            }
        } catch (RuntimeException e) {
            LOG.debug("[RemoteControl] No/invalid launch payload, using defaults");
        }

        String command = buildCommand(continueSession);
        String workingDirectory = context.resolveEffectiveWorkingDirectory();

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                openInTerminal(context.getProject(), workingDirectory, command);
                LOG.info("[RemoteControl] Launched in IDE terminal: " + command);
                sendResult(true, null);
            } catch (ClassNotFoundException e) {
                LOG.warn("[RemoteControl] Terminal plugin not available", e);
                sendResult(false, "The Terminal plugin is not enabled. Enable it in Settings | Plugins and try again.");
            } catch (Exception e) {
                LOG.warn("[RemoteControl] Failed to launch: " + e.getMessage(), e);
                sendResult(false, "Failed to launch Remote Control: " + e.getMessage());
            }
        });
    }

    /**
     * Build the {@code claude remote-control} command line. Uses the custom
     * claude CLI path from Basic settings when configured, mirroring how the
     * daemon resolves the CLI.
     */
    private String buildCommand(boolean continueSession) {
        String claudePath = PropertiesComponent.getInstance()
                .getValue(ClaudeCliPathHandler.CLAUDE_CLI_PATH_PROPERTY_KEY);
        String executable = (claudePath != null && !claudePath.trim().isEmpty())
                ? claudePath.trim()
                : "claude";

        StringBuilder command = new StringBuilder();
        command.append(quoteForShell(executable));
        command.append(" remote-control");

        Project project = context.getProject();
        String sessionName = project != null ? project.getName() : null;
        if (sessionName != null && !sessionName.isBlank()) {
            command.append(" --name ").append(quoteForShell(sessionName));
        }

        if (continueSession) {
            command.append(" -c");
        }
        return command.toString();
    }

    /**
     * Minimal cross-shell quoting: wrap in double quotes when the value
     * contains whitespace, dropping embedded double quotes (project names and
     * CLI paths never legitimately contain them).
     */
    private static String quoteForShell(String value) {
        String sanitized = value.replace("\"", "");
        if (sanitized.chars().anyMatch(Character::isWhitespace)) {
            return "\"" + sanitized + "\"";
        }
        return sanitized;
    }

    /**
     * Open a new IDE terminal tab in the given directory and run the command.
     * Tries the modern {@code TerminalToolWindowManager} API first, then the
     * legacy {@code TerminalView} API, each via reflection.
     */
    private void openInTerminal(Project project, String workingDirectory, String command) throws Exception {
        if (project == null || project.isDisposed()) {
            throw new IllegalStateException("Project is not available");
        }

        Exception lastFailure = null;
        for (String managerClassName : new String[]{
                "org.jetbrains.plugins.terminal.TerminalToolWindowManager",
                "org.jetbrains.plugins.terminal.TerminalView"
        }) {
            Class<?> managerClass;
            try {
                managerClass = Class.forName(managerClassName);
            } catch (ClassNotFoundException e) {
                lastFailure = e;
                continue;
            }

            Object manager = managerClass.getMethod("getInstance", Project.class).invoke(null, project);
            if (manager == null) {
                continue;
            }

            // 2024.1+: createShellWidget(workingDirectory, tabName, requestFocus, deferSessionStartUntilUiShown)
            try {
                Method createShellWidget = managerClass.getMethod(
                        "createShellWidget", String.class, String.class, boolean.class, boolean.class);
                Object widget = createShellWidget.invoke(manager, workingDirectory, TERMINAL_TAB_NAME, true, false);
                widget.getClass().getMethod("sendCommandToExecute", String.class).invoke(widget, command);
                return;
            } catch (NoSuchMethodException e) {
                lastFailure = e;
            }

            // Older IDEs: createLocalShellWidget(workingDirectory, tabName) -> ShellTerminalWidget
            try {
                Method createLocalShellWidget = managerClass.getMethod(
                        "createLocalShellWidget", String.class, String.class);
                Object widget = createLocalShellWidget.invoke(manager, workingDirectory, TERMINAL_TAB_NAME);
                widget.getClass().getMethod("executeCommand", String.class).invoke(widget, command);
                return;
            } catch (NoSuchMethodException e) {
                lastFailure = e;
            }
        }

        if (lastFailure instanceof ClassNotFoundException) {
            throw lastFailure;
        }
        throw new IllegalStateException("No compatible terminal API found", lastFailure);
    }

    private void sendResult(boolean success, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", success);
        if (error != null) {
            payload.addProperty("error", error);
        }
        callJavaScript("window.onRemoteControlLaunched", escapeJs(gson.toJson(payload)));
    }
}
