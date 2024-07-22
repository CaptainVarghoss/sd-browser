import { IMG_FOLDER } from '$env/static/private';
import { env } from '$env/dynamic/private';
import path from 'path';
import os from 'os';
import cp from 'child_process';
import crypto from 'crypto';
import { searchKeywords, type ImageList, type MatchType, type SearchMode, type ServerImage, type SortingMethod } from '$lib/types';
import fs from 'fs/promises';
import exifr from 'exifr';
import { getComfyPrompts, getMetadataVersion, getNegativePrompt, getParams, getPositivePrompt, getSwarmPrompts } from '$lib/tools/metadataInterpreter';
import Watcher from 'watcher';
import type { WatcherOptions } from 'watcher/dist/types';
import { XOR, calcTimeSpent, limitedParallelMap, print, printLine, selectRandom, updateLine, validRegex } from '$lib/tools/misc';
import { generateCompressedFromId, generateThumbnailFromId } from './convert';
import { sleep } from '$lib/tools/sleep';
import { backgroundTasks } from './background';
import { MetaDB, loadUniqueList, saveUniqueList } from './db';

type TimedImage = {
    id: string;
    timestamp: number;
};

const txtFiletypes = ['txt', 'yaml', 'yml', 'json'] as const;
const pollingInterval = Number(env.POLLING_SECONDS ?? 0) * 1000;

let watcher: Watcher | undefined;
let imageList: ImageList = new Map();
let freshList: TimedImage[] = [];
let uniqueSet: Set<string> = new Set();
let uniqueReverse: Map<string, string> = new Map();
const nsfwList: string[] = [];
const favoriteList: string[] = [];
const deletionList: TimedImage[] = [];
const freshLimit = 1000;
const comfyPromptCache = new Map<string, [string, string]>();

export const datapath = './localData';
export const thumbnailPath = path.join(datapath, 'thumbnails');
export const compressedPath = path.join(datapath, 'compressed');
export let generationDisabled = false;

export async function startFileManager() {
    await indexFiles();
    setupWatcher();
}

export async function indexFiles() {
    console.log(`Indexing files in ${IMG_FOLDER}`);
    const startTimestamp = Date.now();

    fs.mkdir(datapath).catch(() => '');
    fs.mkdir(thumbnailPath).catch(() => '');
    fs.mkdir(compressedPath).catch(() => '');

    // Read cached data
    // eslint-disable-next-line prefer-const
    let [templist, txtmap, cache] = await indexCachedFiles();

    // Initialize existing cache
    if (imageList.size) {
        print(`Building unique list for ${imageList.size} images...`);
        await createUniqueListChunked(cache);
        updateLine(`Unique list created with ${uniqueSet.size} items\n`);
    }

    // Read modified and created dates
    if (templist.length !== 0) {
        templist = await indexBasicFileData(templist);
    }

    if (templist.length !== 0) {
        // sort
        print('Sorting remaining images by modified date...');
        templist.sort((a, b) => b.modifiedDate - a.modifiedDate);
        generationDisabled = true;

        // Read metadata from txt files
        templist = await indexTxtFiles(templist, txtmap);
    }

    // Read metadata from exif
    if (templist.length !== 0) {
        const originalLimit = backgroundTasks.limit;
        backgroundTasks.limit = 5;
        await indexExifFiles(templist);
        backgroundTasks.limit = originalLimit;
    }

    print('Building comfy prompt cache...');
    buildComfyPromptCache();
    updateLine(`Comfy prompt cache created with ${comfyPromptCache.size} items\n`);

    generationDisabled = false;

    // finish up
    print('Writing cache files...');
    saveUniqueList(uniqueReverse);
    serializeImageList([...imageList].map(x => x[1]), cache);
    updateLine(`Indexed ${imageList.size} images in ${calcTimeSpent(startTimestamp)}\n`);
    await renameLegacyFile();

    cleanTempImages();
    console.log(`Found ${[...imageList].filter(x => x[1].prompt).length} images with metadata`);
}

async function renameLegacyFile() {
    try {
        const cachefile = path.join(datapath, 'metadata.json');
        if ((await fs.stat(cachefile)).isFile()) {
            const newfile = path.join(datapath, 'metadata-deprecated-delete-this.json');
            await fs.rename(cachefile, newfile).catch(console.log);
            console.log('\nDELETE OLD METADATA JSON - old json file has been preserved just in case, you can delete it to save space\n');
        }
    } catch { undefined; }
}

