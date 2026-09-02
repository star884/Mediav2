'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

const CACHE_TTL_MS = Number(
    process.env.CACHE_TTL_MS || 30 * 60 * 1000
);

const SEARCH_TIMEOUT_MS = Number(
    process.env.SEARCH_TIMEOUT_MS || 10000
);

const MAX_RESULTS_PER_PROVIDER = Number(
    process.env.MAX_RESULTS_PER_PROVIDER || 30
);

const ALLOWED_ORIGINS = (
    process.env.ALLOWED_ORIGINS || '*'
)
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true });

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

app.use(
    cors({
        origin(origin, callback) {
            if (!origin || ALLOWED_ORIGINS.includes('*')) {
                return callback(null, true);
            }

            if (ALLOWED_ORIGINS.includes(origin)) {
                return callback(null, true);
            }

            callback(new Error('CORS origin not allowed'));
        }
    })
);

app.use(
    express.static(
        path.join(__dirname, 'public'),
        {
            extensions: ['html']
        }
    )
);

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

let cache = {
    version: 1,
    library: [],
    entries: {},
    updatedAt: null
};

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) {
            return;
        }

        const parsed = JSON.parse(
            fs.readFileSync(CACHE_FILE, 'utf8')
        );

        if (parsed && typeof parsed === 'object') {
            cache = {
                version: 1,
                library: Array.isArray(parsed.library)
                    ? parsed.library
                    : [],
                entries: parsed.entries &&
                    typeof parsed.entries === 'object'
                    ? parsed.entries
                    : {},
                updatedAt: parsed.updatedAt || null
            };
        }
    } catch (error) {
        console.error(
            '[Storage] Failed to load cache:',
            error.message
        );
    }
}

function saveCache() {
    try {
        const temporary = `${CACHE_FILE}.tmp`;

        fs.writeFileSync(
            temporary,
            JSON.stringify(cache, null, 2),
            'utf8'
        );

        fs.renameSync(
            temporary,
            CACHE_FILE
        );
    } catch (error) {
        console.error(
            '[Storage] Failed to save cache:',
            error.message
        );
    }
}

loadCache();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function makeHash(value) {
    return crypto
        .createHash('sha1')
        .update(String(value))
        .digest('hex');
}

function makeStableId(providerId, value) {
    return `${providerId}:${makeHash(value)}`;
}

function safeUrl(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    try {
        const parsed = new URL(value);

        if (
            parsed.protocol !== 'https:' &&
            parsed.protocol !== 'http:'
        ) {
            return null;
        }

        return parsed.toString();
    } catch {
        return null;
    }
}

function cleanString(value) {
    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    const text = String(value).trim();

    return text || null;
}

function normalizeType(value) {
    const type = normalizeText(value);

    if (
        type === 'movie' ||
        type === 'movies'
    ) {
        return 'movie';
    }

    if (
        type === 'series' ||
        type === 'tv series' ||
        type === 'tv'
    ) {
        return 'series';
    }

    if (
        type === 'anime'
    ) {
        return 'anime';
    }

    return 'other';
}

function normalizeItem(provider, item) {
    const title = cleanString(item.title);

    if (!title) {
        return null;
    }

    const sourceId =
        cleanString(item.sourceId) ||
        cleanString(item.id) ||
        cleanString(item.url) ||
        title;

    const providerId = provider.id;

    return {
        id: makeStableId(
            providerId,
            sourceId
        ),

        providerId,

        provider: provider.name,

        sourceId,

        title,

        normalizedTitle: normalizeText(title),

        type: normalizeType(item.type),

        year:
            Number.isInteger(Number(item.year))
                ? Number(item.year)
                : null,

        poster:
            safeUrl(item.poster) ||
            null,

        backdrop:
            safeUrl(item.backdrop) ||
            null,

        description:
            cleanString(item.description) ||
            '',

        genres:
            Array.isArray(item.genres)
                ? item.genres
                    .map(cleanString)
                    .filter(Boolean)
                : [],

        url:
            safeUrl(item.url) ||
            null,

        streams:
            Array.isArray(item.streams)
                ? item.streams
                : [],

        season:
            item.season == null
                ? null
                : Number(item.season),

        episode:
            item.episode == null
                ? null
                : Number(item.episode),

        updatedAt:
            new Date().toISOString()
    };
}

