import type { IpcMain, Shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface OfficialFeatureSettingsContext {
  getSettings: () => Record<string, unknown> | undefined;
  saveSettings: (settings: Record<string, unknown>) => void;
  normalizeSettingsInput: (settings: Record<string, unknown>) => Record<string, unknown>;
}

export interface OfficialFeatureRegisterContext extends OfficialFeatureSettingsContext {
  ipcMain: IpcMain;
  shell: Shell;
}

export interface OfficialTranscriptionAuthContext {
  endpoint: string;
  apiKey: string;
}

export interface OfficialTranscriptionAuthResult {
  handled: boolean;
  officialGateway?: boolean;
  authMode?: 'api-key' | 'access-token';
  apiKey?: string;
  error?: string;
}

export interface OfficialFeatureModule {
  registerOfficialFeatures?: (context: OfficialFeatureRegisterContext) => Promise<void> | void;
  syncOfficialAiRoutingOnStartup?: (context: OfficialFeatureSettingsContext) => Promise<void> | void;
  prepareOfficialTranscriptionAuth?: (
    context: OfficialTranscriptionAuthContext,
  ) => Promise<OfficialTranscriptionAuthResult> | OfficialTranscriptionAuthResult;
}

let cachedOfficialFeatureModulePromise: Promise<OfficialFeatureModule | null> | null = null;

const getOfficialRuntimeCandidates = (): string[] => {
  const relativeRuntimePath = path.join('.private-runtime', 'private', 'electron', 'registerOfficialFeatures.js');
  return [
    path.resolve(__dirname, '..', relativeRuntimePath),
    path.resolve(process.cwd(), relativeRuntimePath),
    path.resolve(process.cwd(), 'archive', 'desktop-electron', relativeRuntimePath),
  ];
};

export const loadOfficialFeatureModule = async (): Promise<OfficialFeatureModule | null> => {
  if (!cachedOfficialFeatureModulePromise) {
    cachedOfficialFeatureModulePromise = (async () => {
      const attemptedErrors: string[] = [];
      for (const candidatePath of getOfficialRuntimeCandidates()) {
        try {
          if (!fs.existsSync(candidatePath)) {
            attemptedErrors.push(`missing:${candidatePath}`);
            continue;
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const loaded = require(candidatePath) as OfficialFeatureModule & { default?: OfficialFeatureModule };
          const resolvedModule = loaded?.default || loaded;
          if (resolvedModule && typeof resolvedModule === 'object') {
            console.log('[official-features] runtime module loaded', candidatePath);
            return resolvedModule;
          }
          attemptedErrors.push(`${candidatePath}: module loaded but no usable export found`);
        } catch (error) {
          attemptedErrors.push(`${candidatePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (attemptedErrors.length) {
        console.warn('[official-features] runtime module unavailable', attemptedErrors);
      }
      return null;
    })();
  }
  return cachedOfficialFeatureModulePromise;
};
