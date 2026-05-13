import fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const BRAND_CONFIG_RELATIVE_PATH = 'branding/brand.config.json';
const GENERATED_LOGO_RELATIVE_PATH = 'public/branding/logo.png';
const GENERATED_BRAND_CONFIG_RELATIVE_PATH = 'src/config/brand.generated.json';
const execFile = promisify(execFileCallback);
const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function parseVariantFromArgs(argv = process.argv.slice(2)) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--variant' || arg === '--brand') {
      return argv[index + 1] || '';
    }
    if (arg.startsWith('--variant=')) {
      return arg.slice('--variant='.length);
    }
    if (arg.startsWith('--brand=')) {
      return arg.slice('--brand='.length);
    }
  }
  return '';
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonIfChanged(filePath, value) {
  const nextRaw = `${JSON.stringify(value, null, 2)}\n`;
  let previousRaw = '';
  try {
    previousRaw = await fs.readFile(filePath, 'utf8');
  } catch {
    // File will be created by the write below.
  }
  if (previousRaw === nextRaw) {
    return false;
  }
  await fs.writeFile(filePath, nextRaw, 'utf8');
  return true;
}

async function writeTextIfChanged(filePath, nextRaw) {
  const previousRaw = await fs.readFile(filePath, 'utf8');
  if (previousRaw === nextRaw) {
    return false;
  }
  await fs.writeFile(filePath, nextRaw, 'utf8');
  return true;
}

async function assertFileExists(cwd, relativePath, label) {
  const normalized = assertNonEmptyString(relativePath, label);
  const absolute = path.join(cwd, normalized);
  const stats = await fs.stat(absolute).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`${label} does not exist: ${normalized}`);
  }
  return normalized;
}

async function fileExists(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  return Boolean(stats?.isFile());
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function parsePng(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('appIcon.png must be a PNG file');
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new Error('Invalid PNG chunk table');
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`Invalid PNG chunk length for ${type}`);
    }
    const data = buffer.subarray(dataStart, dataEnd);
    chunks.push({ type, data });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  if (distanceAbove <= distanceUpperLeft) return above;
  return upperLeft;
}

function unfilterPngRows(filtered, width, height, bytesPerPixel) {
  const rowBytes = width * bytesPerPixel;
  const output = Buffer.alloc(rowBytes * height);
  let inputOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filterType = filtered[inputOffset];
    inputOffset += 1;
    const rowOffset = row * rowBytes;
    const previousRowOffset = rowOffset - rowBytes;

    for (let column = 0; column < rowBytes; column += 1) {
      const raw = filtered[inputOffset + column];
      const left = column >= bytesPerPixel ? output[rowOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? output[previousRowOffset + column] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel ? output[previousRowOffset + column - bytesPerPixel] : 0;
      let value = raw;

      if (filterType === 1) {
        value = raw + left;
      } else if (filterType === 2) {
        value = raw + above;
      } else if (filterType === 3) {
        value = raw + Math.floor((left + above) / 2);
      } else if (filterType === 4) {
        value = raw + paethPredictor(left, above, upperLeft);
      } else if (filterType !== 0) {
        throw new Error(`Unsupported PNG filter type ${filterType}`);
      }

      output[rowOffset + column] = value & 0xff;
    }
    inputOffset += rowBytes;
  }

  return output;
}

