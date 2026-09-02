const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

const PORT =
  Number(process.env.PORT) > 0
    ? Number(process.env.PORT)
    : 3000;

const DATA_DIR = path.resolve(
  process.env.DATA_DIR ||
    path.join(__dirname, 'data')
);

const LIBRARY_FILE = path.resolve(
  process.env.LIBRARY_CACHE_FILE ||
    path.join(DATA_DIR, 'cache.json')
);

const EXTENSIONS_FILE = path.resolve(
  process.env.EXTENSION_CACHE_FILE ||
    path.join(DATA_DIR, 'extensions.json')
);

const REQUEST_TIMEOUT =
  Number(process.env.REQUEST_TIMEOUT_MS) > 0
    ? Number(process.env.REQUEST_TIMEOUT_MS)
    : 20000;

const BRIDGE_TIMEOUT =
  Number(process.env.CLOUDSTREAM_BRIDGE_TIMEOUT) > 0
    ? Number(process.env.CLOUDSTREAM_BRIDGE_TIMEOUT)
    : 120000;

const SEARCH_LIMIT = Math.min(
  Math.max(
    Number(process.env.SEARCH_LIMIT) || 100,
    1
  ),
  200
);

const PROVIDER_LIMIT = Math.min(
  Math.max(
    Number(process.env.SEARCH_PROVIDER_LIMIT) || 30,
    1
  ),
  100
);

const MAX_LIBRARY = Math.max(
  Number(process.env.LIBRARY_MAX_ITEMS) || 5000,
  100
);

function text(value, fallback = '') {
  return typeof value === 'string'
    ? value.trim()
    : fallback;
}

function now() {
  return new Date().toISOString();
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex')
    .slice(0, 24);
}

function normalizeName(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeUrl(value, base) {
  if (
    typeof value !== 'string' ||
    !value.trim()
  ) {
    return null;
  }

  try {
    const url = new URL(
      value.trim(),
      base
    );

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const url = normalizeUrl(value);

  return url
    ? url.replace(/\/+$/, '')
    : '';
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (
    const item of Array.isArray(items)
      ? items
      : []
  ) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, 'utf8')
    );
  } catch (error) {
    console.error(
      `[storage] ${file}: ${error.message}`
    );

    return fallback;
  }
}

let writeQueue = Promise.resolve();

function queueWrite(file, value) {
  writeQueue = writeQueue
    .then(() => {
      const temporary =
        `${file}.${process.pid}.${Date.now()}.tmp`;

      fs.writeFileSync(
        temporary,
        JSON.stringify(value, null, 2),
        'utf8'
      );

      fs.renameSync(
        temporary,
        file
      );
    })
    .catch(error => {
      console.error(
        `[storage] ${error.message}`
      );
    });

  return writeQueue;
}

function mimeFor(format) {
  switch (
    text(format).toLowerCase()
  ) {
    case 'mp4':
      return 'video/mp4';

    case 'webm':
      return 'video/webm';

    case 'm3u8':
    case 'hls':
      return 'application/vnd.apple.mpegurl';

    case 'mpd':
    case 'dash':
      return 'application/dash+xml';

    default:
      return null;
  }
}

function quality(value) {
  const match = text(value).match(
    /(?:^|[._\-\s])(2160|1440|1080|720|576|480|360)p?(?:[._\-\s]|$)/i
  );

  return match
    ? `${match[1]}p`
    : 'Unknown';
}

