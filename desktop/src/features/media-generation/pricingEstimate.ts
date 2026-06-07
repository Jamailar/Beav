import type { AiPricingCatalog, AiPricingModel, AiPricingRate } from '../settings/settingsModel';
import { normalizePricingNumber } from '../settings/settingsModel';

export type GenerationCostEstimate = {
    points: number;
    label: string;
    title: string;
};

type ImageEstimateInput = {
    model: string;
    count: number;
    quality?: string;
    resolution?: string;
};

type VideoEstimateInput = {
    model: string;
    durationSeconds: number;
    resolution?: string;
};

type AudioEstimateInput = {
    model: string;
    text: string;
};

const DEFAULT_IMAGE_RESOLUTION = '2K';
const DEFAULT_IMAGE_QUALITY = 'medium';

const normalizeToken = (value: unknown): string => String(value || '').trim().toLowerCase();

const normalizeResolution = (value: unknown, fallback = ''): string => {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.toLowerCase() === 'auto') return fallback;
    return normalized.toUpperCase();
};

const rowValue = (row: AiPricingRate, key: string): unknown => (
    row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined
);

const rowNumber = (row: AiPricingRate, key: string): number | null => normalizePricingNumber(rowValue(row, key));

const findPricingModel = (
    catalog: AiPricingCatalog | null,
    modelId: string,
    groupType: 'image' | 'video' | 'tts',
): AiPricingModel | null => {
    const normalizedModelId = normalizeToken(modelId);
    if (!catalog || !normalizedModelId) return null;
    const groups = catalog.groups.filter((group) => normalizeToken(group.type) === groupType);
    for (const group of groups) {
        const matched = group.models.find((model) => (
            normalizeToken(model.model) === normalizedModelId
            || normalizeToken(model.display_name) === normalizedModelId
        ));
        if (matched) return matched;
    }
    return null;
};

const formatEstimatePoints = (points: number): string => {
    if (Number.isInteger(points)) return points.toLocaleString();
    return points.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const toEstimate = (points: number | null | undefined): GenerationCostEstimate | null => {
    if (points === null || points === undefined || !Number.isFinite(points) || points < 0) return null;
    const label = formatEstimatePoints(points);
    return {
        points,
        label,
        title: `预计消耗 ${label} 积分`,
    };
};

export const combineGenerationCostEstimates = (
    estimates: Array<GenerationCostEstimate | null>,
): GenerationCostEstimate | null => {
    if (estimates.some((estimate) => !estimate)) return null;
    const points = estimates.reduce((sum, estimate) => sum + (estimate?.points || 0), 0);
    return toEstimate(points);
};

const bestImagePointsPerCall = (model: AiPricingModel, quality?: string, resolution?: string): number | null => {
    const requestedQuality = normalizeToken(quality || DEFAULT_IMAGE_QUALITY);
    const requestedResolution = normalizeResolution(resolution, DEFAULT_IMAGE_RESOLUTION);
    const rows = [
        ...(Array.isArray(model.price_table) ? model.price_table : []),
        ...(Array.isArray(model.image_quality_resolution_rates) ? model.image_quality_resolution_rates : []),
    ];
    const rankedRows = rows
        .map((row) => {
            const points = rowNumber(row, 'points_per_call');
            if (points === null) return null;
            const rowQuality = normalizeToken(rowValue(row, 'quality'));
            const rowResolution = normalizeResolution(rowValue(row, 'resolution'));
            const qualityMatches = !rowQuality || rowQuality === requestedQuality;
            const resolutionMatches = !rowResolution || rowResolution === requestedResolution;
            if (!qualityMatches || !resolutionMatches) return null;
            const score = (rowQuality ? 1 : 0) + (rowResolution ? 1 : 0);
            return { points, score };
        })
        .filter((row): row is { points: number; score: number } => Boolean(row))
        .sort((a, b) => b.score - a.score);

    if (rankedRows.length > 0) return rankedRows[0].points;
    return normalizePricingNumber(model.points_per_call);
};

export const estimateImageGenerationPoints = (
    catalog: AiPricingCatalog | null,
    input: ImageEstimateInput,
): GenerationCostEstimate | null => {
    const model = findPricingModel(catalog, input.model, 'image');
    if (!model) return null;
    const pointsPerCall = bestImagePointsPerCall(model, input.quality, input.resolution);
    if (pointsPerCall === null) return null;
    return toEstimate(pointsPerCall * Math.max(1, Math.floor(input.count || 1)));
};

export const estimateCoverGenerationPoints = (
    catalog: AiPricingCatalog | null,
    input: Omit<ImageEstimateInput, 'resolution'>,
): GenerationCostEstimate | null => estimateImageGenerationPoints(catalog, {
    ...input,
    resolution: DEFAULT_IMAGE_RESOLUTION,
});

const bestVideoPointsPerSecond = (model: AiPricingModel, resolution?: string): number | null => {
    const requestedResolution = normalizeResolution(resolution);
    const rows = [
        ...(Array.isArray(model.price_table) ? model.price_table : []),
        ...(Array.isArray(model.video_resolution_rates) ? model.video_resolution_rates : []),
    ];
    const matchedRow = rows.find((row) => {
        const points = rowNumber(row, 'points_per_second');
        if (points === null) return false;
        const rowResolution = normalizeResolution(rowValue(row, 'resolution'));
        return !requestedResolution || !rowResolution || rowResolution === requestedResolution;
    });
    return matchedRow ? rowNumber(matchedRow, 'points_per_second') : null;
};

export const estimateVideoGenerationPoints = (
    catalog: AiPricingCatalog | null,
    input: VideoEstimateInput,
): GenerationCostEstimate | null => {
    const model = findPricingModel(catalog, input.model, 'video');
    if (!model) return null;
    const durationSeconds = Math.max(1, Math.floor(input.durationSeconds || 1));
    const pointsPerSecond = bestVideoPointsPerSecond(model, input.resolution);
    if (pointsPerSecond !== null) return toEstimate(pointsPerSecond * durationSeconds);

    const pointsPerMinute = normalizePricingNumber(model.points_per_minute);
    if (pointsPerMinute !== null) return toEstimate(pointsPerMinute * (durationSeconds / 60));

    const pointsPerCall = normalizePricingNumber(model.points_per_call);
    if (pointsPerCall !== null) return toEstimate(pointsPerCall);

    return null;
};

const compactTextForBilling = (text: string): string => text.replace(/<break\s+time="[^"]+"\s*\/>/gi, '').trim();

export const estimateAudioGenerationPoints = (
    catalog: AiPricingCatalog | null,
    input: AudioEstimateInput,
): GenerationCostEstimate | null => {
    const model = findPricingModel(catalog, input.model, 'tts');
    if (!model) return null;
    const pointsPer100Chars = normalizePricingNumber(model.points_per_100_chars)
        ?? (Array.isArray(model.price_table)
            ? model.price_table.map((row) => rowNumber(row, 'points_per_100_chars')).find((points): points is number => points !== null)
            : null);
    if (pointsPer100Chars === null) return null;
    const characterCount = Array.from(compactTextForBilling(input.text)).length;
    const billableUnits = Math.max(1, Math.ceil(characterCount / 100));
    return toEstimate(pointsPer100Chars * billableUnits);
};
