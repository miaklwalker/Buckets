---
title: "Installation"
description: "Add Buckets to a project and the one runtime dependency it has."
---

```bash
npm install @michaelrwalker/buckets
```

## No build step

If your setup already compiles TypeScript through a bundler like Vite,
Next.js, or esbuild, or through Bun, tsx, or Node's
`--experimental-transform-types`, you're all set: buckets works as-is,
nothing else to configure.

If it doesn't: buckets ships as TypeScript source rather than compiled
output, so `main` and `types` in its `package.json` both point straight at
`main.ts`. A setup that only compiles your own `src/` needs to be told to
also compile `node_modules/@michaelrwalker/buckets`.

Running with plain Node:

```bash
node --experimental-transform-types --disable-warning=ExperimentalWarning your-script.ts
```

## The one dependency

Buckets' only runtime dependency is
[`@standard-schema/spec`](https://standardschema.dev), which is a types-only
package. It disappears at runtime. `defineInput` accepts anything that
implements Standard Schema, so you can bring whichever validation library you
already use:

```bash
npm install zod        # or valibot, arktype, effect, ...
```

Or bring nothing: `defineInput<Product>()` types the input without validating
it at runtime, so schema validation is entirely optional.

## Requirements

- Node 20 or later (or an equivalent TypeScript-aware runtime).
- A TypeScript version recent enough to support `const` type parameters and
  template literal types: the library leans on both to infer condition and
  bucket names from what you pass in.

## Next

Continue to Quick Start for a complete, runnable example.
