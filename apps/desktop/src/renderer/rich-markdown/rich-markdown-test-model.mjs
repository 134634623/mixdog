// Test double for the slice of a Monaco ITextModel the rich editor uses:
// 1-based line/column positions (CRLF counted as one line break), single-range
// edits recorded for inspection, and content-change listeners.
export function createTestModel(initial) {
  let value = initial;
  let disposed = false;
  const listeners = new Set();
  const edits = [];
  const stackElements = { count: 0 };
  const lineStarts = () => {
    const starts = [0];
    for (let index = 0; index < value.length; index++) if (value[index] === '\n') starts.push(index + 1);
    return starts;
  };
  const offsetAt = (lineNumber, column) => lineStarts()[lineNumber - 1] + column - 1;
  const emit = () => {
    for (const listener of [...listeners]) listener({});
  };
  return {
    edits,
    stackElements,
    getValue: () => value,
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    },
    getPositionAt(offset) {
      const starts = lineStarts();
      let line = starts.length - 1;
      while (starts[line] > offset) line--;
      return { lineNumber: line + 1, column: offset - starts[line] + 1 };
    },
    pushStackElement() {
      stackElements.count++;
    },
    pushEditOperations(_selections, operations) {
      for (const { range, text } of operations) {
        const start = offsetAt(range.startLineNumber, range.startColumn);
        const end = offsetAt(range.endLineNumber, range.endColumn);
        edits.push({ start, end, text });
        value = value.slice(0, start) + text + value.slice(end);
      }
      emit();
      return null;
    },
    onDidChangeContent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    /** An edit made elsewhere (Source mode, reload, revert). */
    setValue(next) {
      value = next;
      emit();
    },
  };
}
