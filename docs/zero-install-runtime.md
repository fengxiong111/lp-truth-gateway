# Zero-install request invariant

Interactive request workflows MUST execute committed prebundled `dist/*.mjs` artifacts directly with the runner image's Node runtime. `npm install`, `npm ci`, `npx`, TypeScript transpilation and dependency resolution are forbidden on the request path.

Build/test workflows may install toolchains and regenerate `dist` after source changes. The request path is intentionally reduced to checkout -> `node dist/*.mjs` -> publish output.
