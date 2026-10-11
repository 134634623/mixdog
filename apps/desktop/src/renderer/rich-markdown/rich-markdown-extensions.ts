import type { AnyExtension, JSONContent, MarkdownToken, NodeViewRenderer } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Paragraph from '@tiptap/extension-paragraph';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Markdown } from '@tiptap/markdown';
import { common, createLowlight } from 'lowlight';
import { Marked } from 'marked';
import { t } from '../i18n';

export const richMarkdownLowlight = createLowlight(common);

/** Node views the live editor plugs in; the headless codec renders none. */
export interface RichMarkdownNodeViews {
  codeBlock?: NodeViewRenderer;
  image?: NodeViewRenderer;
}

type DetailsToken = MarkdownToken & {
  open: boolean;
  summaryTokens: MarkdownToken[];
  bodyTokens: MarkdownToken[];
};

const DETAILS_BLOCK = /^<details(\s+open)?\s*>[ \t]*\n?[ \t]*<summary>([^\n]*?)<\/summary>[ \t]*\n([\s\S]*?)\n?<\/details>[ \t]*(?:\n|$)/;

/** One `<details>` block in GitHub's shape: a one-line summary and a Markdown
 *  body. Nested or attribute-laden blocks stay raw HTML (unsupported). */
export function matchDetailsBlock(src: string): { raw: string; open: boolean; summary: string; body: string } | null {
  const match = DETAILS_BLOCK.exec(src);
  if (!match || /<\/?details\b/i.test(match[3])) return null;
  return { raw: match[0], open: Boolean(match[1]), summary: match[2].trim(), body: match[3].trim() };
}

const escapeHtmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RichDetails = Details.extend({
  addAttributes() {
    // `open` as authored: it sets the initial fold and is written back
    // unchanged. Toggling (persist: false) only folds the view, so viewing a
    // section never edits the document.
    return {
      ...this.parent?.(),
      open: { default: false, rendered: false },
    };
  },
  markdownTokenizer: {
    name: 'details',
    level: 'block',
    start: (src: string) => src.indexOf('<details'),
    tokenize(src, _tokens, lexer) {
      const block = matchDetailsBlock(src);
      if (!block) return undefined;
      return {
        type: 'details',
        raw: block.raw,
        open: block.open,
        summaryTokens: lexer.inlineTokens(block.summary),
        bodyTokens: lexer.blockTokens(block.body),
      } as DetailsToken;
    },
  },
  parseMarkdown(token, helpers) {
    const details = token as DetailsToken;
    const summary = helpers.createNode('detailsSummary', {}, helpers.parseInline(details.summaryTokens ?? []));
    const body = helpers.parseChildren(details.bodyTokens ?? []);
    const content = helpers.createNode('detailsContent', {}, body.length ? body : [helpers.createNode('paragraph')]);
    return helpers.createNode('details', { open: details.open }, [summary, content]);
  },
  renderMarkdown(node, helpers) {
    const summary = node.content?.find((child) => child.type === 'detailsSummary');
    const content = node.content?.find((child) => child.type === 'detailsContent');
    const title = helpers.renderChildren(summary?.content ?? [], '');
    const body = helpers.renderChildren(content?.content ?? [], '\n\n').trim();
    const open = node.attrs?.open ? ' open' : '';
    return `<details${open}>\n<summary>${escapeHtmlText(title)}</summary>\n\n${body}\n\n</details>`;
  },
});

// Pandoc's rule: `$` must hug its content and a closing `$` must not run into
// a digit, so prices like `$5 and $10` stay text instead of becoming math.
export const INLINE_MATH_SOURCE = String.raw`\$(?![\s$])((?:\\[\s\S]|[^$\\\n])+?)(?<!\s)\$(?!\d)`;
const INLINE_MATH = new RegExp(`^${INLINE_MATH_SOURCE}`);

const RichInlineMath = InlineMath.extend({
  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenize(src: string) {
      const match = INLINE_MATH.exec(src);
      return match ? { type: 'inlineMath', raw: match[0], latex: match[1] } : undefined;
    },
  },
});

// The summary is parsed as inline Markdown, so it must accept any inline node.
const RichDetailsSummary = DetailsSummary.extend({ content: 'inline*' });

const RichParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? [];
    // Images are inline here: a lone image stays inside its paragraph rather
    // than becoming a block the document schema rejects.
    if (tokens.length === 1 && tokens[0].type === 'image') {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
    }
    const parent = Paragraph.config.parseMarkdown;
    return parent ? parent.call(this, token, helpers) : helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
  },
});

export interface RichMarkdownExtensionOptions {
  nodeViews?: RichMarkdownNodeViews;
  /** Extra editor-only extensions (placeholder, search, keymaps). */
  extra?: AnyExtension[];
  /** A click on rendered math (to edit its LaTeX). */
  onMathClick?: (kind: 'inlineMath' | 'blockMath', latex: string, pos: number) => void;
}

/** The one extension set behind both the live editor and the headless codec,
 *  so a document judged round-trippable is exactly what the editor writes. */
export function createRichMarkdownExtensions({
  nodeViews = {},
  extra = [],
  onMathClick,
}: RichMarkdownExtensionOptions = {}): AnyExtension[] {
  const codeBlock = CodeBlockLowlight.configure({ lowlight: richMarkdownLowlight, defaultLanguage: null });
  const image = Image.configure({ inline: true, allowBase64: false });
  return [
    StarterKit.configure({
      codeBlock: false,
      paragraph: false,
      // Underline has no Markdown syntax: it would be written as raw HTML.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, enableClickSelection: false },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    RichParagraph,
    nodeViews.codeBlock ? codeBlock.extend({ addNodeView: () => nodeViews.codeBlock! }) : codeBlock,
    nodeViews.image ? image.extend({ addNodeView: () => nodeViews.image! }) : image,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    RichInlineMath.configure({
      katexOptions: { throwOnError: false },
      onClick: onMathClick ? (node, pos) => onMathClick('inlineMath', String(node.attrs.latex ?? ''), pos) : undefined,
    }),
    BlockMath.configure({
      katexOptions: { throwOnError: false, displayMode: true },
      onClick: onMathClick ? (node, pos) => onMathClick('blockMath', String(node.attrs.latex ?? ''), pos) : undefined,
    }),
    RichDetails.configure({
      persist: false,
      HTMLAttributes: { class: 'rich-markdown-details' },
      renderToggleButton: ({ element, isOpen }) =>
        element.setAttribute('aria-label', isOpen ? t('Collapse section') : t('Expand section')),
    }),
    RichDetailsSummary,
    DetailsContent,
    // A private marked instance per editor: tokenizers registered by one
    // editor never leak into another or into the app's own Markdown pipeline.
    // (A Marked instance carries everything the manager uses of the module API.)
    Markdown.configure({ marked: new Marked() as never, markedOptions: { gfm: true } }),
    ...extra,
  ];
}

export type { JSONContent };