async function normalizePngToRgba(pngPath) {
  const source = await fs.readFile(pngPath);
  const chunks = parsePng(source);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!ihdr) {
    throw new Error('appIcon.png is missing IHDR');
  }

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compressionMethod = ihdr[10];
  const filterMethod = ihdr[11];
  const interlaceMethod = ihdr[12];

  if (bitDepth !== 8 || compressionMethod !== 0 || filterMethod !== 0 || interlaceMethod !== 0) {
    throw new Error('appIcon.png must be an 8-bit non-interlaced PNG');
  }
  if (colorType === 6) {
    return false;
  }
  if (colorType !== 2) {
    throw new Error('appIcon.png must be RGB or RGBA');
  }

  const idatData = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const inflated = await inflate(idatData);
  const rgb = unfilterPngRows(inflated, width, height, 3);
  const rgbaRows = Buffer.alloc((width * 4 + 1) * height);

  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (width * 4 + 1);
    rgbaRows[rowStart] = 0;
    for (let column = 0; column < width; column += 1) {
      const rgbOffset = (row * width + column) * 3;
      const rgbaOffset = rowStart + 1 + column * 4;
      rgbaRows[rgbaOffset] = rgb[rgbOffset];
      rgbaRows[rgbaOffset + 1] = rgb[rgbOffset + 1];
      rgbaRows[rgbaOffset + 2] = rgb[rgbOffset + 2];
      rgbaRows[rgbaOffset + 3] = 0xff;
    }
  }

  const nextIhdr = Buffer.from(ihdr);
  nextIhdr[9] = 6;
  const nextIdat = await deflate(rgbaRows);
  const ancillaryChunks = chunks.filter((chunk) => !['IHDR', 'IDAT', 'IEND'].includes(chunk.type));
  const nextPng = Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk('IHDR', nextIhdr),
    ...ancillaryChunks.map((chunk) => createPngChunk(chunk.type, chunk.data)),
    createPngChunk('IDAT', nextIdat),
    createPngChunk('IEND'),
  ]);

  await fs.writeFile(pngPath, nextPng);
  return true;
}

async function requireCommand(command, installHint) {
  try {
    await execFile('which', [command]);
  } catch {
    throw new Error(`${command} is required to generate brand icons. ${installHint}`);
  }
}

