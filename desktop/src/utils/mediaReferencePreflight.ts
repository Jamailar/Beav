type MediaPreflightOptions = {
  maxLongEdge?: number;
  hardMaxLongEdge?: number;
  compressAboveBytes?: number;
  jpegQuality?: number;
  maxOutputBytes?: number;
};

type ImageInfo = {
  dataUrl: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  optimized: boolean;
};

type PayloadRecord = Record<string, unknown>;

const DEFAULT_MAX_LONG_EDGE = 2048;
const DEFAULT_HARD_MAX_LONG_EDGE = 3072;
const DEFAULT_COMPRESS_ABOVE_BYTES = 4 * 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 0.86;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const IMAGE_FIELDS = [
  'image',
  'imageUrl',
  'baseImage',
  'templateImage',
  'firstClip',
  'drivingAudio',
];

const IMAGE_ARRAY_FIELDS = [
  'referenceImages',
  'reference_images',
];

function dataUrlMeta(dataUrl: string): { mimeType: string; payload: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
  if (!match) return null;
  return {
    mimeType: match[1].trim().toLowerCase(),
    payload: match[2] || '',
  };
}

function dataUrlByteSize(dataUrl: string): number {
  const meta = dataUrlMeta(dataUrl);
  if (!meta?.payload) return 0;
  const payload = meta.payload.trim();
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function shouldSkipImageMime(mimeType: string): boolean {
  return mimeType === 'image/svg+xml' || mimeType === 'image/gif';
}

function isDataImage(value: unknown): value is string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text.startsWith('data:image/')) return false;
  const meta = dataUrlMeta(text);
  return Boolean(meta?.mimeType) && !shouldSkipImageMime(meta!.mimeType);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read optimized image'));
    reader.readAsDataURL(blob);
  });
}

function loadImageBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };
    image.src = url;
  });
}

function imageDimensions(image: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  if ('width' in image && 'height' in image) {
    return { width: image.width, height: image.height };
  }
  return { width: 0, height: 0 };
}

function closeImage(image: ImageBitmap | HTMLImageElement): void {
  if ('close' in image && typeof image.close === 'function') {
    image.close();
  }
}

function targetSize(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxLongEdge || longest <= 0) {
    return { width, height };
  }
  const scale = maxLongEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasHasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  try {
    const data = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 255) return true;
    }
  } catch {
    return true;
  }
  return false;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to encode optimized image'));
      }
    }, mimeType, quality);
  });
}

async function renderImage(
  image: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    throw new Error('Failed to prepare image optimizer');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return { canvas, context };
}

async function encodeOptimizedImage(
  image: ImageBitmap | HTMLImageElement,
  sourceMimeType: string,
  edge: number,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number; preservePng: boolean }> {
  const dimensions = imageDimensions(image);
  const size = targetSize(dimensions.width, dimensions.height, edge);
  const { canvas, context } = await renderImage(image, size.width, size.height);
  const preservePng = sourceMimeType === 'image/png' && canvasHasTransparency(context, size.width, size.height);
  const outputMimeType = preservePng ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(canvas, outputMimeType, preservePng ? undefined : quality);
  canvas.width = 0;
  canvas.height = 0;
  return { blob, width: size.width, height: size.height, preservePng };
}

