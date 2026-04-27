import { Buffer } from 'node:buffer';
import type { GithubRelease, GithubRepoStats, GithubSourceFile } from './types';

const githubApiVersion = '2022-11-28';

function buildGithubHeaders(token?: string) {
    return {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': githubApiVersion,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

export async function fetchLatestGithubRelease(owner: string, repo: string, token?: string): Promise<GithubRelease> {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: buildGithubHeaders(token),
        cache: 'no-store',
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub latest release request failed (${response.status}): ${body || response.statusText}`);
    }

    const release = await response.json() as GithubRelease;
    if (release.draft || release.prerelease) {
        throw new Error(`Latest GitHub release is not a stable release: ${release.tag_name}`);
    }

    return release;
}

export async function fetchGithubReleases(owner: string, repo: string, token?: string): Promise<GithubRelease[]> {
    const releases: GithubRelease[] = [];
    let page = 1;

    while (true) {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`, {
            headers: buildGithubHeaders(token),
            cache: 'no-store',
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`GitHub releases request failed (${response.status}): ${body || response.statusText}`);
        }

        const pageReleases = await response.json() as GithubRelease[];
        releases.push(...pageReleases);

        if (pageReleases.length < 100) {
            break;
        }

        page += 1;
    }

    return releases.filter((release) => !release.draft && !release.prerelease);
}

interface GithubRepoStatsResponse {
    html_url?: string;
    stargazers_count?: number;
    forks_count?: number;
}

export async function fetchGithubRepoStats(owner: string, repo: string, token?: string, revalidateSeconds = 3600): Promise<GithubRepoStats> {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: buildGithubHeaders(token),
        next: { revalidate: revalidateSeconds },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub repository stats request failed (${response.status}): ${body || response.statusText}`);
    }

    const stats = await response.json() as GithubRepoStatsResponse;
    if (
        typeof stats.stargazers_count !== 'number'
        || typeof stats.forks_count !== 'number'
        || typeof stats.html_url !== 'string'
    ) {
        throw new Error(`GitHub repository stats response is missing required fields for ${owner}/${repo}`);
    }

    return {
        htmlUrl: stats.html_url,
        stars: stats.stargazers_count,
        forks: stats.forks_count,
    };
}

interface GithubCommitResponse {
    commit?: {
        tree?: {
            sha?: string;
        };
    };
}

interface GithubTreeEntry {
    path?: string;
    type?: string;
    sha?: string;
}

interface GithubTreeResponse {
    tree?: GithubTreeEntry[];
    truncated?: boolean;
}

function encodePath(value: string) {
    return value.split('/').map(encodeURIComponent).join('/');
}

function buildRawGithubUrl(owner: string, repo: string, ref: string, path: string) {
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

export async function fetchGithubDirectoryFiles(
    owner: string,
    repo: string,
    ref: string,
    directory: string,
    token?: string,
): Promise<GithubSourceFile[]> {
    const commitResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
        headers: buildGithubHeaders(token),
        cache: 'no-store',
    });

    if (!commitResponse.ok) {
        const body = await commitResponse.text();
        throw new Error(`GitHub commit request failed (${commitResponse.status}) for ${ref}: ${body || commitResponse.statusText}`);
    }

    const commit = await commitResponse.json() as GithubCommitResponse;
    const treeSha = commit.commit?.tree?.sha;
    if (!treeSha) {
        throw new Error(`GitHub commit ${ref} is missing a tree sha`);
    }

    const treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, {
        headers: buildGithubHeaders(token),
        cache: 'no-store',
    });

    if (!treeResponse.ok) {
        const body = await treeResponse.text();
        throw new Error(`GitHub tree request failed (${treeResponse.status}) for ${ref}: ${body || treeResponse.statusText}`);
    }

    const tree = await treeResponse.json() as GithubTreeResponse;
    if (tree.truncated) {
        throw new Error(`GitHub tree response for ${ref} was truncated; cannot package ${directory}`);
    }

    const prefix = `${directory.replace(/^\/+|\/+$/g, '')}/`;
    const entries = (tree.tree || [])
        .filter((entry) => entry.type === 'blob' && entry.sha && entry.path?.startsWith(prefix))
        .sort((left, right) => String(left.path).localeCompare(String(right.path)));

    if (entries.length === 0) {
        throw new Error(`GitHub directory ${directory} has no files at ${owner}/${repo}@${ref}`);
    }

    return Promise.all(entries.map(async (entry) => {
        const path = entry.path || '';
        const rawResponse = await fetch(buildRawGithubUrl(owner, repo, ref, path), {
            headers: buildGithubHeaders(token),
            cache: 'no-store',
        });

        if (!rawResponse.ok) {
            const body = await rawResponse.text();
            throw new Error(`GitHub raw file request failed (${rawResponse.status}) for ${path}: ${body || rawResponse.statusText}`);
        }

        const body = Buffer.from(await rawResponse.arrayBuffer());

        return {
            path,
            body,
        };
    }));
}
