import { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { indexManager } from './IndexManager';
import { getWorkspacePaths, getSettings } from '../db';
import { normalizeNote, normalizeVideo, normalizeArchiveSample } from './normalization';

export class FileWatcherService {
  private watcher: FSWatcher | null = null;
  private isReady = false;

  constructor() {
    //
  }

  public start() {
    if (this.watcher) return;

    const paths = getWorkspacePaths();
    const redbookDir = paths.knowledgeRedbook;
    const youtubeDir = paths.knowledgeYoutube;
    const archiveDir = path.join(paths.base, 'archives');

    console.log('[FileWatcher] Starting watch on:', redbookDir, youtubeDir, archiveDir);

    this.watcher = chokidar.watch([redbookDir, youtubeDir, archiveDir], {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true, // Don't index everything on start (we rely on existing index or manual rebuild)
      depth: 3 // Limit depth (Archives are deeper: archives/Profile/Sample/...)
    });

    this.watcher
      .on('add', this.handleFileAdd.bind(this))
      .on('change', this.handleFileChange.bind(this))
      .on('unlink', this.handleFileRemove.bind(this))
      .on('unlinkDir', this.handleDirRemove.bind(this))
      .on('ready', () => {
        console.log('[FileWatcher] Initial scan complete. Ready for changes.');
        this.isReady = true;
      })
      .on('error', (error: any) => console.error(`[FileWatcher] Error: ${error}`));
  }

  public stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleFileAdd(filePath: string) {
    if (!this.isValidFile(filePath)) return;
    console.log(`[FileWatcher] File added: ${filePath}`);
    await this.processFile(filePath);
  }

  private async handleFileChange(filePath: string) {
    if (!this.isValidFile(filePath)) return;
    console.log(`[FileWatcher] File changed: ${filePath}`);
    await this.processFile(filePath);
  }

  private async handleFileRemove(filePath: string) {
    const id = this.extractIdFromPath(filePath);
    if (id) {
      console.log(`[FileWatcher] File removed, removing index for: ${id}`);
      indexManager.removeItem(id);
    }
  }

  private async handleDirRemove(dirPath: string) {
    const id = path.basename(dirPath);
    if (id) {
      console.log(`[FileWatcher] Directory removed, removing index for: ${id}`);
      indexManager.removeItem(id);
    }
  }

  private isValidFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    return fileName === 'meta.json' || fileName === 'content.md' || fileName === 'transcript.txt';
  }

  private extractIdFromPath(filePath: string): string | null {
    // Structure:
    // Redbook: .../knowledge/redbook/{ID}/content.md
    // Archives: .../archives/{ProfileID}/{SampleID}/meta.json

    // We assume the directory containing the file is the ID (for Redbook/YouTube)
    // For Archives, it's the directory name of the sample.

    const parentDir = path.dirname(filePath);
    const id = path.basename(parentDir);

    // Simple validation: ID should not be one of the root dirs
    if (id === 'redbook' || id === 'youtube' || id === 'knowledge' || id === 'archives' || id === 'images') return null;

    return id;
  }

  private async processFile(filePath: string) {
    const id = this.extractIdFromPath(filePath);
    if (!id) return;

    const parentDir = path.dirname(filePath);

    try {
      // Determine type based on path
      if (filePath.includes('knowledge/youtube')) {
        await this.indexYoutubeVideo(id, parentDir);
      } else if (filePath.includes('archives')) {
        await this.indexArchiveSample(id, parentDir);
      } else if (filePath.includes('knowledge/redbook')) {
        await this.indexRedbookNote(id, parentDir);
      }
    } catch (error) {
      console.error(`[FileWatcher] Failed to process ${filePath}:`, error);
    }
  }

  private async indexRedbookNote(id: string, dirPath: string) {
    const metaPath = path.join(dirPath, 'meta.json');
    const contentPath = path.join(dirPath, 'content.md');

    try {
      await fs.access(metaPath);
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);

      let content = '';
      try {
        content = await fs.readFile(contentPath, 'utf-8');
      } catch {
        content = meta.content || '';
      }

      indexManager.addToQueue(normalizeNote(id, meta, content));
    } catch (e) {
      console.warn(`[FileWatcher] Skip indexing note ${id}: meta.json missing`);
    }
  }

  private async indexYoutubeVideo(id: string, dirPath: string) {
    const metaPath = path.join(dirPath, 'meta.json');

    try {
      await fs.access(metaPath);
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);

      let content = meta.description || '';
      if (meta.subtitleFile) {
         try {
           const subtitlePath = path.join(dirPath, meta.subtitleFile);
           const subtitle = await fs.readFile(subtitlePath, 'utf-8');
           content += `\n\n${subtitle}`;
         } catch {}
      }

      indexManager.addToQueue(normalizeVideo(id, meta, content, 'user'));
    } catch (e) {
      console.warn(`[FileWatcher] Skip indexing video ${id}: meta.json missing`);
    }
  }

  private async indexArchiveSample(id: string, dirPath: string) {
    const metaPath = path.join(dirPath, 'meta.json');

    try {
      await fs.access(metaPath);
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const sample = JSON.parse(metaContent);

      // We need profile info for normalization.
      // Assuming directory structure: archives/{ProfileID}/{SampleID}
      // Or we can try to get profile_id from sample meta if stored there.

      const profileId = sample.profile_id;
      const profile = { platform: sample.platform || 'Unknown' }; // Minimal mock profile if full data unavailable

      indexManager.addToQueue(normalizeArchiveSample(sample, profile));
    } catch (e) {
      console.warn(`[FileWatcher] Skip indexing archive ${id}: meta.json missing`);
    }
  }
}

export const fileWatcher = new FileWatcherService();
