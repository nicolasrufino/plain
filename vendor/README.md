Vendored files

- tree-sitter-python.wasm: from the npm package tree-sitter-python@0.25.0 (MIT, see tree-sitter-python.LICENSE).
  Vendored instead of installed because that package runs a native build (node-gyp) on install.
  Loaded with web-tree-sitter (pinned in package.json). To update: npm pack tree-sitter-python@<version>, copy the .wasm, run npm test.
- tree-sitter-c-sharp.wasm: from the npm package tree-sitter-c-sharp@0.23.5 (MIT, see tree-sitter-c-sharp.LICENSE).
  Vendored for the same reason. Loaded through src/treesitter.ts, which sets up web-tree-sitter once for every language
  (a second Parser.init() resets the runtime and breaks parsers made before it).
- tree-sitter-java.wasm: from the npm package tree-sitter-java@0.23.5 (MIT, see tree-sitter-java.LICENSE). Same setup.
- tree-sitter-php_only.wasm: from the npm package tree-sitter-php@0.24.2 (MIT, see tree-sitter-php.LICENSE). The package's
  pure-PHP grammar (php_only), for routes, controllers, models, migrations and config; Blade templates aren't read. Same setup.
- tree-sitter-ruby.wasm: from the npm package tree-sitter-ruby@0.23.1 (MIT, see tree-sitter-ruby.LICENSE), for Rails routes,
  controllers, models and migrations; ERB views aren't read. Same setup.
