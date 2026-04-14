# Third-Party Notices

This repository contains a narrowed vendored editor/timeline integration path
derived from FreeCut and a small set of direct runtime dependencies used on that
path.

This file is intentionally scoped to the active vendored FreeCut timeline/editor
surface in `src/vendor/freecut/**` and the renderer/runtime packages directly
used around that path. It is not yet a full repository-wide license inventory.

## Vendored FreeCut Subtree

- Component: FreeCut
- Usage in this repository: vendored editor/timeline-related source under
  `src/vendor/freecut/**`
- Upstream source used for attribution:
  `/Users/Jam/LocalDev/GitHub/freecut`
- License: MIT
- Copyright: Copyright (c) 2025 FreeCut

MIT license text reproduced from the upstream `freecut/LICENSE`:

```text
MIT License

Copyright (c) 2025 FreeCut

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Active MIT Dependencies On The Vendored Timeline/Editor Path

These packages are direct runtime dependencies used by the current LexBox
timeline/editor integration and report `MIT` in their installed package
metadata:

| Package | Version | License |
| --- | --- | --- |
| `react` | `18.3.1` | `MIT` |
| `react-dom` | `18.3.1` | `MIT` |
| `zustand` | `5.0.12` | `MIT` |
| `clsx` | `2.1.1` | `MIT` |
| `tailwind-merge` | `3.5.0` | `MIT` |
| `tippy.js` | `6.3.7` | `MIT` |
| `sonner` | `2.0.7` | `MIT` |
| `@radix-ui/react-context-menu` | `2.2.16` | `MIT` |
| `@radix-ui/react-dialog` | `1.1.15` | `MIT` |
| `@radix-ui/react-dropdown-menu` | `2.1.16` | `MIT` |
| `@radix-ui/react-select` | `2.2.6` | `MIT` |
| `@radix-ui/react-separator` | `1.1.8` | `MIT` |
| `@radix-ui/react-slider` | `1.3.6` | `MIT` |
| `@radix-ui/react-slot` | `1.2.4` | `MIT` |

These package/version/license values were read from the installed package
metadata in `node_modules/.pnpm/**/package.json`.

## Scope Note

This notice file does not yet attempt a full third-party bundle for the whole
application. It only covers the currently narrowed vendored FreeCut
timeline/editor path requested for this remediation pass.

## Residual Compliance Ambiguity

The active timeline/editor path also references packages that are not MIT, or
that point to external license files, including but not limited to:

- `lucide-react` (`ISC`)
- `idb` (`ISC`)
- `class-variance-authority` (`Apache-2.0`)
- `wavesurfer.js` (`BSD-3-Clause`)
- `mediabunny` (`MPL-2.0`)
- `remotion` / `@remotion/player` (`SEE LICENSE IN LICENSE.md`)

Those packages were not expanded into full notice text in this narrow patch.
If shipping requires a repository-wide or binary-distribution-ready third-party
license bundle, a follow-up automated inventory/export step is still needed.
