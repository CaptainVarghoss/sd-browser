import { IMG_FOLDER } from '$env/static/private';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { searchKeywords, type ImageList, type MatchType, type SearchMode, type ServerImage, type SortingMethod } from '$lib/types';
import fs from 'fs/promises';
import exifr from 'exifr';
import { getNegativePrompt, getParams, getPositivePrompt } from '$lib/tools/metadataInterpreter';
import Watcher from 'watcher';
import type { WatcherOptions } from 'watcher/dist/types';
import { XOR, selectRandom, validRegex } from '$lib/tools/misc';
import _ from 'lodash';
import { generateCompressedFromId, generateThumbnailFromId } from './convert';

type TimedImage = {
    id: string;
    timestamp: number;
};

let watcher: Watcher | undefined;
let imageList: ImageList = new Map();
let freshList: TimedImage[] = [];
const deletionList: TimedImage[] = [];
const freshLimit = 1000;

export const datapath = './localData';
export const thumbnailPath = path.join(datapath, 'thumbnails');
export const compressedPath = path.join(datapath, 'compressed');

export async function startFileManager() {
    await indexFiles();
    setupWatcher();
}

export async function indexFiles() {
    console.log('Indexing files...');
    fs.mkdir(datapath).catch(() => '');
    fs.mkdir(thumbnailPath).catch(() => '');
    fs.mkdir(compressedPath).catch(() => '');

    // Read cached data
    let imageCache: ImageList | undefined;
    const images: ImageList = new Map();
    const cachefile = path.join(datapath, 'metadata.json');
    try {
        const cache = await fs.readFile(cachefile);
        imageCache = new Map(JSON.parse(cache.toString()));
    } catch {
        imageCache = undefined;
    }

    const dirs: string[] = [IMG_FOLDER];

    while (dirs.length > 0) {
        const dir = dirs.pop();
        if (!dir) continue;
        const dirShort = path.basename(dir);
        console.log(`Indexing ${dir}`);
        const files = await readdir(dir);

        for (const file of files.filter(x => x.endsWith('.png'))) {
            const fullpath = path.join(dir, file);
            const hash = hashString(fullpath);
            if (imageCache && imageCache.has(hash)) {
                images.set(hash, imageCache.get(hash)!);
                continue;
            }

            const metadata = await readMetadata(fullpath);
            images.set(hash, {
                id: hash,
                folder: dirShort,
                file: fullpath,
                modifiedDate: 0,
                createdDate: 0,
                ...metadata,
            });
        }

        for (const file of files.filter(x => !x.endsWith('.png'))) {
            const fullpath = path.join(dir, file);
            const stats = await stat(fullpath);
            if (stats.isDirectory()) dirs.push(fullpath);
        }
    }

    console.log('Writing cache file...');
    fs.writeFile(cachefile, JSON.stringify([...images], null, 2)).catch(e => console.log(e));

    imageList = images;
    console.log(`Indexed ${imageList.size} images`);

    cleanTempImages();
}

async function cleanTempImages() {
    let count = 0;
    await fs.readdir(thumbnailPath).then(files => {
        for (const file of files) {
            const id = path.basename(file, '.webp');
            if (!imageList.has(id)) {
                count++;
                fs.unlink(path.join(thumbnailPath, file)).catch(() => '');
            }
        }
    });
    console.log(`Cleaned ${count} thumbnails`);
    count = 0;
    await fs.readdir(compressedPath).then(files => {
        for (const file of files) {
            const id = path.basename(file, '.webp');
            if (!imageList.has(id)) {
                count++;
                fs.unlink(path.join(compressedPath, file)).catch(() => '');
            }
        }
    });
    console.log(`Cleaned ${count} preview images`);
}

let genCount = 0;
const genLimit = 10;
let indexTimer: any;