async function optimizeDataImage(
  dataUrl: string,
  options?: MediaPreflightOptions,
): Promise<ImageInfo> {
  const meta = dataUrlMeta(dataUrl);
  const mimeType = meta?.mimeType || 'application/octet-stream';
  const originalBytes = dataUrlByteSize(dataUrl);
  if (!meta || shouldSkipImageMime(mimeType)) {
    return { dataUrl, mimeType, bytes: originalBytes, width: 0, height: 0, optimized: false };
  }

  const maxLongEdge = options?.maxLongEdge || DEFAULT_MAX_LONG_EDGE;
  const hardMaxLongEdge = options?.hardMaxLongEdge || DEFAULT_HARD_MAX_LONG_EDGE;
  const compressAboveBytes = options?.compressAboveBytes || DEFAULT_COMPRESS_ABOVE_BYTES;
  const jpegQuality = options?.jpegQuality || DEFAULT_JPEG_QUALITY;
  const maxOutputBytes = options?.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

  const response = await fetch(dataUrl);
  const sourceBlob = await response.blob();
  const image = await loadImageBitmap(sourceBlob);
  try {
    const dimensions = imageDimensions(image);
    const longest = Math.max(dimensions.width, dimensions.height);
    const shouldOptimize = originalBytes > compressAboveBytes || longest > maxLongEdge;
    if (!shouldOptimize) {
      return {
        dataUrl,
        mimeType,
        bytes: originalBytes,
        width: dimensions.width,
        height: dimensions.height,
        optimized: false,
      };
    }

    const firstEdge = Math.min(Math.max(maxLongEdge, 1), Math.max(hardMaxLongEdge, 1));
    const edgeCandidates = Array.from(new Set([
      firstEdge,
      Math.min(1536, firstEdge),
      Math.min(1280, firstEdge),
    ])).filter((edge) => edge > 0);
    const qualityCandidates = Array.from(new Set([
      jpegQuality,
      Math.min(jpegQuality, 0.78),
      Math.min(jpegQuality, 0.68),
    ])).filter((quality) => quality > 0 && quality <= 1);

    let best: { blob: Blob; width: number; height: number } | null = null;
    for (const edge of edgeCandidates) {
      for (const quality of qualityCandidates) {
        const encoded = await encodeOptimizedImage(image, mimeType, edge, quality);
        if (!best || encoded.blob.size < best.blob.size) {
          best = {
            blob: encoded.blob,
            width: encoded.width,
            height: encoded.height,
          };
        }
        if (encoded.blob.size <= maxOutputBytes) {
          const optimizedDataUrl = await blobToDataUrl(encoded.blob);
          return {
            dataUrl: encoded.blob.size < originalBytes ? optimizedDataUrl : dataUrl,
            mimeType: encoded.blob.type || mimeType,
            bytes: Math.min(encoded.blob.size, originalBytes),
            width: encoded.width,
            height: encoded.height,
            optimized: encoded.blob.size < originalBytes,
          };
        }
        if (encoded.preservePng) break;
      }
    }

    if (best && best.blob.size < originalBytes) {
      return {
        dataUrl: await blobToDataUrl(best.blob),
        mimeType: best.blob.type || mimeType,
        bytes: best.blob.size,
        width: best.width,
        height: best.height,
        optimized: true,
      };
    }
    return {
      dataUrl,
      mimeType,
      bytes: originalBytes,
      width: dimensions.width,
      height: dimensions.height,
      optimized: false,
    };
  } finally {
    closeImage(image);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function preflightImageValue(value: unknown, options?: MediaPreflightOptions): Promise<unknown> {
  if (!isDataImage(value)) {
    return value;
  }
  try {
    const result = await optimizeDataImage(value, options);
    return result.dataUrl;
  } catch (error) {
    console.warn('[RedBox] reference image preflight skipped:', error);
    return value;
  }
}

export async function preflightGenerationMediaPayload<T extends PayloadRecord>(
  payload: T,
  options?: MediaPreflightOptions,
): Promise<T> {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const next: PayloadRecord = { ...payload };

  await Promise.all(IMAGE_FIELDS.map(async (field) => {
    if (field in next) {
      next[field] = await preflightImageValue(next[field], options);
    }
  }));

  await Promise.all(IMAGE_ARRAY_FIELDS.map(async (field) => {
    const value = next[field];
    if (!Array.isArray(value)) return;
    next[field] = await mapWithConcurrency(value, 2, (item) => preflightImageValue(item, options));
  }));

  return next as T;
}

export async function preflightInlineAttachmentPayload<T extends { dataUrl: string }>(
  payload: T,
  options?: MediaPreflightOptions,
): Promise<T> {
  if (!payload?.dataUrl || !isDataImage(payload.dataUrl)) {
    return payload;
  }
  const dataUrl = await preflightImageValue(payload.dataUrl, options);
  return {
    ...payload,
    dataUrl: typeof dataUrl === 'string' ? dataUrl : payload.dataUrl,
  };
}
