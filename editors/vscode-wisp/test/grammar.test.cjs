const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const root = path.join(__dirname, '..');
const extension = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8'));
const grammar = JSON.parse(fs.readFileSync(path.join(root, 'syntaxes/wisp.tmLanguage.json'), 'utf8'));

test('combined icon theme keeps Seti file icons alongside Wisp mascots', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'icons/wisp-asfi-seti-icon-theme.json'), 'utf8'));
  assert.equal(theme.languageIds.javascript, '_javascript');
  assert.equal(theme.languageIds.typescript, '_typescript');
  assert.equal(theme.languageIds.json, '_json');
  assert.equal(theme.languageIds.markdown, '_markdown');
  assert.equal(theme.fileExtensions.asfi, '_asfi');
  assert.equal(theme.fileExtensions.wisp, 'wisp-file');
  assert.equal(theme.fileExtensions['events/wisp'], 'wisp-event');
  assert.equal(theme.fileExtensions['modules/wisp'], 'wisp-module');
  assert.ok(fs.existsSync(path.join(root, 'icons', theme.fonts[0].src[0].path)));
  assert.ok(fs.existsSync(path.join(root, 'icons', theme.iconDefinitions._asfi.iconPath)));
});

test('VS Code associates .wisp with the TextMate grammar', () => {
  assert.equal(extension.contributes.languages[0].id, 'wisp');
  assert.ok(extension.contributes.languages[0].extensions.includes('.wisp'));
  assert.equal(extension.contributes.grammars[0].scopeName, grammar.scopeName);
  assert.equal(config.comments.lineComment, '#');
});

test('the installed grammar scopes real Wisp constructs', async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: sources => new oniguruma.OnigScanner(sources),
      createOnigString: source => new oniguruma.OnigString(source)
    }),
    loadGrammar: async scope => scope === grammar.scopeName ? grammar : null
  });
  const loaded = await registry.loadGrammar(grammar.scopeName);
  assert.ok(loaded);
  const hasScope = (line, fragment, scope) => {
    const offset = line.indexOf(fragment);
    assert.notEqual(offset, -1, fragment);
    const token = loaded.tokenizeLine(line, null).tokens.find(t => t.startIndex <= offset && offset < t.endIndex);
    assert.ok(token, fragment);
    assert.ok(token.scopes.some(s => s.startsWith(scope)), `${fragment}: ${token.scopes.join(', ')}`);
  };
  hasScope('command "joinrank":', 'command', 'keyword.declaration.command');
  hasScope('    option user:', 'option', 'keyword.control');
  hasScope('        type: user', 'user', 'support.type.option');
  hasScope('        let rank = guild.joinRank(member)', 'guild', 'support.class.discord');
  hasScope('        let rank = guild.joinRank(member)', 'joinRank', 'support.function.builtin');
  hasScope('        let count = 42', '42', 'constant.numeric');
  hasScope('        reply "Hello, {interaction.user.name}!"', 'interaction', 'support.class.discord');
  hasScope('# a comment', '#', 'comment.line');
  hasScope('    try:', 'try', 'keyword.control');
  hasScope('    catch error:', 'catch', 'keyword.control');
  hasScope('        raise "bad"', 'raise', 'keyword.control');
  hasScope('        let parts = text.split(",")', 'split', 'support.function.builtin');
  hasScope('        let data = json.parse(text)', 'json', 'support.class.discord');
  hasScope('        for index in range(5):', 'range', 'support.function.builtin');
  const block = loaded.tokenizeLine('        markdown:', null);
  const markdown = loaded.tokenizeLine('            ## Your Profile', block.ruleStack);
  assert.ok(markdown.tokens.some(token => token.scopes.some(scope => scope.startsWith('string.unquoted.block'))));
  assert.ok(markdown.tokens.every(token => !token.scopes.some(scope => scope.startsWith('comment.line'))));
  const next = loaded.tokenizeLine('        separator', markdown.ruleStack);
  assert.ok(next.tokens.some(token => token.scopes.some(scope => scope.startsWith('keyword.control'))));
});
