import test from 'node:test';
import assert from 'node:assert/strict';
import { createRichMarkdownCodec } from './rich-markdown-codec.ts';
import { RichMarkdownModelSync } from './rich-markdown-model-sync.ts';
import { createTestModel } from './rich-markdown-test-model.mjs';

const codec = createRichMarkdownCodec();
const FRONT = '---\ntitle: Notes\ntags: [a, b]\n---\n';
const BODY = '# Notes\n\n* first\n* second\n\nSome __bold__ text.\n';

function start(text) {
  const model = createTestModel(text);
  const events = [];
  const sync = new RichMarkdownModelSync(model, codec, {
    onDocument: (doc, frontMatter) => events.push({ kind: 'document', doc, frontMatter }),
    onFrontMatter: (frontMatter) => events.push({ kind: 'frontMatter', frontMatter }),
    onUnsupported: (reason) => events.push({ kind: 'unsupported', reason }),
  });
  const started = sync.start();
  return { model, sync, events, started };
}

test('loading a document reports it with its front matter and never writes', () => {
  const { model, events, started } = start(FRONT + BODY);
  assert.equal(started, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'document');
  assert.equal(events[0].frontMatter, FRONT);
  assert.equal(events[0].doc.content[0].type, 'heading');
  assert.equal(model.edits.length, 0);
  assert.equal(model.getValue(), FRONT + BODY);
});

test('committing the unedited serialization writes nothing (no formatting churn)', () => {
  const { model, sync, events } = start(FRONT + BODY);
  assert.equal(sync.commit(codec.serialize(events[0].doc)), false);
  assert.equal(model.edits.length, 0);
  assert.equal(model.getValue(), FRONT + BODY);
});

test('an edit is written as one minimal replacement; front matter and untouched blocks keep their bytes', () => {
  const { model, sync, events } = start(FRONT + BODY);
  const edited = codec.serialize(events[0].doc).replace('Some **bold** text.', 'Some **bold** text, edited.');
  assert.equal(sync.commit(edited), true);
  assert.equal(model.getValue(), `${FRONT}# Notes\n\n* first\n* second\n\nSome **bold** text, edited.\n`);
  assert.equal(model.edits.length, 1);
  const [edit] = model.edits;
  assert.ok(edit.start >= (FRONT + BODY).indexOf('Some __bold__'), 'the edit starts inside the changed block');
  assert.ok(model.stackElements.count >= 1, 'the edit is its own undo step');
  // Our own write does not reload the editor.
  assert.equal(events.filter((event) => event.kind === 'document').length, 1);
});

test('an indentation-only edit inside a code block is written', () => {
  const code = '# Code\n\n```python\nif x:\n    y()\n```\n';
  const { model, sync, events } = start(code);
  assert.equal(sync.commit(codec.serialize(events[0].doc).replace('    y()', '        y()')), true);
  assert.equal(model.getValue(), code.replace('    y()', '        y()'));
});

test('CRLF documents stay CRLF after an edit', () => {
  const crlf = (FRONT + BODY).replace(/\n/g, '\r\n');
  const { model, sync, events } = start(crlf);
  sync.commit(codec.serialize(events[0].doc).replace('# Notes', '# Notes!'));
  assert.equal(model.getValue(), crlf.replace('# Notes', '# Notes!'));
});

test('changes made elsewhere reload the editor; identical bodies do not', () => {
  const { model, events } = start(FRONT + BODY);
  model.setValue(FRONT + BODY);
  assert.equal(events.length, 1);
  model.setValue(`${FRONT}# Renamed\n\nNew body.\n`);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'document');
  assert.equal(events[1].doc.content[0].content[0].text, 'Renamed');
  // A front matter-only change refreshes the banner, not the content.
  model.setValue(`---\ntitle: Other\n---\n# Renamed\n\nNew body.\n`);
  assert.deepEqual(events[2], { kind: 'frontMatter', frontMatter: '---\ntitle: Other\n---\n' });
});

test('content that cannot round-trip is reported instead of loaded', () => {
  const initial = start('<div>raw html</div>\n');
  assert.equal(initial.started, false);
  assert.equal(initial.events[0].kind, 'unsupported');
  assert.match(initial.events[0].reason, /HTML/);
  initial.sync.refresh();
  assert.equal(initial.events.length, 1, 'reported once per content');
  initial.model.setValue('# Fixed\n');
  assert.equal(initial.events.at(-1).kind, 'document');

  const { model, events } = start(BODY);
  model.setValue(`${BODY}\n&copy; 2024\n`);
  assert.equal(events.at(-1).kind, 'unsupported');
});

test('a disposed sync stops following the model', () => {
  const { model, sync, events } = start(BODY);
  sync.dispose();
  model.setValue('# Changed\n');
  assert.equal(events.length, 1);
});
