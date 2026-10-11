import { Marked, type Token, type Tokens } from 'marked';
import { t } from '../i18n';
import { splitFrontMatter } from './rich-markdown-frontmatter';

/** Above this the full-document tree and per-edit serialization make the
 *  rich editor sluggish; such files stay in Source/Preview. */
export const RICH_MARKDOWN_MAX_BYTES = 256 * 1024;

export type RichMarkdownSupport = { ok: true } | { ok: false; reason: string };

const lexer = new Marked({ gfm: true });

// Entities the editor writes back unchanged; any other reference would be
// decoded to its character and re-escaped on the next save.
const ROUND_TRIPPING_ENTITY = /^&(?:amp|lt|gt|quot);$/i;
const FOOTNOTE = /\[\^[^\]\s]+\]/;
const ENTITY = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
// The wrapper of a GitHub-style collapsible block, which the editor models.
const DETAILS_WRAPPER = /<details(?:\s+open)?\s*>|<summary>[^\n]*?<\/summary>|<\/details>/gi;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function children(token: Token): Token[] {
  const nested: Token[] = [];
  const record = token as Token & {
    tokens?: Token[];
    items?: Tokens.ListItem[];
    header?: Tokens.TableCell[];
    rows?: Tokens.TableCell[][];
  };
  if (record.tokens) nested.push(...record.tokens);
  if (record.items) nested.push(...record.items);
  if (record.header) for (const cell of record.header) nested.push(...cell.tokens);
  if (record.rows) for (const row of record.rows) for (const cell of row) nested.push(...cell.tokens);
  return nested;
}

function unsupportedToken(token: Token): string | null {
  switch (token.type) {
    case 'code':
    case 'codespan':
      return null;
    case 'def':
      return (token as Tokens.Def).raw.trimStart().startsWith('[^')
        ? t('Footnotes are not supported by the rich editor.')
        : t('Reference-style link definitions are not supported by the rich editor.');
    case 'html':
      if (!(token as Tokens.HTML).block || token.raw.replace(DETAILS_WRAPPER, '').trim()) {
        return t('Raw HTML is not supported by the rich editor.');
      }
      return null;
    case 'text':
    case 'escape':
      // `[^label]` is a GFM footnote reference (or definition) to the
      // preview, but plain text to the editor.
      if (FOOTNOTE.test(token.raw)) return t('Footnotes are not supported by the rich editor.');
      for (const entity of token.raw.match(ENTITY) ?? []) {
        if (!ROUND_TRIPPING_ENTITY.test(entity)) return t('HTML entities are not supported by the rich editor.');
      }
      return null;
    default:
      return null;
  }
}

/** Whether a Markdown file can be edited in the rich editor without losing or
 *  rewriting syntax it cannot model. Pure; front matter is always fine. The
 *  editor additionally proves the round trip when it loads the document. */
export function richMarkdownSupport(text: string): RichMarkdownSupport {
  if (utf8Length(text) > RICH_MARKDOWN_MAX_BYTES) {
    return { ok: false, reason: t('This file is too large for the rich editor.') };
  }
  const { body } = splitFrontMatter(text);
  let tokens: ReturnType<Marked['lexer']>;
  try {
    tokens = lexer.lexer(body.replace(/\r\n?/g, '\n'));
  } catch {
    return { ok: false, reason: t('This file could not be parsed as Markdown.') };
  }
  const pending: Token[] = [...tokens].reverse();
  while (pending.length) {
    const token = pending.pop()!;
    const reason = unsupportedToken(token);
    if (reason) return { ok: false, reason };
    if (token.type !== 'code' && token.type !== 'codespan') pending.push(...children(token).reverse());
  }
  const definitions = Object.keys(tokens.links ?? {});
  if (definitions.some((label) => label.startsWith('^'))) {
    return { ok: false, reason: t('Footnotes are not supported by the rich editor.') };
  }
  if (definitions.length) {
    return { ok: false, reason: t('Reference-style link definitions are not supported by the rich editor.') };
  }
  return { ok: true };
}