function serializeImageList(images: ServerImage[], cache: ImageList | undefined) {
    const db = new MetaDB();
    if (!cache) {
        db.setAll(images);
        db.close();
        return;
    }

    const deletions: string[] = [];
    const additions: ServerImage[] = [];
    const updates: ServerImage[] = [];

    for (const image of images) {
        const cached = cache.get(image.id);
        if (!cached) {
            additions.push(image);
        } else {
            if (image.file !== cached.file
                || image.folder !== cached.folder
                || image.modifiedDate !== cached.modifiedDate
                || image.createdDate !== cached.createdDate
                || image.prompt != cached.prompt
                || image.workflow != cached.workflow) {
                updates.push(image);
            }
        }

        cache.delete(image.id);
    }

    for (const [key] of cache) {
        deletions.push(key);
    }

    db.setAndDeleteAll(additions.concat(updates), deletions);
    updateLine(`Updated ${additions.length + updates.length} images, deleted ${deletions.length} images in cache\n`);
    db.close();
}

async function indexCachedFiles(): Promise<[ServerImage[], Map<string, string>, ImageList | undefined]> {
    const db = new MetaDB();

    const cachefile = path.join(datapath, 'metadata.json');
    let imageCache: ImageList | undefined;
    const templist: ServerImage[] = [];
    const images: ImageList = new Map();
    const dirs: string[] = [IMG_FOLDER];
    const set = new Set<string>();
    const txtmap: Map<string, string> = new Map();
    let found = 0;
    let foundtxt = 0;
    let foundtxtnew = 0;
    let useLegacy = false;

    const dbCount = db.count();

    try {
        const cache = await fs.readFile(cachefile);
        imageCache = new Map(JSON.parse(cache.toString()));
        if (imageCache.size > dbCount) {
            useLegacy = true;
            console.log('Using legacy cache file instead of database');
        }
    } catch {
        imageCache = undefined;
    }

    if (!useLegacy) {
        const dbImages = db.getAll();
        imageCache = dbImages.size ? dbImages : undefined;
    }

    if (!imageCache) {
        console.log('No cache file, or failed to read it');
        console.log('Building index from scratch...');
    } else {
        console.log(`Found cache file with ${imageCache.size} images`);
    }

    while (dirs.length > 0) {
        const dir = dirs.pop();
        if (!dir) continue;
        const dirShort = removeBasePath(dir).replace(/^(\/|\\)/, '');
        const files = await fs.readdir(dir);

        for (const file of files.filter(x => isImage(x))) {
            found++;
            const fullpath = path.join(dir, file);
            const hash = hashString(fullpath);
            if (imageCache && imageCache.has(hash)) {
                images.set(hash, {
                    ...(imageCache.get(hash)!),
                    file: fullpath,
                });
                continue;
            }

            set.add(removeExtension(fullpath));

            templist.push({
                id: hash,
                folder: dirShort,
                file: fullpath,
                modifiedDate: 0,
                createdDate: 0,
            });
        }

        for (const file of files.filter(x => isTxt(x))) {
            foundtxt++;
            const fullpath = path.join(dir, file);
            const partial = removeExtension(fullpath);
            if (set.has(partial)) {
                foundtxtnew++;
                txtmap.set(partial, fullpath);
            }
        }

        for (const file of files.filter(x => !isImage(x) && !isTxt(x))) {
            const fullpath = path.join(dir, file);
            try {
                const stats = await fs.stat(fullpath);
                if (stats.isDirectory()) dirs.push(fullpath);
            } catch {
                // failed
            }
        }

        updateLine(`Searching ${found} images` + (foundtxt ? ` and ${foundtxt} txt files` : ''));
    }

    updateLine(`Found ${found - images.size} new images` + (foundtxt ? ` and ${foundtxtnew} txt files` : '') + '\n');

    if (imageCache) {
        const deletions = [...imageCache.keys()].filter(x => !images.has(x));
        deletions.forEach(x => imageCache.delete(x));
    }

    db.close();
    imageList = images;
    return [templist, txtmap, useLegacy ? undefined : imageCache];
}