async function fetchJson(
  url,
  {
    method = 'GET',
    body,
    headers = {},
    timeout = REQUEST_TIMEOUT
  } = {}
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const requestHeaders = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...headers
    };

    const options = {
      method,
      headers: requestHeaders,
      signal: controller.signal
    };

    if (body !== undefined) {
      options.body =
        JSON.stringify(body);

      requestHeaders[
        'Content-Type'
      ] = 'application/json';
    }

    const response =
      await fetch(url, options);

    const bodyText =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}` +
        (
          bodyText
            ? `: ${bodyText.slice(0, 300)}`
            : ''
        )
      );
    }

    if (!bodyText.trim()) {
      return {};
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(
        `Expected JSON from ${url}`
      );
    }
  } catch (error) {
    if (
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Request timed out after ${timeout}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeItem(item = {}) {
  const providerId = text(
    item.providerId,
    text(item.provider, 'unknown')
  );

  const providerName = text(
    item.providerName,
    text(item.provider, providerId)
  );

  const sourceId = text(
    item.sourceId,
    text(item.id)
  );

  const title = text(
    item.title,
    text(item.name, 'Untitled')
  );

  return {
    ...item,

    id:
      text(item.id) ||
      hash(
        `${providerId}:${sourceId}:${title}`
      ),

    providerId,
    providerName,
    sourceId,

    sourceUrl: normalizeUrl(
      item.sourceUrl ||
      item.url ||
      item.link
    ),

    title,

    originalTitle:
      text(
        item.originalTitle,
        title
      ),

    type:
      text(
        item.type,
        'unknown'
      ).toLowerCase(),

    year:
      Number.isFinite(
        Number(item.year)
      )
        ? Number(item.year)
        : null,

    poster: normalizeUrl(
      item.poster ||
      item.posterUrl ||
      item.image
    ),

    backdrop: normalizeUrl(
      item.backdrop ||
      item.backdropUrl
    ),

    description:
      text(
        item.description ||
        item.plot
      ),

    episodes:
      Array.isArray(item.episodes)
        ? item.episodes
        : [],

    seasons:
      Array.isArray(item.seasons)
        ? item.seasons
        : [],

    sources:
      Array.isArray(item.sources)
        ? item.sources
        : [],

    metadata:
      item.metadata &&
      typeof item.metadata === 'object'
        ? item.metadata
        : {},

    raw:
      item.raw &&
      typeof item.raw === 'object'
        ? item.raw
        : null
  };
}

let library =
  readJson(
    LIBRARY_FILE,
    []
  );

if (!Array.isArray(library)) {
  library = [];
}

function libraryKey(item) {
  return (
    `${normalizeName(item.providerId)}:` +
    `${text(
      item.sourceId,
      text(item.id)
    )}`
  );
}

function mergeIntoLibrary(items) {
  const map = new Map(
    library.map(item => [
      libraryKey(item),
      item
    ])
  );

  for (
    const item of (
      Array.isArray(items)
        ? items
        : []
    )
      .map(normalizeItem)
      .filter(
        item =>
          item.title !== 'Untitled'
      )
  ) {
    const key =
      libraryKey(item);

    const old =
      map.get(key);

    map.set(
      key,
      old
        ? {
            ...old,
            ...item,

            sourceUrl:
              item.sourceUrl ||
              old.sourceUrl ||
              null,

            poster:
              item.poster ||
              old.poster ||
              null,

            backdrop:
              item.backdrop ||
              old.backdrop ||
              null,

            description:
              item.description ||
              old.description ||
              '',

            data:
              item.data ||
              old.data ||
              null,

            episodes:
              item.episodes.length
                ? item.episodes
                : old.episodes || [],

            seasons:
              item.seasons.length
                ? item.seasons
                : old.seasons || [],

            sources:
              item.sources.length
                ? item.sources
                : old.sources || [],

            metadata: {
              ...(old.metadata || {}),
              ...(item.metadata || {})
            }
          }
        : item
    );
  }

  library = [
    ...map.values()
  ].slice(-MAX_LIBRARY);

  void queueWrite(
    LIBRARY_FILE,
    library
  );
}

const nativeProviders =
  new Map();

function archiveItem(data) {
  const id =
    text(data?.identifier);

  if (!id) {
    return null;
  }

  return normalizeItem({
    id,
    sourceId: id,
    providerId:
      'internet-archive',
    providerName:
      'Internet Archive',

    title:
      text(
        data.title,
        id
      ),

    description:
      data.description,

    year:
      data.year,

    type:
      'movie',

    sourceUrl:
      `https://archive.org/details/${encodeURIComponent(id)}`
  });
}

const InternetArchive = {
  id:
    'internet-archive',

  name:
    'Internet Archive',

  type:
    'public-media',

  async search(
    query,
    { limit = 40 } = {}
  ) {
    if (!text(query)) {
      return [];
    }

    const params =
      new URLSearchParams({
        q:
          `title:(${query}) AND mediatype:movies`,

        fl:
          'identifier,title,description,year,date',

        rows:
          String(
            Math.min(
              limit,
              100
            )
          ),

        output:
          'json'
      });

    const data =
      await fetchJson(
        `https://archive.org/advancedsearch.php?${params}`
      );

    return (
      data?.response?.docs ||
      []
    )
      .map(archiveItem)
      .filter(Boolean);
  },

  async home(
    { limit = 40 } = {}
  ) {
    const params =
      new URLSearchParams({
        q:
          'mediatype:movies',

        fl:
          'identifier,title,description,year,date',

        rows:
          String(
            Math.min(
              limit,
              100
            )
          ),

        output:
          'json',

        sort:
          'downloads desc'
      });

    const data =
      await fetchJson(
        `https://archive.org/advancedsearch.php?${params}`
      );

    return (
      data?.response?.docs ||
      []
    )
      .map(archiveItem)
      .filter(Boolean);
  },

  async load(item) {
    const id =
      text(
        item.sourceId,
        item.id
      );

    const data =
      await fetchJson(
        `https://archive.org/metadata/${encodeURIComponent(id)}`
      );

    const sources =
      (data?.files || [])
        .map(file => {
          const name =
            text(file?.name);

          if (!name) {
            return null;
          }

          const lower =
            name.toLowerCase();

          let format = '';

          if (
            lower.endsWith(
              '.m3u8'
            )
          ) {
            format = 'hls';
          } else if (
            lower.endsWith(
              '.mp4'
            )
          ) {
            format = 'mp4';
          } else if (
            lower.endsWith(
              '.webm'
            )
          ) {
            format = 'webm';
          }

          if (!format) {
            return null;
          }

          const encoded =
            name
              .split('/')
              .map(
                encodeURIComponent
              )
              .join('/');

          return {
            id:
              hash(
                `${id}:${name}`
              ),

            name,

            url:
              `https://archive.org/download/${encodeURIComponent(id)}/${encoded}`,

            format,

            mime:
              mimeFor(format),

            quality:
              quality(name),

            providerId:
              this.id,

            providerName:
              this.name
          };
        })
        .filter(Boolean);

    return normalizeItem({
      ...archiveItem({
        identifier: id,

        title:
          data?.metadata?.title,

        description:
          data?.metadata?.description,

        year:
          data?.metadata?.year
      }),

      sources:
        uniqueBy(
          sources,
          source => source.url
        )
    });
  },

  async sources(item) {
    return (
      await this.load(item)
    ).sources || [];
  }
};

