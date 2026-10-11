// "Open Preview to the Side": a read-only rendered view of a Markdown file in
// the side dock. It mounts NO editor and no file session: the main tab's
// editor and this view address the same Monaco model by path URI, so the
// preview follows unsaved edits live. With no open model (the tab was closed)
// it shows the file as saved on disk.
import { useEffect, useRef, useState } from 'react';
import { EditorMarkdownPreview } from './EditorTextViews';
import { EditorOutline, useMarkdownOutline } from './editor-markdown-outline';
import { monaco } from './monaco-setup';
import type { SideFileChrome } from './side-surface-strip';

export default function EditorSideMarkdownPreview({
  projectPath,
  relPath,
  accessToken,
  onSideChrome,
  onOpenFile,
}: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  onSideChrome(chrome: SideFileChrome | null): void;
  onOpenFile?(project: string, rel: string, line?: number): void;
}) {
  const abs = `${projectPath.replace(/[\\/]+$/, '')}/${relPath}`;
  const [text, setText] = useState('');
  const [tocOpen, setTocOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const { headings, activeId } = useMarkdownOutline(surfaceRef, tocOpen, true);

  useEffect(() => {
    const uri = monaco.Uri.parse(abs);
    let content: { dispose(): void } | null = null;
    let live = true;
    const follow = (model: import('monaco-editor').editor.ITextModel) => {
      content?.dispose();
      setText(model.getValue());
      content = model.onDidChangeContent(() => setText(model.getValue()));
    };
    const existing = monaco.editor.getModel(uri);
    if (existing) follow(existing);
    else {
      void window.mixdogDesktop
        ?.readProjectFile?.(projectPath, relPath, accessToken)
        .then((file) => {
          if (live && !monaco.editor.getModel(uri)) setText(file.content);
        })
        .catch(() => {});
    }
    // The main tab's model may be created after this view, and is disposed
    // when that tab closes; the last text stays on screen.
    const created = monaco.editor.onDidCreateModel((model) => {
      if (model.uri.toString() === uri.toString()) follow(model);
    });
    return () => {
      live = false;
      content?.dispose();
      created.dispose();
    };
  }, [abs, projectPath, relPath, accessToken]);

  useEffect(() => {
    onSideChrome({
      editable: false,
      dirty: false,
      saving: false,
      save() {},
      toc: { open: tocOpen, onToggle: () => setTocOpen((open) => !open) },
      reveal: () => void window.mixdogDesktop?.revealFile?.(projectPath, relPath, accessToken),
    });
  }, [onSideChrome, tocOpen, projectPath, relPath, accessToken]);
  useEffect(() => () => onSideChrome(null), [onSideChrome]);

  return (
    <div className="editor-pane">
      <div className="editor-pane-body">
        <div className="editor-md-layout">
          <div className="editor-md-surface" ref={surfaceRef}>
            <EditorMarkdownPreview text={text} projectPath={projectPath} relPath={relPath} onOpenFile={onOpenFile} />
          </div>
          {tocOpen && <EditorOutline headings={headings} activeId={activeId} />}
        </div>
      </div>
    </div>
  );
}