async function indexBasicFileData(templist: ServerImage[]): Promise<ServerImage[]> {
    const log = `Reading dates for ${templist.length} images...`;
    print(log);
    let progress = 0;
    let count = 0;
    const startTimestamp = Date.now();
    const parallelBasicReads = 10;

    templist = await limitedParallelMap(templist, async x => {
        try {
            const stats = await fs.stat(x.file);
            x.modifiedDate = stats.mtimeMs;
            x.createdDate = stats.birthtimeMs;
            if (x.modifiedDate > 0) count++;
            return x;
        } catch {
            return x;
        } finally {
            progress++;
            if (progress % 1000 === 0) updateLine(log + ` ${(progress / templist.length * 100).toFixed(1)}%`);
        }
    }, parallelBasicReads);

    updateLine(`Found dates for ${count} images in ${calcTimeSpent(startTimestamp)}\n`);
    return templist;
}

async function indexTxtFiles(templist: ServerImage[], txtmap: Map<string, string>): Promise<ServerImage[]> {
    const log = `Indexing ${txtmap.size} images from txt files...`;
    updateLine(log);

    const startTimestamp = Date.now();
    let progress = 0;
    let found = 0;
    const newlist: ServerImage[] = [];

    for (const image of templist) {
        const partial = removeExtension(image.file);
        if (!txtmap.has(partial)) {
            newlist.push(image);
            continue;
        }

        backgroundTasks.addWork(async () => {
            const res = await readMetadataFromFile(image, txtmap.get(partial)!).catch(() => image);
            if (res.prompt || res.workflow) {
                imageList.set(res.id, res);
                addUniqueImage(res);
                found++;
            } else {
                newlist.push(res);
            }

            progress++;
            if (progress % 1000 === 0)
                updateLine(log + ` ${(progress / txtmap.size * 100).toFixed(1)}%`);
        });
    }

    while (progress < txtmap.size) {
        await sleep(100);
    }

    updateLine(`Found txt metadata for ${found} images in ${calcTimeSpent(startTimestamp)}\n`);
    return newlist;
}

async function indexExifFiles(templist: ServerImage[]): Promise<void> {
    const log = `Indexing ${templist.length} images from exif...`;
    updateLine(log);

    const startTimestamp = Date.now();
    let progress = 0;
    let found = 0;

    for (const image of templist) {
        backgroundTasks.addWork(async () => {
            const res = await readMetadataFromExif(image).catch(() => image);
            imageList.set(res.id, res);
            addUniqueImage(res);
            if (res.prompt || res.workflow)
                found++;
            progress++;
            if (progress % 1000 === 0)
                updateLine(log + ` ${(progress / templist.length * 100).toFixed(1)}%`);
        });
    }

    while (progress < templist.length) {
        await sleep(100);
    }

    updateLine(`Found exif metadata for ${found} images in ${calcTimeSpent(startTimestamp)}\n`);
}

async function readMetadataFromFile(image: ServerImage, file: string): Promise<ServerImage> {
    const text = await fs.readFile(file, 'utf8');
    image.prompt = text;
    return image;
}

async function readMetadataFromExif(image: ServerImage): Promise<ServerImage> {
    const metadata = await exifr.parse(image.file, {
        ifd0: false,
        chunked: false,
    } as any);
    if (!metadata)
        return image;
    image.prompt = metadata.parameters ?? metadata.prompt ?? undefined;
    image.workflow = metadata.workflow ?? undefined;

    if (image.prompt === undefined && image.workflow === undefined) {
        image.prompt = JSON.stringify(metadata);
    }

    return image;
}

function isImage(file: string) {
    return file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.webp');
}

function isTxt(file: string) {
    return txtFiletypes.some(x => file.endsWith(`.${x}`));
}

function removeExtension(file: string) {
    return file.replace(/\.[^\\/.]+$/, '');
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
    if (count)
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
    if (count)
        console.log(`Cleaned ${count} preview images`);
}

async function deleteTempImage(id: string) {
    const thumbfile = path.join(thumbnailPath, `${id}.webp`);
    const compfile = path.join(compressedPath, `${id}.webp`);
    await fs.unlink(thumbfile).catch(() => '');
    await fs.unlink(compfile).catch(() => '');
}