nativeProviders.set(
  InternetArchive.id,
  InternetArchive
);

const DEFAULT_REPOS = [
  {
    id:
      'phisherrepo',

    name:
      'Phisher Repo',

    url:
      'https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/refs/heads/builds/repo.json'
  },

  {
    id:
      'csx',

    name:
      'CSX',

    url:
      'https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json'
  },

  {
    id:
      'streamplay',

    name:
      'StreamPlay',

    url:
      'https://raw.githubusercontent.com/tpadev/phiser-streamplay/builds/repo.json'
  }
];

const REQUESTED = [
  'StreamPlay',
  'MovieBox',
  '4KHDHUB',
  'AniDB',
  'AnimePahe',
  'CineStream'
];

const ALIASES = {
  streamplay: [
    'streamplay'
  ],

  moviebox: [
    'moviebox',
    'movieboxprovider'
  ],

  '4khdhub': [
    '4khdhub',
    'fourkhdhub',
    'fourkhdhubprovider'
  ],

  anidb: [
    'anidb',
    'anidbprovider'
  ],

  animepahe: [
    'animepahe',
    'animepaheprovider'
  ],

  cinestream: [
    'cinestream',
    'cinestreamprovider'
  ]
};

let extensionState =
  readJson(
    EXTENSIONS_FILE,
    {
      version: 3,
      updatedAt: null,
      repositories: [],
      extensions: [],
      enabledExtensions: []
    }
  );

function repos() {
  const raw =
    text(
      process.env
        .CLOUDSTREAM_REPOSITORIES
    );

  if (!raw) {
    return DEFAULT_REPOS;
  }

  return raw
    .split(',')
    .map(
      (url, index) => ({
        id:
          `custom-${index + 1}-${hash(url)}`,

        name:
          `CloudStream Repository ${index + 1}`,

        url:
          url.trim()
      })
    )
    .filter(
      item => item.url
    );
}

function extensionMatches(
  extension,
  wanted
) {
  const target =
    normalizeName(wanted);

  const values = [
    extension?.name,
    extension?.internalName
  ]
    .map(normalizeName)
    .filter(Boolean);

  return (
    values.includes(target) ||
    (
      ALIASES[target] || []
    ).some(
      alias =>
        values.includes(
          normalizeName(alias)
        )
    )
  );
}

function extractPlugins(
  manifest
) {
  if (
    Array.isArray(manifest)
  ) {
    return manifest;
  }

  if (
    !manifest ||
    typeof manifest !== 'object'
  ) {
    return [];
  }

  for (
    const key of [
      'plugins',
      'pluginList',
      'items',
      'extensions'
    ]
  ) {
    if (
      Array.isArray(
        manifest[key]
      )
    ) {
      return manifest[key];
    }
  }

  return [];
}

function pluginLists(
  manifest,
  base
) {
  return (
    Array.isArray(
      manifest?.pluginLists
    )
      ? manifest.pluginLists
      : []
  )
    .map(
      value =>
        typeof value === 'string'
          ? value
          : value?.url ||
            value?.urlString ||
            value?.file
    )
    .map(
      value =>
        normalizeUrl(
          value,
          base
        )
    )
    .filter(Boolean);
}

function normalizeExtension(
  plugin,
  repo,
  base
) {
  const name =
    text(
      plugin?.name,
      text(
        plugin?.internalName
      )
    );

  if (!name) {
    return null;
  }

  const internalName =
    text(
      plugin?.internalName,
      name
    );

  const url =
    normalizeUrl(
      plugin?.url ||
        plugin?.file ||
        plugin?.downloadUrl,
      base
    );

  if (!url) {
    return null;
  }

  return {
    id:
      hash(
        `${repo.id}:${internalName}:${url}`
      ),

    name,

    internalName,

    pluginUrl:
      url,

    url,

    status:
      plugin?.status ?? null,

    version:
      plugin?.version ?? null,

    apiVersion:
      plugin?.apiVersion ?? null,

    description:
      text(
        plugin?.description
      ),

    repositoryUrl:
      normalizeUrl(
        plugin?.repositoryUrl,
        base
      ),

    iconUrl:
      normalizeUrl(
        plugin?.iconUrl ||
          plugin?.icon,
        base
      ),

    tvTypes:
      Array.isArray(
        plugin?.tvTypes
      )
        ? plugin.tvTypes
        : [],

    language:
      Array.isArray(
        plugin?.language
      )
        ? plugin.language
        : text(
            plugin?.language
          )
          ? [
              plugin.language
            ]
          : [],

    authors:
      Array.isArray(
        plugin?.authors
      )
        ? plugin.authors
        : [],

    fileSize:
      plugin?.fileSize ??
      null,

    fileHash:
      text(
        plugin?.fileHash
      ),

    repositoryId:
      repo.id,

    repositoryName:
      repo.name,

    discoveredAt:
      now()
  };
}

