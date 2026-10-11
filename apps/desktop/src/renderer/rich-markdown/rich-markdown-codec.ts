import { getSchema, type AnyExtension, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked, type Token, type Tokens } from 'marked';
import { t } from '../i18n';
import { createRichMarkdownExtensions, INLINE_MATH_SOURCE } from './rich-markdown-extensions';

/** Plain CommonMark+GFM renderer used only as an independent judge: two
 *  Markdown texts that render the same HTML here mean the same document. */
const reference = new Marked({ gfm: true, async: false });

function referenceHtml(markdown: string): string {
  return reference.parse(markdown, { async: false }) as string;
}

/** Whitespace-sensitive spans of the rendered HTML: code blocks, `$$` math,
 *  inline code and inline `$` math (matched by the editor's own rule). Their
 *  content is compared exactly (block math edges excepted: the editor writes
 *  `$$x$$` as `$$\nx\n$$`). */
const EXACT_SPAN = new RegExp(
  String.raw`<pre\b[\s\S]*?<\/pre>|\$\$[\s\S]*?\$\$|<code>[\s\S]*?<\/code>|` + INLINE_MATH_SOURCE,
  'g'
);
const EXACT_PLACEHOLDER = /<pre>\u0000(\d+)\u0000<\/pre>|\u0000(\d+)\u0000/g;

/** Rendered HTML with presentation-only differences removed: whitespace
 *  between and inside block tags, and a list item's paragraph wrapper (a
 *  tight list and a loose list hold the same content). Code and math keep
 *  their whitespace. */
export function semanticMarkdown(markdown: string): string {
  const exact: string[] = [];
  return referenceHtml(markdown.replace(/\r\n?/g, '\n'))
    .replace(EXACT_SPAN, (span) => {
      exact.push(span.startsWith('$$') ? `$$${span.slice(2, -2).trim()}$$` : span);
      const id = `\u0000${exact.length - 1}\u0000`;
      return span.startsWith('<pre') ? `<pre>${id}</pre>` : id;
    })
    .replace(/<li>\s*<p>/g, '<li>')
    .replace(/<\/p>\s*<\/li>/g, '</li>')
    .replace(/<\/p>\s*<(ul|ol)>/g, '<$1>')
    .replace(/\s+/g, ' ')
    .replace(/\s*(<\/?(?:p|li|ul|ol|blockquote|table|thead|tbody|tr|th|td|h[1-6]|pre|hr|details|summary)\b[^>]*>)\s*/g, '$1')
    .trim()
    .replace(EXACT_PLACEHOLDER, (_match, pre?: string, math?: string) => exact[Number(pre ?? math)]);
}

export interface RichMarkdownCodec {
  schema: Schema;
  /** Markdown body → validated editor document JSON. Throws on content the
   *  schema rejects. */
  parse(markdown: string): JSONContent;
  /** Editor document JSON → canonical Markdown (LF line endings). */
  serialize(doc: JSONContent): string;
}

/** A codec over an existing schema and Markdown manager (the live editor's own). */
export function richMarkdownCodecFor(schema: Schema, manager: MarkdownManager): RichMarkdownCodec {
  return {
    schema,
    parse(markdown) {
      const json = manager.parse(markdown.replace(/\r\n?/g, '\n'));
      const node = schema.nodeFromJSON(json.content?.length ? json : { type: 'doc', content: [{ type: 'paragraph' }] });
      node.check();
      return node.toJSON();
    },
    serialize: (doc) => manager.serialize(doc),
  };
}

/** A headless codec over the editor's exact extension set. */
export function createRichMarkdownCodec(extensions: AnyExtension[] = createRichMarkdownExtensions()): RichMarkdownCodec {
  const manager = new MarkdownManager({ marked: new Marked() as never, markedOptions: { gfm: true }, extensions });
  return richMarkdownCodecFor(getSchema(extensions), manager);
}

export type RichMarkdownRoundTrip =
  | { ok: true; doc: JSONContent; canonical: string }
  | { ok: false; reason: string };

/** Proves a body survives the editor: parsing it and writing it back must
 *  mean the same document, and the written form must be stable. */
