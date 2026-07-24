/**
 * Live-dictation partial text in the contentEditable composer.
 *
 * While the user is speaking, the local Whisper server produces a new full
 * transcript roughly once a second. That text is shown *in place* inside a
 * marked `<span data-voice-partial="1">` so it can be replaced wholesale on
 * each update and finalized (unwrapped to plain text) when recording stops.
 *
 * Keeping it in a marked element instead of tracking offsets means the user can
 * keep typing elsewhere in the box without the update stomping their edits: the
 * partial only ever rewrites its own span.
 */

export const VOICE_PARTIAL_ATTR = 'data-voice-partial';
const VOICE_PARTIAL_CLASS = 'voice-partial-text';

/** Find the active partial span inside the editable, if any. */
export function findPartialSpan(editable: HTMLElement | null): HTMLElement | null {
  if (!editable) {
    return null;
  }
  return editable.querySelector<HTMLElement>(`[${VOICE_PARTIAL_ATTR}]`);
}

/**
 * Create the partial span at the caret (or at the end when the caret is
 * elsewhere), returning the span. Existing partial spans are reused so repeated
 * updates never stack.
 */
function ensurePartialSpan(editable: HTMLElement): HTMLElement {
  const existing = findPartialSpan(editable);
  if (existing) {
    return existing;
  }

  const span = document.createElement('span');
  span.setAttribute(VOICE_PARTIAL_ATTR, '1');
  span.className = VOICE_PARTIAL_CLASS;
  // Not editable: partial text is transient and machine-owned. Letting the user
  // type inside it would lose their edit on the next update.
  span.setAttribute('contenteditable', 'false');

  const selection = window.getSelection();
  if (
    selection
    && selection.rangeCount > 0
    && editable.contains(selection.anchorNode)
  ) {
    const range = selection.getRangeAt(0);
    range.collapse(false);
    range.insertNode(span);
  } else {
    editable.appendChild(span);
  }
  return span;
}

/**
 * Show/replace the current partial transcript.
 *
 * @returns true when the DOM changed (caller should sync height/state)
 */
export function updatePartialText(editable: HTMLElement | null, text: string): boolean {
  if (!editable) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const span = ensurePartialSpan(editable);
  if (span.textContent === trimmed) {
    return false;
  }
  span.textContent = trimmed;
  return true;
}

/**
 * Replace the partial span with committed plain text (adding a trailing space),
 * leaving the caret after it. Falls back to inserting at the end when no
 * partial span exists — e.g. live dictation was disabled, or the user deleted it.
 *
 * @param text final transcript; when empty the partial span is just removed
 * @returns true when the DOM changed
 */
export function commitPartialText(editable: HTMLElement | null, text: string): boolean {
  if (!editable) {
    return false;
  }
  const span = findPartialSpan(editable);
  const trimmed = text.trim();

  if (!span) {
    return false;
  }

  if (!trimmed) {
    span.remove();
    return true;
  }

  const textNode = document.createTextNode(`${trimmed} `);
  span.replaceWith(textNode);

  // Put the caret after the committed text so the user can keep typing.
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

/** Remove any partial text without committing it (cancel path). */
export function discardPartialText(editable: HTMLElement | null): boolean {
  const span = findPartialSpan(editable);
  if (!span) {
    return false;
  }
  span.remove();
  return true;
}
