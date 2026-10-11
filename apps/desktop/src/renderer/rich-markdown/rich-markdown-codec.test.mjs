import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRichMarkdownRoundTrip,
  createRichMarkdownCodec,
  minimalTextEdit,
  reconcileMarkdown,
  semanticMarkdown,
} from './rich-markdown-codec.ts';
import { frontMatterLines, splitFrontMatter } from './rich-markdown-frontmatter.ts';

const codec = createRichMarkdownCodec();
const canonical = (markdown) => codec.serialize(codec.parse(markdown));

const DOCUMENT = [
  '# Title',
  '',
  'Intro with *em*, __strong__, ~~gone~~, `code` and a [link](docs/guide.md#setup).',
  '',
  '* first',
  '* second',
  '  * nested',
  '',
  '1. one',
  '2. two',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  '> quoted',
  '',
  '| Name | Size |',
  '| :--- | ---: |',
  '| a    | 1    |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  'Inline $x^2$ math and a price of $5 or $10.',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '<details>',
  '<summary>More</summary>',
  '',
  'Hidden **body**',
  '',
  '</details>',
  '',
  '![chart](images/chart.png)',
  '',
  '***',
  '',
  'Setext heading',
  '--------------',
  '',
].join('\n');

test('every supported construct survives a parse and serialize round trip', () => {
  const result = checkRichMarkdownRoundTrip(codec, DOCUMENT);
  assert.equal(result.ok, true, result.reason);
  assert.equal(semanticMarkdown(result.canonical), semanticMarkdown(DOCUMENT));
  // The canonical form is stable.
  assert.equal(canonical(result.canonical), result.canonical);
  const types = new Set();
  const visit = (node) => {
    types.add(node.type);
    node.content?.forEach(visit);
  };
  visit(result.doc);
  for (const type of ['heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'table', 'codeBlock', 'inlineMath', 'blockMath', 'details', 'image', 'horizontalRule']) {
    assert.ok(types.has(type), `parsed a ${type}`);
  }
});

test('content that would change in the editor fails the round trip', () => {
  for (const markdown of ['<div>raw</div>\n', 'a <kbd>b</kbd>\n', '&copy; 2024\n', '````\n```\ninner\n```\n````\n']) {
    assert.equal(checkRichMarkdownRoundTrip(codec, markdown).ok, false, JSON.stringify(markdown));
  }
});

test('an unchanged document reconciles to its exact original bytes (no churn)', () => {
  const original = DOCUMENT.replace(/\n/g, '\r\n');
  assert.equal(reconcileMarkdown(original, canonical(original)), original);
  const quirky = '+ plus\n+ list\n\nSome __bold__ and _em_.\n\n\n\nTrailing   spaces kept\n\n\n';
  assert.equal(reconcileMarkdown(quirky, canonical(quirky)), quirky);
});

test('an edit rewrites only the changed block and keeps line endings', () => {
  const original = '# Title\r\n\r\n* one\r\n* two\r\n\r\nSome __bold__ text.\r\n\r\nLast para with _em_.\r\n';
  const edited = canonical(original).replace('Last para with *em*.', 'Last para with *em* and more.');
  assert.equal(
    reconcileMarkdown(original, edited),
    '# Title\r\n\r\n* one\r\n* two\r\n\r\nSome __bold__ text.\r\n\r\nLast para with *em* and more.\r\n'
  );
});

test('appended, inserted and removed blocks keep their neighbours intact', () => {
  const original = '* one\n* two\n\nSome __bold__ text.\n';
  const base = canonical(original);
  assert.equal(reconcileMarkdown(original, `${base}\n\nNew paragraph`), '* one\n* two\n\nSome __bold__ text.\n\nNew paragraph\n');
  assert.equal(
    reconcileMarkdown(original, base.replace('Some **bold** text.', '## Heading\n\nSome **bold** text.')),
    '* one\n* two\n\n## Heading\n\nSome __bold__ text.\n'
  );
  assert.equal(reconcileMarkdown(original, base.replace('\n\nSome **bold** text.', '')), '* one\n* two\n');
});

test('whitespace inside code and math blocks is meaningful', () => {
  const four = '```python\nif x:\n    y()\n```\n';
  const eight = four.replace('    y()', '        y()');
  assert.notEqual(semanticMarkdown(four), semanticMarkdown(eight));
  assert.equal(reconcileMarkdown(four, canonical(eight)), eight);
  assert.notEqual(semanticMarkdown('    a  b\n'), semanticMarkdown('    a b\n'));
  assert.notEqual(semanticMarkdown('$$\na  b\n$$\n'), semanticMarkdown('$$\na b\n$$\n'));
  // The editor's own math form still means the same block.
  assert.equal(semanticMarkdown('$$x^2$$\n'), semanticMarkdown('$$\nx^2\n$$\n'));
  // Inline code and inline math too.
  assert.notEqual(semanticMarkdown('Use `a  b` here.\n'), semanticMarkdown('Use `a b` here.\n'));
  assert.notEqual(semanticMarkdown('So $a  b$ holds.\n'), semanticMarkdown('So $a b$ holds.\n'));
  const inline = 'Use `a b` and $x y$.\n';
  const spaced = 'Use `a  b` and $x  y$.\n';
  assert.equal(reconcileMarkdown(inline, canonical(spaced)), spaced);
  // Prices stay plain text, whose spacing is presentation-only.
  assert.equal(semanticMarkdown('$5 and  $10\n'), semanticMarkdown('$5 and $10\n'));
  // Paragraph whitespace stays presentation-only.
  assert.equal(semanticMarkdown('a\nb  c\n'), semanticMarkdown('a b c\n'));
});

test('a changed list, quote or table keeps its untouched children byte for byte', () => {
  const list = '* first\n* second\n';
  assert.equal(reconcileMarkdown(list, canonical(list).replace('first', 'FIRST')), '* FIRST\n* second\n');
  assert.equal(reconcileMarkdown(list, `${canonical(list).replace(/\n*$/, '')}\n- third\n`), '* first\n* second\n* third\n');
  assert.equal(reconcileMarkdown('+ a\n+ b\n+ c\n', canonical('+ a\n+ b\n+ c\n').replace('- b\n', '')), '+ a\n+ c\n');
  const nested = '* top\n  * first\n  * second\n* last\n';
  assert.equal(
    reconcileMarkdown(nested, canonical(nested).replace('first', 'FIRST')),
    '* top\n  * FIRST\n  * second\n* last\n'
  );
  const deep = '1. top\n   + a\n     * deep\n     * kept\n   + b\n2. next\n';
  assert.equal(reconcileMarkdown(deep, canonical(deep).replace('deep', 'DEEP')), deep.replace('deep', 'DEEP'));
  const ordered = '1) one\n1) two\n';
  assert.equal(reconcileMarkdown(ordered, canonical(ordered).replace('two', 'TWO')), '1) one\n1) TWO\n');
  const quote = '>Some __bold__\n>\n>* x\n>* y\n';
  assert.equal(reconcileMarkdown(quote, canonical(quote).replace('y', 'Y')), '>Some __bold__\n>\n>* x\n>* Y\n');
  const table = '|a|b|\n|-|:-|\n|__1__|2|\n|3|4|\n';
  const edited = reconcileMarkdown(table, canonical(table).replace(/\b4\b/, '5'));
  const lines = edited.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['|a|b|', '|-|:-|', '|__1__|2|']);
  assert.equal(semanticMarkdown(edited), semanticMarkdown(table.replace('|4|', '|5|')));
});