async function generateIcnsFromPng(sourcePngPath, targetIcnsPath) {
  await requireCommand('sips', 'Install Xcode Command Line Tools on macOS.');
  await requireCommand('iconutil', 'Install Xcode Command Line Tools on macOS.');

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'redbox-brand-icon-'));
  const iconsetPath = path.join(tempRoot, 'icon.iconset');
  await fs.mkdir(iconsetPath, { recursive: true });

  const iconSpecs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  try {
    for (const [filename, size] of iconSpecs) {
      await execFile('sips', ['-z', String(size), String(size), sourcePngPath, '--out', path.join(iconsetPath, filename)]);
    }
    await fs.mkdir(path.dirname(targetIcnsPath), { recursive: true });
    await execFile('iconutil', ['-c', 'icns', iconsetPath, '-o', targetIcnsPath]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function generateIcoFromPng(sourcePngPath, targetIcoPath) {
  const png = await fs.readFile(sourcePngPath);
  const width = 0;
  const height = 0;
  const headerSize = 6;
  const directorySize = 16;
  const imageOffset = headerSize + directorySize;
  const ico = Buffer.alloc(imageOffset + png.length);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt8(width, 6);
  ico.writeUInt8(height, 7);
  ico.writeUInt8(0, 8);
  ico.writeUInt8(0, 9);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(imageOffset, 18);
  png.copy(ico, imageOffset);

  await fs.mkdir(path.dirname(targetIcoPath), { recursive: true });
  await fs.writeFile(targetIcoPath, ico);
}

async function ensureAppIconAssets(cwd, appIcon) {
  const pngRelativePath = await assertFileExists(cwd, appIcon.png, 'appIcon.png');
  const icnsRelativePath = assertNonEmptyString(appIcon.icns, 'appIcon.icns');
  const icoRelativePath = assertNonEmptyString(appIcon.ico, 'appIcon.ico');

  const pngPath = path.join(cwd, pngRelativePath);
  const icnsPath = path.join(cwd, icnsRelativePath);
  const icoPath = path.join(cwd, icoRelativePath);

  if (await normalizePngToRgba(pngPath)) {
    console.log(`[sync-brand] Normalized ${pngRelativePath} to RGBA PNG`);
  }

  if (!(await fileExists(icnsPath))) {
    await generateIcnsFromPng(pngPath, icnsPath);
    console.log(`[sync-brand] Generated ${icnsRelativePath}`);
  }

  if (!(await fileExists(icoPath))) {
    await generateIcoFromPng(pngPath, icoPath);
    console.log(`[sync-brand] Generated ${icoRelativePath}`);
  }

  return [pngRelativePath, icnsRelativePath, icoRelativePath];
}

function resolveVariantName(config, requestedVariant) {
  const variant = String(
    requestedVariant
    || process.env.REDBOX_BRAND
    || process.env.APP_BRAND
    || config.defaultVariant
    || 'redbox'
  ).trim().toLowerCase();
  if (!variant) {
    throw new Error('Brand variant must be a non-empty string');
  }
  return variant;
}

function resolveBrand(config, requestedVariant) {
  const variant = resolveVariantName(config, requestedVariant);
  const variants = config.variants && typeof config.variants === 'object' ? config.variants : {};
  const variantConfig = variants[variant] || null;
  if (!variantConfig) {
    const available = Object.keys(variants).sort().join(', ') || '<none>';
    throw new Error(`Unknown brand variant "${variant}". Available variants: ${available}`);
  }

  const displayName = assertNonEmptyString(variantConfig.displayName, `${variant}.displayName`);
  const cargoPackageName = assertNonEmptyString(variantConfig.cargoPackageName || variant, `${variant}.cargoPackageName`);
  if (!/^[a-z][a-z0-9_-]*$/.test(cargoPackageName)) {
    throw new Error(`${variant}.cargoPackageName must be lowercase ASCII and may contain digits, "_" or "-"`);
  }
  const windowTitle = assertNonEmptyString(variantConfig.windowTitle || displayName, `${variant}.windowTitle`);
  const htmlTitle = assertNonEmptyString(variantConfig.htmlTitle || windowTitle, `${variant}.htmlTitle`);
  const aiDisplayName = assertNonEmptyString(
    variantConfig.aiDisplayName || variantConfig.aiWorkspaceDisplayName || displayName,
    `${variant}.aiDisplayName`
  );
  const identifier = assertNonEmptyString(variantConfig.identifier, `${variant}.identifier`);
  const appIcon = variantConfig.appIcon || {};
  const logo = assertNonEmptyString(variantConfig.logo, `${variant}.logo`);
  const theme = variantConfig.theme && typeof variantConfig.theme === 'object' ? variantConfig.theme : {};
  return {
    variant,
    displayName,
    cargoPackageName,
    windowTitle,
    htmlTitle,
    aiDisplayName,
    identifier,
    appIcon,
    logo,
    tagline: variantConfig.tagline || '',
    downloadUrl: variantConfig.downloadUrl || '',
    githubIssuesUrl: variantConfig.githubIssuesUrl || '',
    githubRepoUrl: variantConfig.githubRepoUrl || '',
    theme,
  };
}

function updateIndexHtml(raw, title) {
  if (!/<title>[\s\S]*?<\/title>/.test(raw)) {
    throw new Error('Failed to locate <title> in index.html');
  }
  return raw.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
}

function replaceCargoPackageName(contents, packageName) {
  const namePattern = /(\[package\][\s\S]*?\nname = )"[^"]+"/;
  const defaultRunPattern = /(\[package\][\s\S]*?\ndefault-run = )"[^"]+"/;
  if (!namePattern.test(contents)) {
    throw new Error('Failed to locate src-tauri/Cargo.toml package.name');
  }
  if (!defaultRunPattern.test(contents)) {
    throw new Error('Failed to locate src-tauri/Cargo.toml package.default-run');
  }
  return contents
    .replace(namePattern, `$1"${packageName}"`)
    .replace(defaultRunPattern, `$1"${packageName}"`);
}

function replaceCargoLockRootPackageName(contents, packageName) {
  const pattern = /(\[\[package\]\]\nname = )"(redbox|thrive)"(\nversion = "\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?")/;
  if (!pattern.test(contents)) {
    throw new Error('Failed to locate src-tauri/Cargo.lock root package');
  }
  return contents.replace(pattern, `$1"${packageName}"$3`);
}

