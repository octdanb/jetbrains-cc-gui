import { beforeEach, describe, expect, it } from 'vitest';
import {
  VOICE_PARTIAL_ATTR,
  commitPartialText,
  discardPartialText,
  findPartialSpan,
  updatePartialText,
} from './voicePartialText';

function makeEditable(html = ''): HTMLDivElement {
  const editable = document.createElement('div');
  editable.className = 'input-editable';
  editable.contentEditable = 'true';
  editable.innerHTML = html;
  document.body.appendChild(editable);
  return editable;
}

/** Put the caret at the end of the editable's last child. */
function placeCaretAtEnd(editable: HTMLElement) {
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('voicePartialText', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('creates a single partial span and rewrites it on update', () => {
    const editable = makeEditable();

    expect(updatePartialText(editable, 'hello')).toBe(true);
    const span = findPartialSpan(editable);
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('hello');
    // Machine-owned text must not be user-editable.
    expect(span!.getAttribute('contenteditable')).toBe('false');

    // A longer transcript replaces the same span rather than adding another.
    expect(updatePartialText(editable, 'hello world')).toBe(true);
    expect(editable.querySelectorAll(`[${VOICE_PARTIAL_ATTR}]`)).toHaveLength(1);
    expect(findPartialSpan(editable)!.textContent).toBe('hello world');
  });

  it('reports no change for identical or empty text', () => {
    const editable = makeEditable();
    updatePartialText(editable, 'same');

    expect(updatePartialText(editable, 'same')).toBe(false);
    expect(updatePartialText(editable, '  same  ')).toBe(false);
    expect(updatePartialText(editable, '   ')).toBe(false);
  });

  it('preserves text the user typed before dictation started', () => {
    const editable = makeEditable('please ');
    placeCaretAtEnd(editable);

    updatePartialText(editable, 'refactor this');
    expect(editable.textContent).toBe('please refactor this');

    commitPartialText(editable, 'refactor this file');
    expect(editable.textContent).toBe('please refactor this file ');
    expect(findPartialSpan(editable)).toBeNull();
  });

  it('commits the partial to plain text with a trailing space', () => {
    const editable = makeEditable();
    updatePartialText(editable, 'draft text');

    expect(commitPartialText(editable, 'final text')).toBe(true);
    expect(findPartialSpan(editable)).toBeNull();
    expect(editable.textContent).toBe('final text ');
    // No leftover element wrapper — committed text is a plain text node.
    expect(editable.querySelector('span')).toBeNull();
  });

  it('removes the span when committing empty text', () => {
    const editable = makeEditable('kept ');
    placeCaretAtEnd(editable);
    updatePartialText(editable, 'noise');

    expect(commitPartialText(editable, '   ')).toBe(true);
    expect(findPartialSpan(editable)).toBeNull();
    expect(editable.textContent).toBe('kept ');
  });

  it('reports false when committing with no partial present', () => {
    const editable = makeEditable('typed only');
    // Live mode off / partial already gone: caller must fall back to inserting.
    expect(commitPartialText(editable, 'whatever')).toBe(false);
    expect(editable.textContent).toBe('typed only');
  });

  it('discards the partial without committing', () => {
    const editable = makeEditable('keep ');
    placeCaretAtEnd(editable);
    updatePartialText(editable, 'throw away');

    expect(discardPartialText(editable)).toBe(true);
    expect(editable.textContent).toBe('keep ');
    expect(discardPartialText(editable)).toBe(false);
  });

  it('appends at the end when the caret is outside the editable', () => {
    const editable = makeEditable('existing');
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    window.getSelection()!.removeAllRanges();

    expect(updatePartialText(editable, 'spoken')).toBe(true);
    expect(editable.textContent).toBe('existingspoken');
  });

  it('is a no-op for a null editable', () => {
    expect(updatePartialText(null, 'x')).toBe(false);
    expect(commitPartialText(null, 'x')).toBe(false);
    expect(discardPartialText(null)).toBe(false);
    expect(findPartialSpan(null)).toBeNull();
  });
});