async function syncRepository(
  repo
) {
  const manifest =
    await fetchJson(
      repo.url
    );

  const extensions =
    extractPlugins(
      manifest
    )
      .map(
        plugin =>
          normalizeExtension(
            plugin,
            repo,
            repo.url
          )
      )
      .filter(Boolean);

  for (
    const list of pluginLists(
      manifest,
      repo.url
    )
  ) {
    try {
      const child =
        await fetchJson(list);

      extensions.push(
        ...extractPlugins(
          child
        )
          .map(
            plugin =>
              normalizeExtension(
                plugin,
                repo,
                list
              )
          )
          .filter(Boolean)
      );
    } catch (error) {
      console.warn(
        `[extensions] ${repo.name}: ${error.message}`
      );
    }
  }

  return {
    repository: {
      ...repo,

      status:
        'online',

      manifestVersion:
        manifest?.manifestVersion ??
        null,

      description:
        text(
          manifest?.description
        ),

      pluginLists:
        pluginLists(
          manifest,
          repo.url
        ),

      checkedAt:
        now()
    },

    extensions
  };
}

let syncPromise = null;

async function syncExtensions() {
  if (syncPromise) {
    return syncPromise;
  }

  syncPromise =
    (async () => {
      const repositoryResults = [];
      const discovered = [];

      await Promise.all(
        repos().map(
          async repo => {
            try {
              const result =
                await syncRepository(
                  repo
                );

              repositoryResults.push(
                result.repository
              );

              discovered.push(
                ...result.extensions
              );
            } catch (error) {
              repositoryResults.push({
                ...repo,

                status:
                  'offline',

                error:
                  error.message,

                checkedAt:
                  now()
              });
            }
          }
        )
      );

      const extensions =
        uniqueBy(
          discovered,
          extension =>
            `${normalizeName(
              extension.internalName
            )}:${extension.pluginUrl}`
        );

      const enabledExtensions =
        extensions.filter(
          extension =>
            REQUESTED.some(
              wanted =>
                extensionMatches(
                  extension,
                  wanted
                )
            )
        );

      extensionState = {
        version: 3,

        updatedAt:
          now(),

        repositories:
          repositoryResults,

        extensions,

        enabledExtensions
      };

      await queueWrite(
        EXTENSIONS_FILE,
        extensionState
      );

      return extensionState;
    })();

  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

function enabledExtensions() {
  return Array.isArray(
    extensionState.enabledExtensions
  )
    ? extensionState.enabledExtensions
    : [];
}

function findExtension(
  value
) {
  const target =
    normalizeName(value);

  if (!target) {
    return null;
  }

  return (
    enabledExtensions().find(
      extension =>
        [
          extension.name,
          extension.internalName,
          extension.id
        ].some(
          candidate =>
            normalizeName(
              candidate
            ) === target
        )
    ) || null
  );
}

const BRIDGE_URL =
  normalizeBaseUrl(
    process.env
      .CLOUDSTREAM_BRIDGE_URL ||
      ''
  );

const BRIDGE_TOKEN =
  String(
    process.env
      .CLOUDSTREAM_BRIDGE_TOKEN ||
      ''
  ).trim();

const USER_AGENT =
  process.env.HTTP_USER_AGENT ||
  'Mediav2/2.1';

const BRIDGE_PATHS = {
  search:
    text(
      process.env
        .CLOUDSTREAM_BRIDGE_SEARCH_PATH,
      '/search'
    ),

  home:
    text(
      process.env
        .CLOUDSTREAM_BRIDGE_HOME_PATH,
      '/home'
    ),

  load:
    text(
      process.env
        .CLOUDSTREAM_BRIDGE_LOAD_PATH,
      '/load'
    ),

  sources:
    text(
      process.env
        .CLOUDSTREAM_BRIDGE_SOURCES_PATH,
      '/sources'
    )
};

async function bridgeRequest(
  type,
  body
) {
  if (!BRIDGE_URL) {
    throw new Error(
      'CloudStream bridge is not configured'
    );
  }

  const headers =
    BRIDGE_TOKEN
      ? {
          Authorization:
            `Bearer ${BRIDGE_TOKEN}`
        }
      : {};

  const configuredPath =
    BRIDGE_PATHS[type];

  const requestPath =
    configuredPath.startsWith('/')
      ? configuredPath
      : `/${configuredPath}`;

  return fetchJson(
    `${BRIDGE_URL}${requestPath}`,
    {
      method: 'POST',
      body,
      headers,
      timeout:
        BRIDGE_TIMEOUT
    }
  );
}

function bridgeArray(
  data,
  key
) {
  if (
    Array.isArray(data)
  ) {
    return data;
  }

  if (
    Array.isArray(
      data?.[key]
    )
  ) {
    return data[key];
  }

  return [];
}

function normalizeBridgeResult(
  value
) {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return null;
  }

  const provider =
    value.provider &&
    typeof value.provider ===
      'object'
      ? value.provider
      : null;

  const providerName =
    text(
      value.providerName,
      text(
        provider?.name,
        typeof value.provider ===
          'string'
          ? value.provider
          : 'CloudStream'
      )
    );

  const providerId =
    text(
      value.providerId,
      text(
        provider?.id,
        providerName
      )
    );

  return normalizeItem({
    ...value,

    providerId,

    providerName,

    sourceUrl:
      value.sourceUrl ||
      value.url ||
      value.link,

    sourceId:
      text(
        value.sourceId,
        text(
          value.url,
          text(
            value.id
          )
        )
      ),

    raw:
      value.raw ||
      value
  });
}

