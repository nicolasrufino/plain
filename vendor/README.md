Vendored files

- tree-sitter-python.wasm: from the npm package tree-sitter-python@0.25.0 (MIT, see tree-sitter-python.LICENSE).
  Vendored instead of installed because that package runs a native build (node-gyp) on install.
  Loaded with web-tree-sitter (pinned in package.json). To update: npm pack tree-sitter-python@<version>, copy the .wasm, run npm test.
