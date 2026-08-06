# @minicomputer/client

Client SDK for the Minicomputer API. It works in Node.js 18+, Bun and browser environments that provide `fetch`, `crypto.subtle` and `AbortSignal.timeout`.

```bash
npm install @minicomputer/client
```

```ts
import { Minicomputer } from "@minicomputer/client";

const api = new Minicomputer({
  endpoint: "http://localhost:8080",
  secret: process.env.MINICOMPUTER_SECRET,
});

const vm = await api.create("alpine:3.20", {
  policy: { scopes: ["fs.read", "fs.write", "stats"] },
});

await vm.fsWrite("/workspace/hello.txt", "hello");
const contents = await vm.fsRead("/workspace/hello.txt");
```

The package is built from `src/` into `dist/` with JavaScript and TypeScript declarations.

To create the npm tarball locally:

```bash
npm run build
npm pack --dry-run
```

Publish from this directory with `npm publish --access public` when the package version has been updated.