function deduplicate(items) {
    const groups = new Map();

    for (const item of items) {
        const key = [
            item.normalizedTitle,
            item.year || '',
            item.type
        ].join('|');

        if (!groups.has(key)) {
            groups.set(key, {
                ...item,
                providers: [
                    {
                        id: item.providerId,
                        name: item.provider
                    }
                ],
                providerItems: [item]
            });

            continue;
        }

        const existing = groups.get(key);

        if (
            !existing.poster &&
            item.poster
        ) {
            existing.poster = item.poster;
        }

        if (
            !existing.backdrop &&
            item.backdrop
        ) {
            existing.backdrop = item.backdrop;
        }

        if (
            (!existing.description ||
                existing.description.length < item.description.length) &&
            item.description
        ) {
            existing.description =
                item.description;
        }

        if (item.url) {
            existing.providerItems.push(item);
        }

        if (
            !existing.providers.some(
                p => p.id === item.providerId
            )
        ) {
            existing.providers.push({
                id: item.providerId,
                name: item.provider
            });
        }
    }

    return Array.from(groups.values());
}

function paginate(items, page, limit) {
    const safePage =
        Math.max(1, Number(page) || 1);

    const safeLimit =
        Math.min(
            100,
            Math.max(1, Number(limit) || 30)
        );

    const start =
        (safePage - 1) * safeLimit;

    return {
        page: safePage,
        limit: safeLimit,
        total: items.length,
        pages: Math.ceil(
            items.length / safeLimit
        ),
        items: items.slice(
            start,
            start + safeLimit
        )
    };
}

/* -------------------------------------------------------------------------- */
/* Provider system                                                              */
/* -------------------------------------------------------------------------- */

class Provider {
    constructor({
        id,
        name,
        version = '1.0.0',
        types = []
    }) {
        this.id = id;
        this.name = name;
        this.version = version;
        this.types = types;
    }

    metadata() {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            types: this.types,
            enabled: true
        };
    }

    async home() {
        return [];
    }

    async search() {
        return [];
    }

    async load() {
        return null;
    }

    async streams() {
        return [];
    }
}

/* -------------------------------------------------------------------------- */
/* Internet Archive provider                                                   */
/* -------------------------------------------------------------------------- */

class InternetArchiveProvider extends Provider {
    constructor() {
        super({
            id: 'internet-archive',
            name: 'Internet Archive',
            version: '1.0.0',
            types: [
                'movie',
                'series',
                'other'
            ]
        });

        this.api =
            'https://archive.org/advancedsearch.php';
    }

    async request(params) {
        const response = await axios.get(
            this.api,
            {
                params: {
                    output: 'json',
                    rows: MAX_RESULTS_PER_PROVIDER,
                    page: 1,
                    ...params
                },
                timeout: SEARCH_TIMEOUT_MS,
                headers: {
                    'User-Agent':
                        'Mediav2/2.0'
                }
            }
        );

        return response.data;
    }

    async search(query, type) {
        const q =
            String(query || '').trim();

        if (!q) {
            return [];
        }

        let collectionFilter = '';

        if (type === 'movie') {
            collectionFilter =
                ' AND mediatype:movies';
        }

        const data =
            await this.request({
                q:
                    `title:(${q})${collectionFilter}`,
                fl: [
                    'identifier',
                    'title',
                    'description',
                    'year',
                    'date',
                    'mediatype',
                    'subject'
                ].join(','),
                sort: 'downloads desc'
            });

        const docs =
            data?.response?.docs || [];

        return docs.map(doc => ({
            id:
                doc.identifier,

            sourceId:
                doc.identifier,

            title:
                doc.title ||
                doc.identifier,

            type:
                doc.mediatype === 'movies'
                    ? 'movie'
                    : 'other',

            year:
                Number(
                    doc.year ||
                    String(doc.date || '')
                        .slice(0, 4)
                ) || null,

            description:
                Array.isArray(doc.description)
                    ? doc.description[0]
                    : doc.description || '',

            genres:
                Array.isArray(doc.subject)
                    ? doc.subject.slice(0, 10)
                    : [],

            url:
                `https://archive.org/details/${encodeURIComponent(
                    doc.identifier
                )}`,

            poster:
                `https://archive.org/services/img/${encodeURIComponent(
                    doc.identifier
                )}`
        }));
    }