export async function syncBrand({ cwd = process.cwd(), variant: requestedVariant = '' } = {}) {
  const brandConfigPath = path.join(cwd, BRAND_CONFIG_RELATIVE_PATH);
  const packageJsonPath = path.join(cwd, 'package.json');
  const cargoTomlPath = path.join(cwd, 'src-tauri', 'Cargo.toml');
  const cargoLockPath = path.join(cwd, 'src-tauri', 'Cargo.lock');
  const tauriConfigPath = path.join(cwd, 'src-tauri', 'tauri.conf.json');
  const indexHtmlPath = path.join(cwd, 'index.html');
  const generatedBrandConfigPath = path.join(cwd, GENERATED_BRAND_CONFIG_RELATIVE_PATH);

  const config = await readJson(brandConfigPath);
  const brand = resolveBrand(config, requestedVariant);

  const iconPaths = await ensureAppIconAssets(cwd, brand.appIcon);
  const tauriIconPaths = iconPaths.map((iconPath) => `../${iconPath}`);
  await assertFileExists(cwd, brand.logo, 'logo');
  const logoSourcePath = path.join(cwd, brand.logo);
  const generatedLogoPath = path.join(cwd, GENERATED_LOGO_RELATIVE_PATH);
  await fs.mkdir(path.dirname(generatedLogoPath), { recursive: true });
  await fs.copyFile(logoSourcePath, generatedLogoPath);

  const packageJson = await readJson(packageJsonPath);
  const cargoTomlRaw = await fs.readFile(cargoTomlPath, 'utf8');
  const cargoLockRaw = await fs.readFile(cargoLockPath, 'utf8');
  const tauriConfig = await readJson(tauriConfigPath);
  packageJson.productName = brand.displayName;
  const nextCargoToml = replaceCargoPackageName(cargoTomlRaw, brand.cargoPackageName);
  const nextCargoLock = replaceCargoLockRootPackageName(cargoLockRaw, brand.cargoPackageName);
  tauriConfig.productName = brand.displayName;
  tauriConfig.identifier = brand.identifier;
  if (Array.isArray(tauriConfig.app?.windows) && tauriConfig.app.windows[0]) {
    tauriConfig.app.windows[0].title = brand.windowTitle;
  }
  tauriConfig.bundle = tauriConfig.bundle || {};
  tauriConfig.bundle.icon = tauriIconPaths;

  const indexHtmlRaw = await fs.readFile(indexHtmlPath, 'utf8');
  const nextIndexHtml = updateIndexHtml(indexHtmlRaw, brand.htmlTitle);
  const generatedBrandConfig = {
    variant: brand.variant,
    displayName: brand.displayName,
    windowTitle: brand.windowTitle,
    htmlTitle: brand.htmlTitle,
    aiDisplayName: brand.aiDisplayName,
    logoSrc: '/branding/logo.png',
    tagline: brand.tagline,
    downloadUrl: brand.downloadUrl,
    githubIssuesUrl: brand.githubIssuesUrl,
    githubRepoUrl: brand.githubRepoUrl,
    theme: brand.theme,
  };

  const [packageChanged, cargoTomlChanged, cargoLockChanged, tauriChanged, indexChanged, generatedBrandChanged] = await Promise.all([
    writeJsonIfChanged(packageJsonPath, packageJson),
    writeTextIfChanged(cargoTomlPath, nextCargoToml),
    writeTextIfChanged(cargoLockPath, nextCargoLock),
    writeJsonIfChanged(tauriConfigPath, tauriConfig),
    writeTextIfChanged(indexHtmlPath, nextIndexHtml),
    writeJsonIfChanged(generatedBrandConfigPath, generatedBrandConfig),
  ]);

  if (packageChanged || cargoTomlChanged || cargoLockChanged || tauriChanged || indexChanged || generatedBrandChanged) {
    console.log(`[sync-brand] Synced brand "${brand.displayName}" (${brand.variant})`);
  }

  return {
    variant: brand.variant,
    displayName: brand.displayName,
    generatedLogo: GENERATED_LOGO_RELATIVE_PATH,
    generatedBrandConfig: GENERATED_BRAND_CONFIG_RELATIVE_PATH,
    packageChanged,
    cargoTomlChanged,
    cargoLockChanged,
    tauriChanged,
    indexChanged,
    generatedBrandChanged,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  syncBrand({ variant: parseVariantFromArgs() }).catch((error) => {
    console.error(`[sync-brand] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