export function checkRichMarkdownRoundTrip(codec: RichMarkdownCodec, body: string): RichMarkdownRoundTrip {
  let doc: JSONContent;
  let canonical: string;
  try {
    doc = codec.parse(body);
    canonical = codec.serialize(doc);
  } catch {
    return { ok: false, reason: t('This document has structure the rich editor cannot represent.') };
  }
  if (semanticMarkdown(body) !== semanticMarkdown(canonical)) {
    return { ok: false, reason: t('Some Markdown in this file would change if edited in the rich editor.') };
  }
  let again: string;
  try {
    again = codec.serialize(codec.parse(canonical));
  } catch {
    again = '';
  }
  if (semanticMarkdown(again) !== semanticMarkdown(canonical)) {
    return { ok: false, reason: t('Some Markdown in this file would change if edited in the rich editor.') };
  }
  return { ok: true, doc, canonical };
}

const toLf = (text: string) => text.replace(/\r\n/g, '\n');

function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/** A run of source text (a block, a list item, a table row) and what it means. */
interface SourceUnit {
  start: number;
  end: number;
  key: string;
  token?: Token;
}

/** Top-level blocks with their source offsets, or null when the lexer did not
 *  account for every character (offsets would then be unreliable). */
function sourceBlocks(text: string): SourceUnit[] | null {
  let tokens: Token[];
  try {
    tokens = reference.lexer(text);
  } catch {
    return null;
  }
  const blocks: SourceUnit[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (text.slice(offset, offset + token.raw.length) !== token.raw) return null;
    const end = offset + token.raw.length;
    if (token.type !== 'space') blocks.push({ start: offset, end, key: semanticMarkdown(token.raw), token });
    offset = end;
  }
  return offset === text.length ? blocks : null;
}

/** Consecutive units over `text` from their raw lengths, or null when they do
 *  not tile it exactly. */
function tiledUnits(text: string, parts: { raw: string; key: string }[]): SourceUnit[] | null {
  const units: SourceUnit[] = [];
  let offset = 0;
  for (const part of parts) {
    if (text.slice(offset, offset + part.raw.length) !== part.raw) return null;
    units.push({ start: offset, end: offset + part.raw.length, key: part.key });
    offset += part.raw.length;
  }
  return offset === text.length ? units : null;
}

type Refine = (source: string, unit: SourceUnit, target: string, edited: SourceUnit) => string | null;

/**
 * `source` with the units that differ from `target` (after the common prefix
 * and suffix) replaced by `target`'s text for them. When exactly one unit
 * changed on each side, `refine` may rewrite it in place, keeping its own
 * unchanged parts. `separator` joins units appended after the last one.
 */
function spliceUnits(
  source: string,
  before: SourceUnit[],
  target: string,
  after: SourceUnit[],
  separator: string,
  refine?: Refine
): string {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix].key === after[prefix].key) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix].key === after[after.length - 1 - suffix].key
  ) {
    suffix++;
  }
  if (refine && before.length - prefix - suffix === 1 && after.length - prefix - suffix === 1) {
    const unit = before[prefix];
    const refined = refine(source, unit, target, after[prefix]);
    if (refined !== null) return source.slice(0, unit.start) + refined + source.slice(unit.end);
  }
  const sourceAt = (index: number) => (index < before.length ? before[index].start : source.length);
  const targetAt = (index: number) => (index < after.length ? after[index].start : target.length);
  const middle = target.slice(targetAt(prefix), targetAt(after.length - suffix));
  // Units appended after the original's last one need their own separator,
  // or the first of them would continue the preceding one.
  const head =
    prefix === before.length && middle ? source.replace(/\n*$/, '') + separator : source.slice(0, sourceAt(prefix));
  return head + middle + source.slice(sourceAt(before.length - suffix));
}

/** Blocks of `source` the edit left alone keep their bytes; compound blocks
 *  that changed keep their unchanged children. Null when unlexable. */
function spliceMarkdown(source: string, target: string): string | null {
  const before = sourceBlocks(source);
  const after = sourceBlocks(target);
  return before && after ? spliceUnits(source, before, target, after, '\n\n', refineBlock) : null;
}