let indexTimer: any;

function setupWatcher() {
    const options: WatcherOptions = {
        recursive: true,
        ignoreInitial: true,
    };

    if (watcher) watcher.close();
    watcher = new Watcher(IMG_FOLDER, options);

    watcher.on('add', async file => {
        addFile(file);
    });

    watcher.on('rename', async (from, to) => {
        if (isImage(from)) {
            const oldhash = hashString(from);
            removeUniqueImage(imageList.get(oldhash));
            removeComfyPromptFromCache(oldhash);
            imageList.delete(oldhash);
            deleteTempImage(oldhash);
        }

        if (!isImage(to)) return;
        console.log(`Renamed ${from} to ${to}`);

        const newhash = hashString(to);
        const image: ServerImage = {
            id: newhash,
            folder: path.basename(path.dirname(to)),
            file: to,
            modifiedDate: 0,
            createdDate: 0,
            ...await readMetadata(to),
        };

        imageList.set(newhash, image);

        addUniqueImage(imageList.get(newhash)!);
        addComfyPromptToCache(image);
    });

    watcher.on('unlink', async file => {
        if (!isImage(file)) return;
        const hash = hashString(file);
        removeUniqueImage(imageList.get(hash));
        removeComfyPromptFromCache(hash);
        imageList.delete(hash);
        freshList = freshList.filter(x => x.id !== hash);
        const size = deletionList.unshift({
            id: hash,
            timestamp: Date.now(),
        });
        if (size > freshLimit) deletionList.pop();
        deleteTempImage(hash);
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
                removeUniqueImage(value);
                removeComfyPromptFromCache(key);
                imageList.delete(key);
                deleteTempImage(key);
            }
        }
    });

    if (pollingInterval > 0) {
        console.log(`Polling enabled with interval of ${pollingInterval / 1000} seconds`);
        pollFiles();
    }
    console.log('Listening to file changes...');
}

let genCount = 0;
const genLimit = 10;

async function addFile(file: string, hash?: string) {
    if (!isImage(file)) return;
    if (!hash)
        hash = hashString(file);
    try {
        if (genCount < genLimit) {
            genCount++;
            await generateCompressedFromId(hash, file);
            await generateThumbnailFromId(hash, file);
            genCount--;
        }
    } catch (e) {
        console.log(`Failed to generate preview for ${path.basename(file)} (this shouldn't appear)`);
        console.error(e);
    }

    console.log(`Added ${file}`);
    const image: ServerImage = {
        id: hash,
        folder: path.basename(path.dirname(file)),
        file,
        modifiedDate: 0,
        createdDate: 0,
        ...await readMetadata(file),
    };

    imageList.set(hash, image);

    const amount = freshList.unshift({
        id: hash,
        timestamp: Date.now(),
    });
    if (amount > freshLimit) freshList.pop();

    addUniqueImage(imageList.get(hash)!);
    addComfyPromptToCache(image);
}

async function pollFiles() {
    await checkFiles();
    setTimeout(() => {
        pollFiles();
    }, pollingInterval);
}

async function checkFiles() {
    const dirs: string[] = [IMG_FOLDER];

    while (dirs.length > 0) {
        const dir = dirs.pop();
        if (!dir) continue;
        const files = await fs.readdir(dir);

        for (const file of files.filter(x => isImage(x))) {
            const fullpath = path.join(dir, file);
            const hash = hashString(fullpath);
            if (imageList.has(hash)) {
                continue;
            }

            addFile(fullpath, hash);
        }

        for (const file of files.filter(x => !isImage(x) && !isTxt(x))) {
            const fullpath = path.join(dir, file);
            try {
                const stats = await fs.stat(fullpath);
                if (stats.isDirectory()) dirs.push(fullpath);
            } catch {
                // failed
            }
        }
    }
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
        list = list.filter(x => isUnique(x.id));
    }

    return list;
}

export function simplifyPrompt(prompt: string | undefined, location?: string) {
    if (prompt === undefined) return '';
    return prompt
        .replace(/(, )?seed: \d+/i, '')
        .replace(/(, )?([^,]*)version: [^,]*/ig, '')
        + (location ?? '');
}

function isUnique(id: string) {
    return uniqueSet.has(id);
}