    async load(sourceId) {
        if (!sourceId) {
            return null;
        }

        const identifier =
            encodeURIComponent(sourceId);

        const metadataUrl =
            `https://archive.org/metadata/${identifier}`;

        const response =
            await axios.get(
                metadataUrl,
                {
                    timeout: SEARCH_TIMEOUT_MS,
                    headers: {
                        'User-Agent':
                            'Mediav2/2.0'
                    }
                }
            );

        const data = response.data;

        if (!data) {
            return null;
        }

        const metadata =
            data.metadata || {};

        const files =
            Array.isArray(data.files)
                ? data.files
                : [];

        const streams =
            files
                .filter(file => {
                    const name =
                        String(
                            file.name || ''
                        ).toLowerCase();

                    return (
                        name.endsWith('.mp4') ||
                        name.endsWith('.webm') ||
                        name.endsWith('.m3u8')
                    );
                })
                .map(file => {
                    const name =
                        String(file.name);

                    const url =
                        `https://archive.org/download/${encodeURIComponent(
                            sourceId
                        )}/${name
                            .split('/')
                            .map(encodeURIComponent)
                            .join('/')}`;

                    const lower =
                        name.toLowerCase();

                    let format =
                        'unknown';

                    if (
                        lower.endsWith('.mp4')
                    ) {
                        format = 'mp4';
                    } else if (
                        lower.endsWith('.webm')
                    ) {
                        format = 'webm';
                    } else if (
                        lower.endsWith('.m3u8')
                    ) {
                        format = 'hls';
                    }

                    return {
                        id:
                            makeHash(url),

                        name,

                        url,

                        format,

                        quality:
                            file.height
                                ? `${file.height}p`
                                : null,

                        width:
                            Number(file.width) ||
                            null,

                        height:
                            Number(file.height) ||
                            null,

                        size:
                            Number(file.size) ||
                            null
                    };
                });

        return {
            sourceId,

            title:
                metadata.title ||
                sourceId,

            type:
                normalizeType(
                    metadata.mediatype
                ),

            year:
                Number(
                    metadata.year ||
                    String(
                        metadata.date || ''
                    ).slice(0, 4)
                ) || null,

            description:
                metadata.description || '',

            poster:
                `https://archive.org/services/img/${identifier}`,

            url:
                `https://archive.org/details/${identifier}`,

            streams
        };
    }

    async streams(sourceId) {
        const loaded =
            await this.load(sourceId);

        return loaded?.streams || [];
    }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const providers = new Map();

function registerProvider(provider) {
    if (!(provider instanceof Provider)) {
        throw new Error(
            'Invalid provider'
        );
    }

    providers.set(
        provider.id,
        provider
    );
}

registerProvider(
    new InternetArchiveProvider()
);

/* -------------------------------------------------------------------------- */
/* Provider operations                                                         */
/* -------------------------------------------------------------------------- */

async function providerSearch(
    provider,
    query,
    type
) {
    const started =
        Date.now();

    try {
        const results =
            await provider.search(
                query,
                type
            );

        const normalized =
            results
                .map(item =>
                    normalizeItem(
                        provider,
                        item
                    )
                )
                .filter(Boolean);

        return {
            provider,
            results: normalized,
            elapsed:
                Date.now() - started,
            error: null
        };
    } catch (error) {
        return {
            provider,
            results: [],
            elapsed:
                Date.now() - started,
            error: error.message
        };
    }
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

async function globalSearch(
    query,
    type
) {
    const normalizedQuery =
        normalizeText(query);

    if (!normalizedQuery) {
        return [];
    }

    const activeProviders =
        Array.from(
            providers.values()
        );

    const results =
        await Promise.all(
            activeProviders.map(
                provider =>
                    providerSearch(
                        provider,
                        query,
                        type
                    )
            )
        );

    const all =
        results.flatMap(
            result => result.results
        );

    const merged =
        deduplicate(all);

    cache.library =
        merged;

    cache.updatedAt =
        new Date().toISOString();

    saveCache();

    return merged;
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'Mediav2',
        version: '2.0.0',
        providers:
            providers.size,
        library:
            cache.library.length,
        updatedAt:
            cache.updatedAt
    });
});

app.get('/api/providers', (req, res) => {
    res.json({
        providers:
            Array.from(
                providers.values()
            ).map(
                provider =>
                    provider.metadata()
            )
    });
});

app.get('/api/library', (req, res) => {
    const {
        search = '',
        type = 'all',
        provider = 'all',
        page = 1,
        limit = 30
    } = req.query;

    let items =
        Array.isArray(cache.library)
            ? cache.library
            : [];

    if (search) {
        const q =
            normalizeText(search);

        items =
            items.filter(item =>
                item.normalizedTitle
                    .includes(q)
            );
    }

    if (
        type &&
        type !== 'all'
    ) {
        items =
            items.filter(
                item =>
                    item.type ===
                    normalizeType(type)
            );
    }

    if (
        provider &&
        provider !== 'all'
    ) {
        items =
            items.filter(item =>
                item.providers?.some(
                    p =>
                        p.id === provider
                )
            );
    }

    res.json(
        paginate(
            items,
            page,
            limit
        )
    );
});