function normalizeSources(
  list,
  parent
) {
  return uniqueBy(
    (
      Array.isArray(list)
        ? list
        : []
    )
      .map(source => {
        if (
          typeof source ===
          'string'
        ) {
          source = {
            url: source
          };
        }

        if (
          !source ||
          typeof source !==
            'object'
        ) {
          return null;
        }

        const url =
          normalizeUrl(
            source.url ||
              source.link
          );

        if (!url) {
          return null;
        }

        let format =
          text(
            source.format,
            text(
              source.type
            )
          ).toLowerCase();

        if (!format) {
          if (
            /\.m3u8(?:$|\?)/i.test(
              url
            )
          ) {
            format = 'hls';
          } else if (
            /\.mpd(?:$|\?)/i.test(
              url
            )
          ) {
            format = 'dash';
          } else {
            format = 'video';
          }
        }

        return {
          id:
            text(
              source.id,
              hash(url)
            ),

          name:
            text(
              source.name,
              text(
                source.title,
                'Source'
              )
            ),

          url,

          format,

          mime:
            source.mime ||
            mimeFor(format),

          quality:
            text(
              source.quality,
              quality(
                source.name ||
                url
              )
            ),

          headers:
            source.headers &&
            typeof source.headers ===
              'object'
              ? source.headers
              : {},

          referer:
            text(
              source.referer ||
              source.referrer
            ),

          subtitles:
            Array.isArray(
              source.subtitles
            )
              ? source.subtitles
              : [],

          providerId:
            parent.providerId,

          providerName:
            parent.providerName,

          raw:
            source
        };
      })
      .filter(Boolean),

    source =>
      source.url
  );
}