function setupWatcher() {
    const options: WatcherOptions = {
        recursive: true,
        ignoreInitial: true,
    };

    if (watcher) watcher.close();
    watcher = new Watcher(IMG_FOLDER, options);

    watcher.on('add', async file => {
        if (!file.endsWith('.png')) return;
        const hash = hashString(file);
        if (genCount < genLimit) {
            genCount++;
            await generateCompressedFromId(hash, file);
            await generateThumbnailFromId(hash, file);
            genCount--;
        }
        console.log(`Added ${file}`);
        imageList.set(hash, {
            id: hash,
            folder: path.basename(path.dirname(file)),
            file,
            modifiedDate: 0,
            createdDate: 0,
            ...await readMetadata(file),
        });

        const amount = freshList.unshift({
            id: hash,
            timestamp: Date.now(),
        });
        if (amount > freshLimit) freshList.pop();

        // trigger frontend update?
    });

    watcher.on('rename', async (from, to) => {
        if (from.endsWith('.png')) {
            const oldhash = hashString(from);
            imageList.delete(oldhash);
        }

        if (!to.endsWith('.png')) return;
        const newhash = hashString(to);
        imageList.set(newhash, {
            id: newhash,
            folder: path.basename(path.dirname(to)),
            file: to,
            modifiedDate: 0,
            createdDate: 0,
            ...await readMetadata(to),
        });
    });

    watcher.on('unlink', async file => {
        if (!file.endsWith('.png')) return;
        const hash = hashString(file);
        imageList.delete(hash);
        freshList = freshList.filter(x => x.id !== hash);
        const size = deletionList.unshift({
            id: hash,
            timestamp: Date.now(),
        });
        if (size > freshLimit) deletionList.pop();
    });

    watcher.on('addDir', () => {
        clearTimeout(indexTimer);
        indexTimer = setTimeout(() => {
            indexFiles();
        }, 2000);
    });

    watcher.on('renameDir', () => {
        clearTimeout(indexTimer);
        indexTimer = setTimeout(() => {
            indexFiles();
        }, 2000);
    });

    watcher.on('unlinkDir', dir => {
        for (const [key, value] of imageList) {
            if (value.file.startsWith(dir)) {
                imageList.delete(key);
            }
        }
    });

    console.log('Listening to file changes...');
}

export function getImage(imageid: string) {
    const image = imageList.get(imageid);
    return image;
}

export function searchImages(search: string, filters: string[], mode: SearchMode, collapse?: boolean, timestamp?: number) {
    if (mode === 'regex' && !validRegex(search))
        return [];
    const matcher = buildMatcher(search, mode);
    const filter = buildMatcher(filters.join(' AND '), 'regex');
    let list: ServerImage[] = [];
    let source: ServerImage[] = [];

    if (timestamp) {
        source = getFreshImages(timestamp);
    } else {
        source = [...imageList.values()];
    }

    for (const value of source) {
        if (matcher(value) && filter(value)) {
            list.push(value);
        }
    }

    if (collapse) {
        list = _.uniqBy(list, x => simplifyPrompt(x.prompt));
    }

    return list;
}

function simplifyPrompt(prompt: string | undefined) {
    if (prompt === undefined) return '';
    return prompt
        .replace(/(, )?seed: \d+/i, '')
        .replace(/(, )?([^,]*)version: [^,]*/ig, '');
}