async function createUniqueListChunked(cache: ImageList | undefined) {
    const [cachedList, cachedReverse] = loadUniqueList(cache);

    if (cachedList.size && cachedList.size === cachedReverse.size) {
        uniqueSet = cachedList;
        uniqueReverse = cachedReverse;
        return;
    }

    uniqueSet = new Set();
    uniqueReverse = new Map();

    const chunksize = 1000;
    const templist = [...imageList.values()];
    for (let i = 0; i < templist.length; i += chunksize) {
        const chunk = templist.slice(i, i + chunksize);
        for (const image of chunk) {
            if (!image.prompt)
                continue;
            const prompt = simplifyPrompt(image.prompt, image.folder);
            uniqueReverse.set(prompt, image.id);
        }
        await sleep(1);
    }

    for (const id of [...uniqueReverse.values()]) {
        uniqueSet.add(id);
    }
}

function addUniqueImage(image: ServerImage) {
    const prompt = simplifyPrompt(image.prompt, image.folder);
    const existing = uniqueReverse.get(prompt);
    if (existing)
        uniqueSet.delete(existing);
    uniqueSet.add(image.id);
    uniqueReverse.set(prompt, image.id);
}

let uniqueTimeout: NodeJS.Timeout | undefined;
function removeUniqueImage(image: ServerImage | undefined) {
    if (!image) return;
    const id = image.id;
    const prompt = simplifyPrompt(image.prompt, image.folder);

    if (prompt) {
        uniqueReverse.delete(prompt);
        uniqueSet.delete(id);

        if (uniqueSet.size !== uniqueReverse.size) {
            printLine('uniqueSet and uniqueReverse are out of sync');
            clearTimeout(uniqueTimeout);
            uniqueTimeout = setTimeout(() => {
                print('Attempting to rebuild unique list...');
                createUniqueListChunked(undefined);
                updateLine('Unique list rebuilt');
                saveUniqueList(uniqueReverse);
                updateLine('Unique list saved to cache\n');
            }, 5000);
        }
    }
}

function buildComfyPromptCache() {
    for (const image of imageList.values()) {
        addComfyPromptToCache(image);
    }
}

function addComfyPromptToCache(image: ServerImage) {
    const prompts = getComfyPrompts(image.prompt, image.workflow);
    if (!prompts)
        return;
    comfyPromptCache.set(image.id, [prompts.pos, prompts.neg]);
}