test('the minimal edit is one replacement that never splits CRLF or surrogate pairs', () => {
  assert.equal(minimalTextEdit('same', 'same'), null);
  assert.deepEqual(minimalTextEdit('abcdef', 'abXYef'), { start: 2, end: 4, text: 'XY' });
  assert.deepEqual(minimalTextEdit('a\r\nb', 'a\nb'), { start: 1, end: 3, text: '\n' });
  const edit = minimalTextEdit('x😀y', 'x😁y');
  assert.deepEqual(edit, { start: 1, end: 3, text: '😁' });
  const before = 'one\r\ntwo\r\n';
  const after = 'one\r\nTWO\r\n';
  const { start, end, text } = minimalTextEdit(before, after);
  assert.equal(before.slice(0, start) + text + before.slice(end), after);
});

test('front matter splits off byte for byte', () => {
  const yaml = '---\r\ntitle: "A: b"\r\ntags: [x]\r\n---\r\n';
  const split = splitFrontMatter(`${yaml}# Body\r\n`);
  assert.equal(split.frontMatter, yaml);
  assert.equal(split.body, '# Body\r\n');
  assert.deepEqual(frontMatterLines(split.frontMatter), ['title: "A: b"', 'tags: [x]']);
  assert.deepEqual(splitFrontMatter('+++\ntitle = "x"\n+++\nBody'), { frontMatter: '+++\ntitle = "x"\n+++\n', body: 'Body' });
  assert.deepEqual(splitFrontMatter('---\n---\n'), { frontMatter: '---\n---\n', body: '' });
  // A rule that is not at the very top is content.
  assert.deepEqual(splitFrontMatter('text\n---\na: b\n---\n'), { frontMatter: '', body: 'text\n---\na: b\n---\n' });
});
