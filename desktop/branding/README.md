# Branding

Change this directory when publishing the app under a different name or icon.

- `brand.config.json`: brand variants. Each variant owns the product name, window title, bundle identifier, HTML title, and icon paths.
- `variants/<name>/icons/icon.png`: Tauri bundle icon source for Linux and fallback use.
- `variants/<name>/icons/icon.icns`: macOS app icon.
- `variants/<name>/icons/icon.ico`: Windows app icon.
- `variants/<name>/logo.png`: in-app brand logo used by the AI chat welcome/onboarding UI. The sync script copies it into `public/branding/logo.png` for Vite.

The default variant is `redbox`. `thrive` is already registered and currently reuses the RedBox placeholder icons.

After changing the config or replacing icons, run one of:

```bash
pnpm brand:sync
pnpm brand:sync -- --variant thrive
pnpm brand:sync:thrive
```

Common commands:

```bash
pnpm dev
pnpm dev:thrive
pnpm build
pnpm build:thrive
pnpm tauri:dev
pnpm tauri:dev:thrive
pnpm tauri:build
pnpm tauri:build:thrive
```

You can also set `REDBOX_BRAND=thrive` or `APP_BRAND=thrive` before running existing dev/build commands. The `*:thrive` scripts use `scripts/run-with-brand.mjs` so the selection also reaches Tauri's nested before-dev and before-build commands.

The sync writes:

- `src-tauri/tauri.conf.json`
- `package.json.productName`
- `index.html`
- `src/config/brand.generated.json`
- `public/branding/logo.png`
