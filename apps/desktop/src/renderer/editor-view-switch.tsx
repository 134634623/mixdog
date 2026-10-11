// The file header's view controls, shared by the main tab's breadcrumb row and
// the side dock's file header: the Preview | Rich | Source segmented switch,
// the table-of-contents toggle and "Open Preview to the Side".
import { Columns2, ListTree } from 'lucide-react';
import { t } from './i18n';
import type { EditorViewMode } from './editor-delimited';

export interface EditorViewToggle {
  value: EditorViewMode;
  /** "Preview" (SVG, Markdown) or "Table" (CSV/TSV). */
  renderedLabel: string;
  modes: readonly EditorViewMode[];
  onChange(next: EditorViewMode): void;
}

export interface EditorViewControls {
  viewToggle?: EditorViewToggle;
  /** Markdown in Preview or Rich: the outline panel. */
  toc?: { open: boolean; onToggle(): void };
  /** Markdown in Source (main tab): the same file as a Preview in the dock. */
  sideBySide?: { onOpen(): void };
}

export function editorViewModeLabel(toggle: Pick<EditorViewToggle, 'renderedLabel'>, mode: EditorViewMode): string {
  if (mode === 'rendered') return toggle.renderedLabel;
  return mode === 'rich' ? t('Rich') : t('Source');
}

export function EditorViewSwitch({ toggle }: { toggle: EditorViewToggle }) {
  return (
    <span className="editor-view-switch" role="radiogroup" aria-label={t('View mode')}>
      {toggle.modes.map((mode) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control of toggle buttons; aria-checked carries the selection.
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={toggle.value === mode}
          onClick={() => toggle.onChange(mode)}
        >
          {editorViewModeLabel(toggle, mode)}
        </button>
      ))}
    </span>
  );
}

/** Icon buttons for the breadcrumb row's action cluster. */
export function EditorViewTools({ controls }: { controls: Pick<EditorViewControls, 'toc' | 'sideBySide'> }) {
  return (
    <>
      {controls.toc && (
        <button
          type="button"
          aria-pressed={controls.toc.open}
          aria-label={t('Table of contents')}
          data-tooltip={t('Table of contents')}
          onClick={controls.toc.onToggle}
        >
          <ListTree size={16} aria-hidden="true" />
        </button>
      )}
      {controls.sideBySide && (
        <button
          type="button"
          aria-label={t('Open Preview to the Side')}
          data-tooltip={t('Open Preview to the Side')}
          onClick={controls.sideBySide.onOpen}
        >
          <Columns2 size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