async function bridgeSearch(
  query,
  options
) {
  const data =
    await bridgeRequest(
      'search',
      {
        query,

        type:
          options.type ||
          'all',

        limit:
          options.limit ||
          PROVIDER_LIMIT,

        extensions:
          enabledExtensions()
      }
    );

  return bridgeArray(
    data,
    'results'
  )
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

async function bridgeHome(
  options
) {
  const data =
    await bridgeRequest(
      'home',
      {
        type:
          options.type ||
          'all',

        limit:
          options.limit ||
          PROVIDER_LIMIT,

        extensions:
          enabledExtensions()
      }
    );

  return bridgeArray(
    data,
    'results'
  )
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

async function bridgeLoad(
  item
) {
  const data =
    await bridgeRequest(
      'load',
      {
        extension:
          findExtension(
            item.providerId
          ) ||
          findExtension(
            item.providerName
          ),

        providerId:
          item.providerId,

        providerName:
          item.providerName,

        sourceId:
          item.sourceId,

        id:
          item.id,

        url:
          item.sourceUrl ||
          null
      }
    );

  const merged =
    normalizeBridgeResult({
      ...item,
      ...data,

      providerId:
        data?.providerId ||
        item.providerId,

      providerName:
        data?.providerName ||
        item.providerName,

      sourceId:
        data?.sourceId ||
        item.sourceId,

      sourceUrl:
        data?.sourceUrl ||
        data?.url ||
        item.sourceUrl,

      raw:
        data?.raw ||
        data
    });

  if (
    Array.isArray(
      data?.episodes
    )
  ) {
    merged.episodes =
      data.episodes;
  }

  if (
    Array.isArray(
      data?.seasons
    )
  ) {
    merged.seasons =
      data.seasons;
  }

  if (
    Array.isArray(
      data?.sources
    )
  ) {
    merged.sources =
      normalizeSources(
        data.sources,
        merged
      );
  }

  return merged;
}

async function bridgeSources(
  item,
  data
) {
  const result =
    await bridgeRequest(
      'sources',
      {
        extension:
          findExtension(
            item.providerId
          ) ||
          findExtension(
            item.providerName
          ),

        providerId:
          item.providerId,

        providerName:
          item.providerName,

        sourceId:
          item.sourceId,

        id:
          item.id,

        url:
          item.sourceUrl ||
          null,

        data:
          data || null
      }
    );

  return normalizeSources(
    bridgeArray(
      result,
      'sources'
    ),
    item
  );
}

async function searchAll(
  query,
  options
) {
  const tasks = [
    ...nativeProviders.values()
  ]
    .filter(
      provider =>
        typeof provider.search ===
        'function'
    )
    .map(
      provider =>
        provider
          .search(
            query,
            options
          )
          .catch(
            () => []
          )
    );

  if (BRIDGE_URL) {
    tasks.push(
      bridgeSearch(
        query,
        options
      ).catch(error => {
        console.error(
          `[bridge search] ${error.message}`
        );

        return [];
      })
    );
  }

  const results =
    (
      await Promise.all(
        tasks
      )
    )
      .flat()
      .map(
        normalizeItem
      );

  return uniqueBy(
    results,
    item =>
      `${normalizeName(
        item.providerId
      )}:${item.sourceId || item.id}:${normalizeName(
        item.title
      )}`
  ).slice(
    0,
    options.limit ||
      SEARCH_LIMIT
  );
}

async function homeAll(
  options
) {
  const tasks = [
    ...nativeProviders.values()
  ]
    .filter(
      provider =>
        typeof provider.home ===
        'function'
    )
    .map(
      provider =>
        provider
          .home(options)
          .catch(
            () => []
          )
    );

  if (BRIDGE_URL) {
    tasks.push(
      bridgeHome(
        options
      ).catch(error => {
        console.error(
          `[bridge home] ${error.message}`
        );

        return [];
      })
    );
  }

  const results =
    (
      await Promise.all(
        tasks
      )
    )
      .flat()
      .map(
        normalizeItem
      );

  return uniqueBy(
    results,
    item =>
      `${normalizeName(
        item.providerId
      )}:${item.sourceId || item.id}`
  ).slice(
    0,
    options.limit ||
      SEARCH_LIMIT
  );
}

function typeMatches(
  item,
  type
) {
  type =
    text(
      type,
      'all'
    ).toLowerCase();

  if (
    type === 'all'
  ) {
    return true;
  }

  const itemType =
    text(
      item.type
    ).toLowerCase();

  if (
    type === 'movie'
  ) {
    return [
      'movie',
      'movies'
    ].includes(
      itemType
    );
  }

  if (
    type === 'series'
  ) {
    return [
      'tvseries',
      'tv-series',
      'tv series',
      'series',
      'show'
    ].includes(
      itemType
    );
  }

  if (
    type === 'anime'
  ) {
    return (
      itemType ===
      'anime'
    );
  }

  return ![
    'movie',
    'movies',
    'tvseries',
    'tv-series',
    'tv series',
    'series',
    'show',
    'anime'
  ].includes(
    itemType
  );
}

function findItem(id) {
  return (
    library.find(
      item =>
        item.id === id
    ) ||
    null
  );
}

function json(
  response,
  value,
  status = 200
) {
  response
    .status(status)
    .json(value);
}

app.disable(
  'x-powered-by'
);

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN &&
      process.env.CORS_ORIGIN !== '*'
        ? process.env.CORS_ORIGIN
            .split(',')
            .map(
              value =>
                value.trim()
            )
        : true
  })
);