const keywordRegex = `((${searchKeywords.join('|')}) )*`;
const removeRegex = new RegExp(`^${keywordRegex}`);
const notRegex = new RegExp(`^${keywordRegex}NOT `);
const allRegex = new RegExp(`^${keywordRegex}ALL `);
const negativeRegex = new RegExp(`^${keywordRegex}(NEGATIVE|NEG) `);
const folderRegex = new RegExp(`^${keywordRegex}(FOLDER|FD) `);
const paramRegex = new RegExp(`^${keywordRegex}(PARAMS|PR) `);
function buildMatcher(search: string, matching: SearchMode): (image: ServerImage) => boolean {
    const parts = search.split(' AND ');
    const regexes = parts.map(x => {
        const raw = x.replace(removeRegex, '');

        let type: MatchType = 'positive';
        if (allRegex.test(x)) type = 'all';
        else if (negativeRegex.test(x)) type = 'negative';
        else if (folderRegex.test(x)) type = 'folder';
        else if (paramRegex.test(x)) type = 'params';

        return {
            raw,
            regex: new RegExp(raw, 'i'),
            not: x.match(notRegex),
            type,
        };
    });

    return (image: ServerImage) => {
        return !regexes.some(x => {
            const text = getTextByType(image, x.type);

            if (matching === 'contains') {
                return !XOR(x.not, text.toLowerCase().includes(x.raw.toLowerCase()));
            } else if (matching === 'words') {
                const words = x.raw.split(' ');
                return !XOR(x.not, words.every(word => new RegExp(`\\b${word}\\b`, 'i').test(text)));
            } else {
                return !XOR(x.not, x.regex.test(text));
            }
        });
    };
}

function getTextByType(image: ServerImage, type: MatchType) {
    if (!image) return '';
    switch (type) {
        case 'all':
            return `${image.prompt}, Folder: ${image.folder}`;
        case 'positive':
            return getPositivePrompt(image.prompt);
        case 'negative':
            return getNegativePrompt(image.prompt);
        case 'params':
            return getParams(image.prompt);
        case 'folder':
            return image.folder;
        default:
            return '';
    }
}

export function sortImages(images: ServerImage[], sort: SortingMethod): ServerImage[] {
    if (images.length === 0) return images;
    switch (sort) {
        case 'date':
            return [...images].sort(createComparer<ServerImage>(x => x.modifiedDate, true));
        case 'name':
            return [...images].sort(createComparer<ServerImage>(x => x.file, false));
        case 'random':
            return selectRandom(images, 1000);
        default:
            return [];
    }
}

export function getFreshImages(timestamp: number) {
    // return [...imageList.values()].filter(x => x.modifiedDate > timestamp);
    // return freshList.map(x => imageList.get(x)).filter(x => (x?.modifiedDate ?? 0) > timestamp) as ServerImage[];
    const res: ServerImage[] = [];
    for (const item of freshList) {
        const img = imageList.get(item.id);
        if (!img) continue;
        if (item.timestamp <= timestamp) {
            break;
        }

        res.push(img);
    }
    return res;
}

export function getFreshImageTimestamp(id: string) {
    if (!id) return undefined;
    const item = freshList.find(x => x.id === id);
    return item?.timestamp;
}

export function getDeletedImageIds(timestamp: number) {
    const res: string[] = [];
    for (const deletion of deletionList) {
        if (deletion.timestamp <= timestamp) {
            break;
        }

        res.push(deletion.id);
    }
    return res;
}

function createComparer<T>(selector: (a: T) => any, descending: boolean) {
    return (a: T, b: T) => {
        return selector(a) < selector(b)
            ? (descending ? 1 : -1)
            : selector(a) > selector(b)
                ? (descending ? -1 : 1)
                : 0;
    };
}

function hashString(filepath: string) {
    const hash = crypto.createHash('sha256');
    hash.update(filepath);
    return hash.digest('hex');
}

async function readMetadata(imagepath: string): Promise<Partial<ServerImage>> {
    try {
        const stats = await stat(imagepath);
        const res: Partial<ServerImage> = {
            modifiedDate: stats.mtimeMs,
            createdDate: stats.birthtimeMs,
        };

        const file = await fs.readFile(imagepath);
        let metadata = await exifr.parse(file);
        if (!metadata)
            return {};
        metadata = {
            ...res,
            prompt: metadata.parameters ?? undefined
        } satisfies Partial<ServerImage>;

        return metadata;
    } catch {
        console.log(`Failed to read metadata for ${imagepath}`);
        return {};
    }
}