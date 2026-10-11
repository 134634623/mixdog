import type { editor as MonacoEditor, IDisposable } from 'monaco-editor';
import type { JSONContent } from '@tiptap/core';
import { checkRichMarkdownRoundTrip, minimalTextEdit, reconcileMarkdown, type RichMarkdownCodec } from './rich-markdown-codec';
import { splitFrontMatter } from './rich-markdown-frontmatter';
import { richMarkdownSupport } from './rich-markdown-support';

/** The slice of a Monaco text model the rich editor reads and writes. */
export type RichMarkdownModel = Pick<
  MonacoEditor.ITextModel,
  'getValue' | 'getPositionAt' | 'pushEditOperations' | 'pushStackElement' | 'onDidChangeContent' | 'isDisposed'
>;

export interface RichMarkdownSyncHandlers {
  /** A (re)loaded body for the editor, with the front matter to show. */
  onDocument(doc: JSONContent, frontMatter: string): void;
  /** Only the front matter changed; the editor content stays. */
  onFrontMatter(frontMatter: string): void;
  onUnsupported(reason: string): void;
}

/**
 * Keeps one rich editor and its Monaco model in step. The model is the source
 * of truth: the editor is loaded from it, edits are written back as one
 * minimal replacement (so Monaco's undo, dirty state and save keep working),
 * and changes made elsewhere reload the editor. Nothing is written unless an
 * edit actually changes the Markdown.
 */
export class RichMarkdownModelSync {
  /** Front matter and body the editor currently reflects. */
  private frontMatter = '';
  private body = '';
  private writing = false;
  /** Model text last found unsupported. */
  private rejected: string | null = null;
  private subscription: IDisposable | null = null;

  constructor(
    readonly model: RichMarkdownModel,
    private readonly codec: RichMarkdownCodec,
    private readonly handlers: RichMarkdownSyncHandlers
  ) {}

  /** Loads the model into the editor and starts following its changes.
   *  False (after reporting why) when the content cannot be edited safely. */
  start(): boolean {
    this.subscription = this.model.onDidChangeContent(() => {
      if (!this.writing) this.refresh();
    });
    return this.load(this.model.getValue());
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  /** Re-reads the model; reloads the editor only when the body differs from
   *  what the editor last showed or wrote. */
  refresh(): void {
    if (this.model.isDisposed()) return;
    const text = this.model.getValue();
    if (text === this.rejected) return;
    const { frontMatter, body } = splitFrontMatter(text);
    if (body === this.body) {
      if (frontMatter !== this.frontMatter) {
        this.frontMatter = frontMatter;
        this.handlers.onFrontMatter(frontMatter);
      }
      return;
    }
    this.load(text);
  }

  private load(text: string): boolean {
    const support = richMarkdownSupport(text);
    const { frontMatter, body } = splitFrontMatter(text);
    const roundTrip = support.ok ? checkRichMarkdownRoundTrip(this.codec, body) : support;
    if (!roundTrip.ok) {
      // Reported once per content; the host decides what to show instead.
      this.rejected = text;
      this.handlers.onUnsupported(roundTrip.reason);
      return false;
    }
    this.rejected = null;
    this.frontMatter = frontMatter;
    this.body = body;
    this.handlers.onDocument(roundTrip.doc, frontMatter);
    return true;
  }

  /**
   * Writes the editor's serialized Markdown into the model. Unchanged blocks
   * keep their original bytes; only the edited run is rewritten. Returns
   * whether the model changed.
   */
  commit(markdown: string): boolean {
    if (this.model.isDisposed()) return false;
    const text = this.model.getValue();
    const { frontMatter, body } = splitFrontMatter(text);
    const next = reconcileMarkdown(body, markdown);
    this.frontMatter = frontMatter;
    this.body = next;
    const edit = minimalTextEdit(text, frontMatter + next);
    if (!edit) return false;
    const start = this.model.getPositionAt(edit.start);
    const end = this.model.getPositionAt(edit.end);
    this.writing = true;
    try {
      this.model.pushStackElement();
      this.model.pushEditOperations(
        [],
        [
          {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: edit.text,
          },
        ],
        () => null
      );
      this.model.pushStackElement();
    } finally {
      this.writing = false;
    }
    // The model may normalize line endings of the inserted text; what it now
    // holds is what the editor reflects.
    this.body = splitFrontMatter(this.model.getValue()).body;
    return true;
  }
}
