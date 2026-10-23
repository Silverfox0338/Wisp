# Wisp Language for VS Code

This local extension registers `.wisp` files, preserves TextMate syntax highlighting, and starts a TypeScript language server. It offers parser-based syntax diagnostics, undefined-name diagnostics, completion for actual Wisp host APIs and local variables/functions, module import path completion, hover, signature help, go to definition, references, rename, document symbols, and workspace symbols. A JSON schema supplies `wisp.json` validation and field help. The language server needs no Discord token.

The optional **Wisp Violet** color theme and **Wisp Icons** file icon theme are available from VS Code's theme pickers. Installation does not change your current theme. Component snippets and four-space indentation are included.

Build and package in PowerShell:

```powershell
Set-Location .\editors\vscode-wisp
npm ci
npm test
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension .\wisp-language-0.0.3.vsix --force
```

Reload VS Code after installation. A `.wisp` file should show **Wisp** in the language picker. The server and grammar tests run offline. The VSIX can also be installed via VS Code's **Extensions: Install from VSIX** command.

The language server analyzes open documents and up to 1,000 workspace `.wisp` files for symbol searches. Module completions include explicitly exported names from local files. It does not infer every dynamic value type, and it does not support breakpoints or step-through debugging. Cross-file rename and references are not currently provided. Live extension-host activation has not been exercised by the offline tests; the tests validate the packaged entrypoints and exercise server requests over LSP.