app.use(
  express.json({
    limit: '2mb',
    strict: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

app.get(
  '/health',
  (req, res) =>
    json(
      res,
      {
        ok: true,
        service:
          'Mediav2',
        bridge:
          Boolean(
            BRIDGE_URL
          ),
        providers:
          nativeProviders.size,
        timestamp:
          now()
      }
    )
);

app.get(
  '/api/health',
  (req, res) =>
    json(
      res,
      {
        ok: true,

        service:
          'Mediav2',

        version:
          '2.1.0',

        uptime:
          process.uptime(),

        bridge: {
          configured:
            Boolean(
              BRIDGE_URL
            ),

          url:
            BRIDGE_URL ||
            null,

          timeoutMs:
            BRIDGE_TIMEOUT
        },

        extensions: {
          discovered:
            extensionState
              .extensions
              .length,

          enabled:
            enabledExtensions()
              .length,

          enabledNames:
            enabledExtensions()
              .map(
                extension =>
                  extension.name
              ),

          updatedAt:
            extensionState
              .updatedAt
        },

        providers:
          [
            ...nativeProviders
              .keys()
          ],

        library:
          library.length,

        timestamp:
          now()
      }
    )
);

app.get(
  '/api/providers',
  (req, res) => {
    const providers =
      [
        ...nativeProviders
          .values()
      ].map(
        provider => ({
          id:
            provider.id,

          name:
            provider.name,

          type:
            provider.type ||
            'provider',

          cloudstream:
            false,

          playable:
            true
        })
      );

    if (BRIDGE_URL) {
      for (
        const extension of
          enabledExtensions()
      ) {
        providers.push({
          id:
            extension.id,

          name:
            extension.name,

          internalName:
            extension
              .internalName,

          type:
            'cloudstream',

          cloudstream:
            true,

          playable:
            true,

          extension
        });
      }
    }

    json(
      res,
      {
        ok: true,
        providers
      }
    );
  }
);

app.get(
  '/api/extensions',
  (req, res) =>
    json(
      res,
      {
        ok: true,

        updatedAt:
          extensionState
            .updatedAt,

        repositories:
          extensionState
            .repositories,

        count:
          extensionState
            .extensions
            .length,

        enabledCount:
          enabledExtensions()
            .length,

        bridgeConfigured:
          Boolean(
            BRIDGE_URL
          ),

        extensions:
          extensionState
            .extensions
            .map(
              extension => ({
                ...extension,

                enabled:
                  enabledExtensions()
                    .some(
                      item =>
                        item.id ===
                        extension.id
                    )
              })
            )
      }
    )
);

app.post(
  '/api/extensions/sync',
  async (req, res) => {
    try {
      json(
        res,
        {
          ok: true,
          ...(await syncExtensions())
        }
      );
    } catch (error) {
      json(
        res,
        {
          ok: false,
          error:
            error.message
        },
        502
      );
    }
  }
);

app.get(
  '/api/search',
  async (req, res) => {
    const query =
      text(
        req.query.q
      );

    if (!query) {
      return json(
        res,
        {
          ok: false,
          error:
            'Query is required'
        },
        400
      );
    }

    try {
      const type =
        text(
          req.query.type,
          'all'
        ).toLowerCase();

      const limit =
        Math.min(
          Math.max(
            Number(
              req.query.limit
            ) ||
              SEARCH_LIMIT,
            1
          ),
          SEARCH_LIMIT
        );

      const results =
        (
          await searchAll(
            query,
            {
              type,
              limit:
                Math.min(
                  PROVIDER_LIMIT,
                  limit
                ),

              providerLimit:
                PROVIDER_LIMIT
            }
          )
        ).filter(
          item =>
            typeMatches(
              item,
              type
            )
        );

      mergeIntoLibrary(
        results
      );

      json(
        res,
        {
          ok: true,

          query,

          count:
            results.length,

          providers:
            [
              ...new Set(
                results.map(
                  item =>
                    item.providerName
                )
              )
            ],

          results
        }
      );
    } catch (error) {
      json(
        res,
        {
          ok: false,
          error:
            error.message
        },
        502
      );
    }
  }
);

app.get(
  '/api/library',
  async (req, res) => {
    const refresh =
      text(
        req.query.refresh
      ).toLowerCase() ===
      'true';

    if (
      (
        refresh ||
        library.length === 0
      ) &&
      !req.query.skipRefresh
    ) {
      try {
        mergeIntoLibrary(
          await homeAll({
            limit:
              SEARCH_LIMIT
          })
        );
      } catch (error) {
        console.error(
          `[library] ${error.message}`
        );
      }
    }

    const type =
      text(
        req.query.type,
        text(
          req.query.category,
          'all'
        )
      ).toLowerCase();

    const results =
      library.filter(
        item =>
          typeMatches(
            item,
            type
          )
      );

    json(
      res,
      {
        ok: true,

        count:
          results.length,

        updatedAt:
          extensionState
            .updatedAt,

        results,

        library:
          results
      }
    );
  }
);

async function loadItem(
  item
) {
  if (
    BRIDGE_URL &&
    (
      findExtension(
        item.providerId
      ) ||
      findExtension(
        item.providerName
      )
    )
  ) {
    return bridgeLoad(
      item
    );
  }

  const provider =
    nativeProviders.get(
      item.providerId
    );

  if (
    provider?.load
  ) {
    return normalizeItem(
      await provider.load(
        item
      )
    );
  }

  return item;
}

app.get(
  '/api/title/:id',
  async (req, res) => {
    const item =
      findItem(
        text(
          req.params.id
        )
      );

    if (!item) {
      return json(
        res,
        {
          ok: false,
          error:
            'Title not found'
        },
        404
      );
    }

    try {
      const loaded =
        await loadItem(
          item
        );

      mergeIntoLibrary([
        loaded
      ]);

      json(
        res,
        {
          ok: true,
          item: loaded
        }
      );
    } catch (error) {
      json(
        res,
        {
          ok: false,
          error:
            error.message
        },
        502
      );
    }
  }
);

app.get(
  '/api/sources/:id',
  async (req, res) => {
    const item =
      findItem(
        text(
          req.params.id
        )
      );

    if (!item) {
      return json(
        res,
        {
          ok: false,
          error:
            'Title not found'
        },
        404
      );
    }

    try {
      if (
        BRIDGE_URL &&
        (
          findExtension(
            item.providerId
          ) ||
          findExtension(
            item.providerName
          )
        )
      ) {
        const loaded =
          await bridgeLoad(
            item
          );

        let data =
          text(
            req.query.data,
            text(
              loaded?.data,
              item.data
            )
          );

        if (
          !data &&
          Array.isArray(
            loaded?.episodes
          ) &&
          loaded.episodes.length
        ) {
          const season =
            Number(
              req.query.season
            );

          const episode =
            Number(
              req.query.episode
            );

          const chosen =
            loaded.episodes.find(
              itemEpisode =>
                (
                  !Number.isFinite(
                    season
                  ) ||
                  Number(
                    itemEpisode?.season
                  ) === season
                ) &&
                (
                  !Number.isFinite(
                    episode
                  ) ||
                  Number(
                    itemEpisode?.episode
                  ) === episode
                )
            ) ||
            loaded.episodes[0];

          data =
            text(
              chosen?.data
            );
        }

        if (!data) {
          throw new Error(
            'CloudStream LoadResponse data is missing'
          );
        }

        const sources =
          await bridgeSources(
            loaded || item,
            data
          );

        return json(
          res,
          {
            ok: true,

            provider:
              loaded.providerName ||
              item.providerName,

            sources
          }
        );
      }

      const provider =
        nativeProviders.get(
          item.providerId
        );

      if (
        provider?.sources
      ) {
        return json(
          res,
          {
            ok: true,

            provider:
              provider.name,

            sources:
              normalizeSources(
                await provider.sources(
                  item
                ),
                item
              )
          }
        );
      }

      if (
        provider?.load
      ) {
        const loaded =
          await provider.load(
            item
          );

        return json(
          res,
          {
            ok: true,

            provider:
              provider.name,

            sources:
              normalizeSources(
                loaded?.sources ||
                  [],
                item
              )
          }
        );
      }

      return json(
        res,
        {
          ok: true,

          provider:
            item.providerName,

          sources:
            normalizeSources(
              item.sources ||
                [],
              item
            )
        }
      );
    } catch (error) {
      json(
        res,
        {
          ok: false,

          error:
            error.message,

          provider:
            item.providerName,

          sourceId:
            item.sourceId
        },
        502
      );
    }
  }
);

app.post(
  '/api/sync',
  async (req, res) => {
    try {
      const extensions =
        await syncExtensions();

      mergeIntoLibrary(
        await homeAll({
          limit:
            SEARCH_LIMIT
        })
      );

      json(
        res,
        {
          ok: true,

          extensions:
            extensions
              .extensions
              .length,

          enabledExtensions:
            extensions
              .enabledExtensions
              .length,

          library:
            library.length,

          updatedAt:
            now()
        }
      );
    } catch (error) {
      json(
        res,
        {
          ok: false,
          error:
            error.message
        },
        502
      );
    }
  }
);

app.get(
  '/',
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      `[http] ${error.message}`
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    json(
      res,
      {
        ok: false,
        error:
          error.message ||
          'Bad request'
      },
      400
    );
  }
);

app.use(
  (req, res) =>
    json(
      res,
      {
        ok: false,
        error:
          'Not found'
      },
      404
    )
);

let lastSync = 0;

async function startup() {
  try {
    await syncExtensions();

    lastSync =
      Date.now();

    mergeIntoLibrary(
      await homeAll({
        limit:
          SEARCH_LIMIT
      })
    );

    console.log(
      `Mediav2 ready: ${library.length} titles, ${enabledExtensions().length} enabled extensions`
    );
  } catch (error) {
    console.error(
      `[startup] ${error.message}`
    );
  }
}

setInterval(
  async () => {
    const interval =
      Math.max(
        Number(
          process.env
            .CLOUDSTREAM_SYNC_INTERVAL
        ) ||
          21600000,
        300000
      );

    if (
      Date.now() -
        lastSync <
      interval
    ) {
      return;
    }

    try {
      await syncExtensions();

      lastSync =
        Date.now();

      mergeIntoLibrary(
        await homeAll({
          limit:
            SEARCH_LIMIT
        })
      );
    } catch (error) {
      console.error(
        `[scheduled sync] ${error.message}`
      );
    }
  },
  300000
).unref();

const server =
  app.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `Mediav2 listening on ${PORT}`
      );

      void startup();
    }
  );

function shutdown(
  signal
) {
  console.log(
    `${signal} received`
  );

  server.close(
    () =>
      process.exit(0)
  );

  setTimeout(
    () =>
      process.exit(1),
    10000
  ).unref();
}

process.on(
  'SIGTERM',
  () =>
    shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () =>
    shutdown('SIGINT')
);

process.on(
  'unhandledRejection',
  error =>
    console.error(
      '[unhandledRejection]',
      error
    )
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[uncaughtException]',
      error
    );

    process.exit(1);
  }
);
