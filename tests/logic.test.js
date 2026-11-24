// Unit tests for the pure logic of content.js. Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'), ctx);
const t = ctx.__requiredApprovalsTest;

// Plain copies: objects made in the vm context fail deepStrictEqual on prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ownersOf = (text, file) => {
  const rule = t.findRule(t.parseCodeowners(text), file);
  return rule ? [...rule.owners] : null;
};

test('patterns follow the GitHub CODEOWNERS rules', () => {
  const cases = [
    // [pattern, path, matches]
    ['*', 'a/b/c.ts', true],
    ['*.js', 'src/x.js', true],
    ['*.js', 'src/x.ts', false],
    ['apps/', 'apps/web/x.ts', true],
    ['apps/', 'libs/apps/x.ts', true],
    ['apps/', 'apps', false],
    ['/build/logs/', 'build/logs/a.log', true],
    ['/build/logs/', 'x/build/logs/a.log', false],
    ['docs/*', 'docs/getting-started.md', true],
    ['docs/*', 'docs/build-app/troubleshooting.md', false],
    ['/docs/', 'docs/build-app/troubleshooting.md', true],
    ['**/logs', 'a/b/logs/x.log', true],
    ['**/logs', 'logs/x.log', true],
    ['docs/**/x.md', 'docs/x.md', true],
    ['docs/**/x.md', 'docs/a/b/x.md', true],
    ['libraries/x', 'libraries/x/src/a.ts', true],
    ['libraries/x', 'other/libraries/x/a.ts', false],
    ['libraries/x', 'libraries/xy/a.ts', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['file.name+x', 'file.name+x', true],
    ['file.name+x', 'fileXname+x', false],
  ];
  for (const [pattern, file, expected] of cases) {
    assert.equal(t.patternToRegex(pattern).test(file), expected, `${pattern} on ${file}`);
  }
});

test('the last matching rule wins, and a rule without owner removes the owners', () => {
  const text = [
    '# comment',
    '*                 @org/default',
    'libraries/        @org/libs   # trailing comment',
    'libraries/free',
    'apps/web/         @org/web @someone',
    '',
  ].join('\r\n');
  assert.deepEqual(ownersOf(text, 'README.md'), ['@org/default']);
  assert.deepEqual(ownersOf(text, 'libraries/a/x.ts'), ['@org/libs']);
  assert.deepEqual(ownersOf(text, 'libraries/free/x.ts'), []);
  assert.deepEqual(ownersOf(text, 'apps/web/x.ts'), ['@org/web', '@someone']);
});

test('groupFiles makes one group per owner set, ignoring order and case', () => {
  const rules = t.parseCodeowners(
    ['*  @org/default', 'libraries/a/  @org/A @org/B', 'libraries/b/  @org/b @org/a', 'libraries/c/  @org/c', 'libraries/none/'].join('\n')
  );
  const groups = plain(
    t.groupFiles(rules, [
      'README.md',
      'libraries/a/x.ts',
      'libraries/a/y.ts',
      'libraries/b/x.ts',
      'libraries/c/x.ts',
      'libraries/none/x.ts',
    ])
  );
  assert.equal(groups.length, 3);
  assert.equal(groups[0].total, 3);
  assert.deepEqual(groups[0].folders, [['a', 2], ['b', 1]]);
  assert.equal(groups[0].source, 'folder');
  assert.deepEqual(groups[0].folderRules, ['libraries/a/', 'libraries/b/']);
  const global = groups.find((g) => g.source === 'global');
  assert.deepEqual(global.owners, ['@org/default']);
  assert.deepEqual(global.folders, [['README.md', 1]]);
});

test('compareOwners lists the folders whose owners change', () => {
  const base = t.parseCodeowners('*  @org/platform\nlibraries/b/ @org/b');
  const head = t.parseCodeowners('*  @org/platform\nlibraries/a/ @org/a\nlibraries/b/ @org/B');
  const changes = plain(t.compareOwners(base, head, ['libraries/a/1.ts', 'libraries/a/2.ts', 'libraries/b/1.ts', 'x.ts']));
  assert.deepEqual(changes, [{ folder: 'a', from: ['@org/platform'], to: ['@org/a'], count: 2 }]);
});

test('folderOf gives the package folder or the file name', () => {
  assert.equal(t.folderOf('libraries/auth-core/src/a.ts'), 'auth-core');
  assert.equal(t.folderOf('.github/CODEOWNERS'), 'CODEOWNERS');
  assert.equal(t.folderOf('tsconfig.json'), 'tsconfig.json');
});

test('jsonEndFinder finds the end of an array split across chunks', () => {
  const json = '[{"path":"a/b].ts","x":"\\"]"},{"path":"c{.ts"}]';
  const full = json + ',"other":1}';
  const find = t.jsonEndFinder();
  assert.equal(find(full.slice(0, 10)), -1);
  assert.equal(find(full.slice(0, 30)), -1);
  const end = find(full);
  assert.equal(full.slice(0, end), json);
  assert.deepEqual(JSON.parse(full.slice(0, end)).map((e) => e.path), ['a/b].ts', 'c{.ts']);
  assert.equal(t.jsonEndFinder()('null,"x":1'), 0);
  assert.equal(t.jsonEndFinder()(''), -1);
});

test('baseRefFromClassicHtml reads the base branch of the classic header', () => {
  const html =
    'merged 3 commits into <span title="cli/cli:release/1.0" class="commit-ref css-truncate expandable "><a>x</a></span> from ' +
    '<span title="fork/cli:feature&amp;fix" class="commit-ref css-truncate expandable head-ref">';
  assert.equal(t.baseRefFromClassicHtml(html), 'release/1.0');
  assert.equal(t.baseRefFromClassicHtml('<span class="commit-ref head-ref" title="a/b:x">'), null);
});

test('rebuildShortPaths restores shortened paths when the match is unique', () => {
  const known = ['libraries/contrib/layout/x.ts', 'apps/a/layout/y.ts', 'apps/b/layout/y.ts'];
  assert.deepEqual(plain(t.rebuildShortPaths(['...rib/layout/x.ts', 'z.ts'], known)), {
    files: ['libraries/contrib/layout/x.ts', 'z.ts'],
    approximate: false,
  });
  assert.equal(t.rebuildShortPaths(['.../layout/y.ts'], known).approximate, true);
});

test('decodeHtml decodes the entities GitHub uses in attributes', () => {
  assert.equal(t.decodeHtml('a&amp;b&quot;c&#39;d&lt;e&gt;'), 'a&b"c\'d<e>');
});
