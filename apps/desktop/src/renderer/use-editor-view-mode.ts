// Preview | Rich | Source for files that open as text but also have a rendered
// view (SVG, Markdown, CSV/TSV; Rich is Markdown only). The hidden editor and
// its unsaved edits stay mounted; the snapshot is the text the rendered view
// shows.
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { t } from './i18n';
import type { DesktopEditorSettings } from '../shared/contract';
import type { EditorViewMode, editorViewKindForPath } from './editor-delimited';
import { initialViewMode, rememberViewMode } from './editor-view-mode-store';
import { richMarkdownSupport } from './rich-markdown/rich-markdown-support';

export function useEditorViewMode({
  viewKind,
  modelRef,
  loadedContent,
  contentRevision,
  modeKey,
  markdownDefaultView,
  readOnly,
}: {
  viewKind: ReturnType<typeof editorViewKindForPath>;
  modelRef: RefObject<import('monaco-editor').editor.ITextModel | null>;
  loadedContent: string | undefined;
  contentRevision: number;
  /** Normalized absolute path: the key of the remembered mode. */
  modeKey: string;
  markdownDefaultView: DesktopEditorSettings['markdownDefaultView'];
  readOnly: boolean;
}) {
  // The user's choice for this file; until then the remembered mode or the
  // default-view setting (which loads after the first render) applies.
  const [choice, setChoice] = useState<{ key: string; mode: EditorViewMode } | null>(null);
  const requestedMode = useMemo(
    () => initialViewMode(viewKind, modeKey, markdownDefaultView),
    [viewKind, modeKey, markdownDefaultView]
  );
  const requested = choice && choice.key === modeKey ? choice.mode : requestedMode;
  const [viewSnapshot, setViewSnapshot] = useState<string | null>(null);
  const [reported, setReported] = useState<{ key: string; reason: string } | null>(null);
  // Rich only mounts for text the Rich editor can round-trip; anything else
  // shows Preview with the reason. Evaluated when Rich is requested (and after
  // a reload), against the model's current text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision signals a model text replacement; the text itself is read through modelRef.
  const richBlock = useMemo(() => {
    if (requested !== 'rich') return '';
    if (readOnly) return t('Read-only files open in Preview.');
    if (reported?.key === modeKey) return reported.reason;
    const support = richMarkdownSupport(modelRef.current?.getValue() ?? loadedContent ?? '');
    return support.ok ? '' : support.reason;
  }, [requested, readOnly, reported, modeKey, contentRevision, modelRef, loadedContent]);
  const viewMode: EditorViewMode = requested === 'rich' && richBlock ? 'rendered' : requested;
  const richNotice = requested === 'rich' ? richBlock : '';
  // A reload or revert replaces the model text: a snapshot taken earlier must
  // follow it or the rendered view keeps showing the old file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision is the deliberate trigger; the model text it signals is read through modelRef.
  useEffect(() => {
    if (viewMode === 'source') return;
    setViewSnapshot((current) => (current === null ? current : (modelRef.current?.getValue() ?? current)));
  }, [contentRevision, modelRef, viewMode]);
  // Another surface showing the same file shares this model: keep the rendered
  // snapshot on the latest text so a grid never commits over stale content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentRevision re-subscribes after a model swap, which modelRef.current cannot signal.
  useEffect(() => {
    const model = modelRef.current;
    if (viewMode !== 'rendered' || !model) return undefined;
    const listener = model.onDidChangeContent(() => setViewSnapshot(model.getValue()));
    return () => listener.dispose();
  }, [viewMode, contentRevision, modelRef]);
  const changeViewMode = (next: EditorViewMode) => {
    if (next === requested) return;
    if (next !== 'source') setViewSnapshot(modelRef.current?.getValue() ?? loadedContent ?? '');
    setReported(null);
    setChoice({ key: modeKey, mode: next });
    if (viewKind === 'markdown') rememberViewMode(modeKey, next);
  };
  /** The Rich editor refused the document after mounting (onUnsupported). */
  const reportRichUnsupported = (reason: string) => setReported({ key: modeKey, reason });
  return { viewMode, richNotice, viewSnapshot, setViewSnapshot, changeViewMode, reportRichUnsupported };
}