/** A changed compound block rewritten child by child, keeping its trailing
 *  newlines; null when the two blocks are not the same kind of compound. */
function refineBlock(source: string, unit: SourceUnit, target: string, edited: SourceUnit): string | null {
  const a = unit.token;
  const b = edited.token;
  if (!a || !b || a.type !== b.type) return null;
  const sourceRaw = source.slice(unit.start, unit.end);
  const trailing = /\n*$/.exec(sourceRaw)?.[0] ?? '';
  const sourceCore = sourceRaw.slice(0, sourceRaw.length - trailing.length);
  const targetCore = target.slice(edited.start, edited.end).replace(/\n*$/, '');
  let core: string | null = null;
  if (a.type === 'list' && (a as Tokens.List).ordered === (b as Tokens.List).ordered) {
    core = refineList(sourceCore, a as Tokens.List, targetCore, b as Tokens.List);
  } else if (a.type === 'blockquote') {
    core = refineQuote(sourceCore, targetCore);
  } else if (a.type === 'table') {
    core = refineTable(sourceCore, a as Tokens.Table, targetCore, b as Tokens.Table);
  }
  return core === null ? null : core.replace(/\n+$/, '') + trailing;
}

const BULLET = /^( {0,3})([-*+])(?=[ \t]|$)/;
const ORDINAL = /^( {0,3}\d{1,9})([.)])(?=[ \t]|$)/;

/** A list item's meaning regardless of its marker (an ordinal alone would
 *  render as a list starting there). */
const itemKey = (raw: string) => semanticMarkdown(raw.replace(/^( {0,3})(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/, '$1-'));

/** List items: unchanged ones keep their bytes; changed ones take the
 *  edit's text with the source list's marker (another bullet character or
 *  delimiter would start a new list). */
function refineList(source: string, a: Tokens.List, target: string, b: Tokens.List): string | null {
  const first = a.items[0]?.raw ?? '';
  const marker = (a.ordered ? ORDINAL : BULLET).exec(first)?.[2];
  if (!marker) return null;
  const adapt = (raw: string) => raw.replace(a.ordered ? ORDINAL : BULLET, `$1${marker}`);
  const items = tiledUnits(source, a.items.map((item) => ({ raw: item.raw, key: itemKey(item.raw) })));
  const editedRaws = b.items.map((item) => adapt(item.raw));
  const adapted = editedRaws.join('');
  if (target !== b.items.map((item) => item.raw).join('')) return null;
  const editedItems = tiledUnits(adapted, editedRaws.map((raw) => ({ raw, key: itemKey(raw) })));
  return items && editedItems ? spliceUnits(source, items, adapted, editedItems, '\n', refineItem) : null;
}

const ITEM_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: {1,4}(?=\S)| ?(?=\n|$))/;

/** A list item's marker and its content with the continuation indent
 *  removed, or null when a line is not indented under the marker. */
function unindentItem(text: string): { marker: string; inner: string } | null {
  const marker = ITEM_MARKER.exec(text)?.[0];
  if (marker === undefined) return null;
  const indent = ' '.repeat(marker.length);
  const [first, ...rest] = text.slice(marker.length).split('\n');
  const lines = [first];
  for (const line of rest) {
    if (!line) lines.push('');
    else if (line.startsWith(indent)) lines.push(line.slice(indent.length));
    else return null;
  }
  return { marker, inner: lines.join('\n') };
}

/** A changed item reconciled on its content (nested lists recursively),
 *  then indented under the source item's own marker. */
function refineItem(source: string, unit: SourceUnit, target: string, edited: SourceUnit): string | null {
  const sourceRaw = source.slice(unit.start, unit.end);
  const trailing = /\n*$/.exec(sourceRaw)?.[0] ?? '';
  const a = unindentItem(sourceRaw.slice(0, sourceRaw.length - trailing.length));
  const b = unindentItem(target.slice(edited.start, edited.end).replace(/\n*$/, ''));
  const inner = a && b ? spliceMarkdown(a.inner, b.inner) : null;
  if (!a || inner === null) return null;
  // A marker followed by nothing keeps no trailing space before content.
  const marker = inner.startsWith('\n') || !inner ? a.marker.trimEnd() : a.marker;
  const indent = ' '.repeat(a.marker.length);
  const [first, ...rest] = inner.replace(/\n+$/, '').split('\n');
  return [marker + first, ...rest.map((line) => (line ? indent + line : ''))].join('\n') + trailing;
}