app.get('/api/search', async (req, res) => {
    const {
        q,
        type = 'all',
        page = 1,
        limit = 30
    } = req.query;

    if (
        !q ||
        String(q).trim().length < 2
    ) {
        return res.status(400).json({
            error:
                'Search query must contain at least 2 characters'
        });
    }

    const started =
        Date.now();

    const items =
        await globalSearch(
            String(q),
            type === 'all'
                ? null
                : type
        );

    res.json({
        query: String(q),
        elapsed:
            Date.now() - started,
        ...paginate(
            items,
            page,
            limit
        )
    });
});

app.get('/api/title/:id', async (req, res) => {
    const encoded =
        req.params.id;

    let decoded;

    try {
        decoded =
            decodeURIComponent(encoded);
    } catch {
        return res.status(400).json({
            error: 'Invalid title id'
        });
    }

    const separator =
        decoded.indexOf(':');

    if (separator === -1) {
        return res.status(400).json({
            error:
                'Invalid provider title id'
        });
    }

    const providerId =
        decoded.slice(
            0,
            separator
        );

    const sourceId =
        decoded.slice(
            separator + 1
        );

    const provider =
        providers.get(providerId);

    if (!provider) {
        return res.status(404).json({
            error:
                'Provider not found'
        });
    }

    try {
        const item =
            await provider.load(
                sourceId
            );

        if (!item) {
            return res.status(404).json({
                error:
                    'Title not found'
            });
        }

        const normalized =
            normalizeItem(
                provider,
                item
            );

        res.json({
            item: normalized
        });
    } catch (error) {
        console.error(
            '[Title]',
            error.message
        );

        res.status(502).json({
            error:
                'Provider failed to load title'
        });
    }
});

app.get('/api/sources/:id', async (req, res) => {
    const encoded =
        req.params.id;

    let decoded;

    try {
        decoded =
            decodeURIComponent(encoded);
    } catch {
        return res.status(400).json({
            error:
                'Invalid source id'
        });
    }

    const separator =
        decoded.indexOf(':');

    if (separator === -1) {
        return res.status(400).json({
            error:
                'Invalid source id'
        });
    }

    const providerId =
        decoded.slice(
            0,
            separator
        );

    const sourceId =
        decoded.slice(
            separator + 1
        );

    const provider =
        providers.get(providerId);

    if (!provider) {
        return res.status(404).json({
            error:
                'Provider not found'
        });
    }

    try {
        const streams =
            await provider.streams(
                sourceId
            );

        res.json({
            provider:
                provider.metadata(),

            sources:
                streams
                    .filter(
                        stream =>
                            safeUrl(
                                stream.url
                            )
                    )
            });
    } catch (error) {
        console.error(
            '[Sources]',
            error.message
        );

        res.status(502).json({
            error:
                'Provider failed to resolve streams'
        });
    }
});

app.post('/api/sync', async (req, res) => {
    const {
        query = ''
    } = req.body || {};

    if (
        String(query).trim().length < 2
    ) {
        return res.status(400).json({
            error:
                'Sync requires a search query of at least 2 characters'
        });
    }

    try {
        const items =
            await globalSearch(
                String(query),
                null
            );

        res.json({
            ok: true,
            count: items.length,
            updatedAt:
                cache.updatedAt
        });
    } catch (error) {
        res.status(500).json({
            error:
                error.message
        });
    }
});

/* -------------------------------------------------------------------------- */
/* 404                                                                         */
/* -------------------------------------------------------------------------- */

app.use('/api', (req, res) => {
    res.status(404).json({
        error: 'API endpoint not found'
    });
});

/* -------------------------------------------------------------------------- */
/* Frontend fallback                                                           */
/* -------------------------------------------------------------------------- */

app.get('*', (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            'public',
            'index.html'
        )
    );
});

/* -------------------------------------------------------------------------- */
/* Background maintenance                                                      */
/* -------------------------------------------------------------------------- */

setInterval(
    () => {
        if (
            cache.updatedAt &&
            Date.now() -
                new Date(
                    cache.updatedAt
                ).getTime() >
                CACHE_TTL_MS
        ) {
            console.log(
                '[Cache] Library cache is stale; retaining it until a new search is requested.'
            );
        }
    },
    5 * 60 * 1000
);

/* -------------------------------------------------------------------------- */
/* Start                                                                       */
/* -------------------------------------------------------------------------- */

app.listen(
    PORT,
    HOST,
    () => {
        console.log(
            `Mediav2 running on ${HOST}:${PORT}`
        );

        console.log(
            `Registered providers: ${providers.size}`
        );

        for (
            const provider
            of providers.values()
        ) {
            console.log(
                ` - ${provider.id} (${provider.version})`
            );
        }
    }
);
