import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface RichMarkdownSearchMatch {
  from: number;
  to: number;
}

export interface RichMarkdownSearchQuery {
  query: string;
  caseSensitive: boolean;
  /** Index of the current match, -1 for none. */
  active: number;
}

interface SearchState extends RichMarkdownSearchQuery {
  matches: RichMarkdownSearchMatch[];
  decorations: DecorationSet;
}

export const richMarkdownSearchKey = new PluginKey<SearchState>('richMarkdownSearch');

/** Every occurrence of `query` within a single run of text (matches never
 *  span block boundaries or non-text inline nodes such as math). */
export function findRichMarkdownMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive = false
): RichMarkdownSearchMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: RichMarkdownSearchMatch[] = [];
  let run = '';
  let runStart = -1;
  const flush = () => {
    if (run) {
      const haystack = caseSensitive ? run : run.toLowerCase();
      for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
        matches.push({ from: runStart + index, to: runStart + index + needle.length });
      }
    }
    run = '';
    runStart = -1;
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      if (runStart === -1 || runStart + run.length !== pos) {
        flush();
        runStart = pos;
      }
      run += node.text ?? '';
      return false;
    }
    flush();
    return true;
  });
  flush();
  return matches;
}

function decorate(doc: ProseMirrorNode, matches: RichMarkdownSearchMatch[], active: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === active ? 'rich-markdown-search-match is-active' : 'rich-markdown-search-match',
      })
    )
  );
}

function build(doc: ProseMirrorNode, query: RichMarkdownSearchQuery): SearchState {
  const matches = findRichMarkdownMatches(doc, query.query, query.caseSensitive);
  const active = matches.length ? Math.min(Math.max(query.active, 0), matches.length - 1) : -1;
  return { ...query, active, matches, decorations: decorate(doc, matches, active) };
}

export function richMarkdownSearchState(state: EditorState): SearchState | undefined {
  return richMarkdownSearchKey.getState(state);
}

/** In-document search highlighting; the query arrives as transaction meta. */
export const RichMarkdownSearch = Extension.create({
  name: 'richMarkdownSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: richMarkdownSearchKey,
        state: {
          init: () => ({ query: '', caseSensitive: false, active: -1, matches: [], decorations: DecorationSet.empty }),
          apply(tr, previous) {
            const next = tr.getMeta(richMarkdownSearchKey) as RichMarkdownSearchQuery | undefined;
            if (next) return build(tr.doc, next);
            if (tr.docChanged && previous.query) return build(tr.doc, previous);
            return previous;
          },
        },
        props: {
          decorations: (state) => richMarkdownSearchKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