/** The `>` prefix every line of a quote shares and its unquoted text, or
 *  null when lines are prefixed differently or continue lazily. */
function unquote(text: string): { prefix: string; blank: string; inner: string } | null {
  let prefix: string | null = null;
  let blank: string | null = null;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^( {0,3}>)( ?)(.*)$/.exec(line);
    if (!match) return null;
    if (!match[3]) {
      if (blank !== null && blank !== line) return null;
      blank = line;
      lines.push('');
      continue;
    }
    if (prefix !== null && prefix !== match[1] + match[2]) return null;
    prefix = match[1] + match[2];
    lines.push(match[3]);
  }
  return { prefix: prefix ?? '> ', blank: blank ?? '>', inner: lines.join('\n') };
}

/** A quote reconciled on its unquoted content, then quoted in the source's
 *  own style. */
function refineQuote(source: string, target: string): string | null {
  const a = unquote(source);
  const b = unquote(target);
  const inner = a && b ? spliceMarkdown(a.inner, b.inner) : null;
  if (!a || inner === null) return null;
  return inner
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line ? a.prefix + line : a.blank))
    .join('\n');
}

/** Table rows: unchanged rows (and an unchanged alignment row) keep their bytes. */
function refineTable(source: string, a: Tokens.Table, target: string, b: Tokens.Table): string | null {
  const rows = (text: string, table: Tokens.Table) => {
    const lines = text.split('\n');
    if (lines.length !== table.rows.length + 2) return null;
    const keys = ([table.header, table.align, ...table.rows] as unknown[][]).map((row) =>
      JSON.stringify(row.map((cell) => (cell && typeof cell === 'object' ? semanticMarkdown((cell as Tokens.TableCell).text) : cell)))
    );
    return tiledUnits(
      text,
      lines.map((line, index) => ({ raw: index < lines.length - 1 ? `${line}\n` : line, key: keys[index] }))
    );
  };
  const before = rows(source, a);
  const after = rows(target, b);
  return before && after ? spliceUnits(source, before, target, after, '\n') : null;
}

/**
 * Carries an edit into the original source: blocks the edit did not change
 * keep their exact original bytes (list markers, emphasis style, blank
 * lines), and so do the unchanged items, rows and quoted blocks inside a
 * changed list, table or quote; only the changed parts take the editor's
 * canonical form. The result is verified to mean exactly `edited`; otherwise
 * `edited` is used. Line endings and the trailing newline follow the original.
 */
export function reconcileMarkdown(original: string, edited: string): string {
  const eol = dominantEol(original);
  const source = toLf(original);
  const target = toLf(edited);
  const trailing = /\n*$/.exec(source)?.[0] ?? '';
  const withTrailing = (text: string) => text.replace(/\n*$/, '') + trailing;
  const meaning = semanticMarkdown(target);
  let result = withTrailing(target);
  const before = sourceBlocks(source);
  const after = sourceBlocks(target);
  if (before && after) {
    // Block-level splicing alone is the fallback when the finer one fails.
    for (const refine of [refineBlock, undefined]) {
      const spliced = withTrailing(spliceUnits(source, before, target, after, '\n\n', refine));
      if (semanticMarkdown(spliced) === meaning) {
        result = spliced;
        break;
      }
    }
  }
  return eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
}

/** The smallest single replacement turning `before` into `after`, never
 *  splitting a surrogate pair or a CRLF; null when they are equal. */
export function minimalTextEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  const unsafeBoundary = (text: string, index: number) => {
    const code = text.charCodeAt(index);
    return (code >= 0xdc00 && code <= 0xdfff) || (text[index] === '\n' && text[index - 1] === '\r');
  };
  while (start > 0 && (unsafeBoundary(before, start) || unsafeBoundary(after, start))) start--;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  while (
    tail > 0 &&
    (unsafeBoundary(before, before.length - tail) || unsafeBoundary(after, after.length - tail))
  ) {
    tail--;
  }
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