function removeComfyPromptFromCache(id: string) {
    comfyPromptCache.delete(id);
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

function getTextByType(image: ServerImage, type: MatchType): string {
    if (!image) return '';

    switch (type) {
        case 'all':
            return `${image.prompt}, Folder: ${image.folder}`;
        case 'folder':
            return image.folder;
    }

    if (comfyPromptCache.has(image.id)) {
        // assume comfy metadata
        const [positive, negative] = comfyPromptCache.get(image.id)!;
        switch (type) {
            case 'positive':
                return positive;
            case 'negative':
                return negative;
            case 'params':
                return image.prompt!;
        }
    } else if (getMetadataVersion(image.prompt) === 'swarm') {
        // assume swarm metadata
        const prompts = getSwarmPrompts(image.prompt);
        switch (type) {
            case 'positive':
                return prompts?.pos || image.prompt || '';
            case 'negative':
                return prompts?.neg || '';
            case 'params':
                return getParams(image.prompt);
            default:
                return '';
        }
    } else {
        // assume automatic1111 metadata
        switch (type) {
            case 'positive':
                return getPositivePrompt(image.prompt) || image.prompt || '';
            case 'negative':
                return getNegativePrompt(image.prompt);
            case 'params':
                return getParams(image.prompt);
            default:
                return '';
        }
    }
}

export function sortImages(images: ServerImage[], sort: SortingMethod): ServerImage[] {
    if (images.length === 0) return images;
    switch (sort) {
        case 'date':
            return [...images].sort(createComparer<ServerImage>(x => x.modifiedDate, true));
        case 'date (asc)':
            return [...images].sort(createComparer<ServerImage>(x => x.modifiedDate, false));
        case 'name':
            return [...images].sort(createComparer<ServerImage>(x => x.file, true));
        case 'name (desc)':
            return [...images].sort(createComparer<ServerImage>(x => x.file, false));
        case 'random':
            return selectRandom(images, images.length);
        default:
            return [];
    }
}

export function getFreshImages(timestamp: number) {
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
    hash.update(removeBasePath(filepath));
    return hash.digest('hex');
}

function removeBasePath(filepath: string) {
    filepath = filepath.replace(/(\/|\\)+$/, '');
    return filepath.replace(IMG_FOLDER, '');
}

async function readMetadata(imagepath: string): Promise<Partial<ServerImage>> {
    try {
        const stats = await fs.stat(imagepath);
        const res: Partial<ServerImage> = {
            modifiedDate: stats.mtimeMs,
            createdDate: stats.birthtimeMs,
        };

        const filetypes = ['.txt', '.yaml', '.yml', '.json'];
        for (const filetype of filetypes) {
            const textfile = imagepath.replace(/\.(png|jpg|jpeg|webp)$/i, filetype);
            if (await fs.stat(textfile).then(x => x.isFile()).catch(() => false)) {
                const text = await fs.readFile(textfile, 'utf8');
                res.prompt = text;
                return res;
            }
        }

        let metadata = await exifr.parse(imagepath, {
            ifd0: false,
            chunked: false,
        } as any);
        if (!metadata)
            return {};
        metadata = {
            ...res,
            prompt: metadata.parameters ?? metadata.prompt ?? undefined,
            workflow: metadata.workflow ?? undefined,
        } satisfies Partial<ServerImage>;

        if (metadata.prompt === undefined && metadata.workflow === undefined) {
            metadata.prompt = JSON.stringify(metadata);
        }

        return metadata;
    } catch {
        console.log(`Failed to read metadata for ${imagepath}`);
        return {};
    }
}

export function markNsfw(ids: string | string[], nsfw: boolean) {
    if (typeof ids === 'string') ids = [ids];

    for (const id of ids) {
        const index = nsfwList.indexOf(id);
        if (nsfw && index === -1) {
            nsfwList.push(id);
        } else if (!nsfw && index !== -1) {
            nsfwList.splice(index, 1);
        }
    }
}

export function markFavorite(ids: string | string[], favorite: boolean) {
    if (typeof ids === 'string') ids = [ids];

    for (const id of ids) {
        const index = favoriteList.indexOf(id);
        if (favorite && index === -1) {
            favoriteList.push(id);
        } else if (!favorite && index !== -1) {
            favoriteList.splice(index, 1);
        }
    }
}

export function deleteImages(ids: string | string[]) {
    if (typeof ids === 'string') ids = [ids];

    let failcount = 0;
    for (const id of ids) {
        const img = imageList.get(id);
        if (!img) return;
        try {
            fs.unlink(img.file);
            removeUniqueImage(img);
            imageList.delete(id);
            deleteTextFiles(img.file);
            deleteTempImage(id);
        } catch {
            failcount++;
        }
    }

    if (failcount > 0)
        console.log(`Failed to delete ${failcount} images`);
}

async function deleteTextFiles(imagepath: string) {
    const filetypes = ['.txt', '.yaml', '.yml', '.json'];
    for (const filetype of filetypes) {
        const textfile = imagepath.replace(/\.(png|jpg|jpeg|webp)$/i, filetype);
        fs.unlink(textfile).catch(() => '');
    }
}

export function openExplorer(id: string) {
    const filepath = imageList.get(id)?.file;
    if (!filepath) return;
    let folderpath = path.dirname(filepath);
    let cmd = '';
    switch (os.platform().toLowerCase().replace(/[0-9]/g, '').replace('darwin', 'macos')) {
        case 'win':
            folderpath = folderpath || '=';
            cmd = 'explorer';
            break;
        case 'linux':
            folderpath = folderpath || '/';
            cmd = 'xdg-open';
            break;
        case 'macos':
            folderpath = folderpath || '/';
            cmd = 'open';
            break;
    }
    const args = [];
    if (cmd === 'explorer') {
        args.push(`/select,`);
        args.push(filepath);
    } else {
        args.push(folderpath);
    }
    console.log(`Opening folder with args ${args.join(' ')}`);
    const p = cp.spawn(cmd, args);
    p.on('error', () => {
        p.kill();
    });
}
