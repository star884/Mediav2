const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = toPositiveInt(process.env.PORT, 3000);

const DATA_DIR = path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const EXTENSIONS_FILE = path.join(DATA_DIR, "extensions.json");

const REQUEST_TIMEOUT_MS = toPositiveInt(
  process.env.REQUEST_TIMEOUT_MS,
  20000
);

const BRIDGE_TIMEOUT_MS = toPositiveInt(
  process.env.CLOUDSTREAM_BRIDGE_TIMEOUT_MS,
  130000
);

const EXTENSION_SYNC_HOURS = toPositiveNumber(
  process.env.EXTENSION_SYNC_HOURS,
  6
);

const BRIDGE_URL = normalizeBaseUrl(
  process.env.CLOUDSTREAM_BRIDGE_URL ||
    "http://127.0.0.1:10001"
);

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mediav2/2.0 (+https://github.com/star884/Mediav2)";

const MAX_RESULTS = 100;

/* ============================================================
   HELPERS
============================================================ */

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function now() {
  return new Date().toISOString();
}

function safeString(value, fallback = "") {
  return typeof value === "string"
    ? value.trim()
    : fallback;
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);
}

function slug(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeExtensionName(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeBaseUrl(value) {
  const url = normalizeUrl(value);

  return url
    ? url.replace(/\/+$/, "")
    : "";
}

function normalizeUrl(value, baseUrl = null) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  try {
    const url = new URL(
      value.trim(),
      baseUrl || undefined
    );

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
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

    if (
      !key ||
      seen.has(key)
    ) {
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
      fs.readFileSync(
        file,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      `[Storage] ${file}: ${error.message}`
    );

    return fallback;
  }
}

/*
 * Serializes JSON writes so two simultaneous
 * searches/loads cannot corrupt the same file.
 */
let writeQueue = Promise.resolve();

function writeJson(file, value) {
  const temporary =
    `${file}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    temporary,
    JSON.stringify(
      value,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temporary,
    file
  );
}

function queueWrite(file, value) {
  writeQueue = writeQueue
    .then(() => {
      writeJson(
        file,
        value
      );
    })
    .catch(error => {
      console.error(
        `[Storage] Write failed: ${error.message}`
      );
    });

  return writeQueue;
}

function mimeForFormat(format) {
  switch (
    safeString(format).toLowerCase()
  ) {
    case "mp4":
      return "video/mp4";

    case "webm":
      return "video/webm";

    case "m3u8":
    case "hls":
      return "application/vnd.apple.mpegurl";

    case "mpd":
    case "dash":
      return "application/dash+xml";

    default:
      return null;
  }
}

function extractQuality(value) {
  const match =
    safeString(value).match(
      /(?:^|[._\-\s])(2160|1440|1080|720|576|480|360)p?(?:[._\-\s]|$)/i
    );

  return match
    ? `${match[1]}p`
    : "Unknown";
}

/* ============================================================
   EXPRESS
============================================================ */

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

app.disable(
  "x-powered-by"
);

app.use(
  cors()
);

app.use(
  express.json({
    limit: "2mb",
    strict: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* ============================================================
   HTTP JSON
============================================================ */

async function fetchJson(
  url,
  options = {}
) {
  const controller =
    new AbortController();

  const timeoutMs =
    toPositiveInt(
      options.timeout,
      REQUEST_TIMEOUT_MS
    );

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const headers = {
      Accept:
        "application/json",

      "User-Agent":
        USER_AGENT,

      ...(options.headers || {})
    };

    const init = {
      method:
        options.method ||
        "GET",

      headers,

      signal:
        controller.signal
    };

    if (
      options.body !==
      undefined
    ) {
      init.body =
        JSON.stringify(
          options.body
        );

      headers[
        "Content-Type"
      ] =
        "application/json";
    }

    const response =
      await fetch(
        url,
        init
      );

    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}` +
        (
          text
            ? `: ${text.slice(0, 300)}`
            : ""
        )
      );
    }

    if (!text.trim()) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Expected JSON from ${url}`
      );
    }
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        `Request timed out after ${timeoutMs}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   MEDIA NORMALIZATION
============================================================ */

function normalizeMediaItem(
  item = {}
) {
  item =
    item &&
    typeof item === "object"
      ? item
      : {};

  const providerId =
    safeString(
      item.providerId,
      "unknown"
    );

  const providerName =
    safeString(
      item.providerName,
      providerId
    );

  const sourceId =
    safeString(
      item.sourceId,
      safeString(item.id)
    );

  const title =
    safeString(
      item.title,
      "Untitled"
    );

  const id =
    safeString(item.id) ||
    hash(
      `${providerId}:${sourceId}:${title}`
    );

  const yearNumber =
    Number(item.year);

  return {
    id,

    providerId,

    providerName,

    sourceId,

    sourceUrl:
      normalizeUrl(
        item.sourceUrl ||
        item.url ||
        item.link
      ),

    title,

    originalTitle:
      safeString(
        item.originalTitle,
        title
      ),

    type:
      safeString(
        item.type,
        "unknown"
      ).toLowerCase(),

    year:
      Number.isFinite(
        yearNumber
      ) &&
      yearNumber > 0
        ? yearNumber
        : null,

    poster:
      normalizeUrl(
        item.poster ||
        item.posterUrl ||
        item.image
      ),

    backdrop:
      normalizeUrl(
        item.backdrop ||
        item.backdropUrl
      ),

    description:
      safeString(
        item.description
      ),

    rating:
      item.rating ??
      null,

    duration:
      item.duration ??
      null,

    genres:
      Array.isArray(
        item.genres
      )
        ? item.genres
        : [],

    tags:
      Array.isArray(
        item.tags
      )
        ? item.tags
        : [],

    language:
      safeString(
        item.language
      ),

    country:
      safeString(
        item.country
      ),

    season:
      item.season ??
      null,

    episode:
      item.episode ??
      null,

    data:
      safeString(
        item.data
      ) ||
      null,

    episodes:
      Array.isArray(
        item.episodes
      )
        ? item.episodes
        : [],

    seasons:
      Array.isArray(
        item.seasons
      )
        ? item.seasons
        : [],

    sources:
      Array.isArray(
        item.sources
      )
        ? item.sources
        : [],

    metadata:
      item.metadata &&
      typeof item.metadata === "object"
        ? item.metadata
        : {},

    raw:
      item.raw &&
      typeof item.raw === "object"
        ? item.raw
        : null
  };
}

/* ============================================================
   LIBRARY
============================================================ */

let mediaLibrary =
  readJson(
    CACHE_FILE,
    []
  );

if (
  !Array.isArray(
    mediaLibrary
  )
) {
  mediaLibrary = [];
}

function libraryKey(item) {
  return (
    `${normalizeExtensionName(
      item.providerId
    )}:` +
    `${safeString(
      item.sourceId,
      safeString(item.id)
    )}`
  );
}

function mergeMedia(
  oldItem,
  newItem
) {
  const merged = {
    ...oldItem,
    ...newItem
  };

  for (
    const key of [
      "sourceUrl",
      "poster",
      "backdrop",
      "description",
      "data",
      "rating",
      "duration"
    ]
  ) {
    if (
      !newItem[key] &&
      oldItem[key]
    ) {
      merged[key] =
        oldItem[key];
    }
  }

  for (
    const key of [
      "genres",
      "tags",
      "episodes",
      "seasons",
      "sources"
    ]
  ) {
    if (
      (
        !Array.isArray(
          newItem[key]
        ) ||
        !newItem[key].length
      ) &&
      Array.isArray(
        oldItem[key]
      )
    ) {
      merged[key] =
        oldItem[key];
    }
  }

  merged.metadata = {
    ...(oldItem.metadata || {}),
    ...(newItem.metadata || {})
  };

  return merged;
}

function mergeIntoLibrary(
  items
) {
  const normalized =
    (
      Array.isArray(items)
        ? items
        : []
    )
      .map(
        normalizeMediaItem
      )
      .filter(
        item =>
          item.title !==
          "Untitled"
      );

  const existing =
    new Map(
      mediaLibrary.map(
        item => [
          libraryKey(item),
          item
        ]
      )
    );

  for (
    const item of normalized
  ) {
    const key =
      libraryKey(item);

    const old =
      existing.get(key);

    existing.set(
      key,
      old
        ? mergeMedia(
            old,
            item
          )
        : item
    );
  }

  mediaLibrary =
    [
      ...existing.values()
    ];

  queueWrite(
    CACHE_FILE,
    mediaLibrary
  );

  return normalized;
}

/* ============================================================
   NATIVE PROVIDERS
============================================================ */

const providers =
  new Map();

function registerProvider(
  provider
) {
  if (
    !provider ||
    !provider.id
  ) {
    throw new Error(
      "Provider requires an id"
    );
  }

  providers.set(
    provider.id,
    provider
  );
}

/* ============================================================
   INTERNET ARCHIVE
============================================================ */

const InternetArchiveProvider = {
  id:
    "internet-archive",

  name:
    "Internet Archive",

  type:
    "public-media",

  async search(
    query,
    options = {}
  ) {
    const q =
      safeString(query);

    if (!q) {
      return [];
    }

    const rows =
      Math.min(
        toPositiveInt(
          options.limit,
          40
        ),
        MAX_RESULTS
      );

    const params =
      new URLSearchParams({
        q:
          `title:(${q}) AND mediatype:movies`,

        fl:
          "identifier,title,description,year,date",

        rows:
          String(rows),

        output:
          "json",

        page:
          "1"
      });

    const data =
      await fetchJson(
        `https://archive.org/advancedsearch.php?${params}`
      );

    return Array.isArray(
      data?.response?.docs
    )
      ? data.response.docs
          .map(
            archiveItem
          )
          .filter(Boolean)
      : [];
  },

  async home(
    options = {}
  ) {
    const rows =
      Math.min(
        toPositiveInt(
          options.limit,
          40
        ),
        MAX_RESULTS
      );

    const params =
      new URLSearchParams({
        q:
          "mediatype:movies",

        fl:
          "identifier,title,description,year,date",

        rows:
          String(rows),

        output:
          "json",

        page:
          "1",

        sort:
          "downloads desc"
      });

    const data =
      await fetchJson(
        `https://archive.org/advancedsearch.php?${params}`
      );

    return Array.isArray(
      data?.response?.docs
    )
      ? data.response.docs
          .map(
            archiveItem
          )
          .filter(Boolean)
      : [];
  },

  async load(
    item
  ) {
    const identifier =
      safeString(
        item.sourceId,
        safeString(item.id)
      );

    if (!identifier) {
      throw new Error(
        "Missing Internet Archive identifier"
      );
    }

    const metadata =
      await fetchJson(
        `https://archive.org/metadata/${encodeURIComponent(
          identifier
        )}`
      );

    const sources =
      (
        Array.isArray(
          metadata?.files
        )
          ? metadata.files
          : []
      )
        .map(file => {
          const name =
            safeString(
              file?.name
            );

          if (!name) {
            return null;
          }

          const lower =
            name.toLowerCase();

          let format =
            "";

          if (
            lower.endsWith(
              ".m3u8"
            )
          ) {
            format =
              "hls";
          } else if (
            lower.endsWith(
              ".mp4"
            )
          ) {
            format =
              "mp4";
          } else if (
            lower.endsWith(
              ".webm"
            )
          ) {
            format =
              "webm";
          } else {
            return null;
          }

          const encodedPath =
            name
              .split("/")
              .map(
                encodeURIComponent
              )
              .join("/");

          return {
            id:
              hash(
                `${identifier}:${name}`
              ),

            title:
              name,

            url:
              `https://archive.org/download/${encodeURIComponent(
                identifier
              )}/${encodedPath}`,

            format,

            mime:
              mimeForFormat(
                format
              ),

            quality:
              extractQuality(
                name
              ),

            providerId:
              this.id,

            providerName:
              this.name
          };
        })
        .filter(Boolean);

    return {
      ...archiveItem({
        identifier,

        title:
          metadata?.metadata?.title,

        description:
          metadata?.metadata?.description,

        year:
          metadata?.metadata?.year
      }),

      sources:
        uniqueBy(
          sources,
          source =>
            source.url
        )
    };
  },

  async sources(
    item
  ) {
    const loaded =
      await this.load(
        item
      );

    return (
      loaded.sources ||
      []
    );
  }
};

function archiveItem(
  doc
) {
  const identifier =
    safeString(
      doc?.identifier
    );

  if (!identifier) {
    return null;
  }

  return normalizeMediaItem({
    providerId:
      "internet-archive",

    providerName:
      "Internet Archive",

    id:
      identifier,

    sourceId:
      identifier,

    sourceUrl:
      `https://archive.org/details/${encodeURIComponent(
        identifier
      )}`,

    title:
      safeString(
        doc?.title,
        identifier
      ),

    description:
      safeString(
        doc?.description
      ),

    year:
      doc?.year,

    type:
      "movie"
  });
}

registerProvider(
  InternetArchiveProvider
);

/* ============================================================
   CLOUDSTREAM REPOSITORIES
============================================================ */

const DEFAULT_CLOUDSTREAM_REPOSITORIES = [
  {
    id:
      "phisherrepo",

    name:
      "Phisher Repo",

    url:
      "https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/refs/heads/builds/repo.json"
  },

  {
    id:
      "csx",

    name:
      "CSX",

    url:
      "https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json"
  },

  {
    id:
      "streamplay",

    name:
      "StreamPlay",

    url:
      "https://raw.githubusercontent.com/tpadev/phiser-streamplay/builds/repo.json"
  }
];

const REQUESTED_EXTENSIONS = [
  "StreamPlay",
  "MovieBox",
  "4KHDHUB",
  "AniDB",
  "AnimePahe",
  "CineStream"
];

const EXTENSION_ALIASES = {
  streamplay: [
    "streamplay"
  ],

  moviebox: [
    "moviebox",
    "movieboxprovider"
  ],

  "4khdhub": [
    "4khdhub",
    "fourkhdhub",
    "fourkhdhubprovider"
  ],

  anidb: [
    "anidb",
    "anidbprovider"
  ],

  animepahe: [
    "animepahe",
    "animepaheprovider"
  ],

  cinestream: [
    "cinestream",
    "cinestreamprovider"
  ]
};

let extensionState =
  readJson(
    EXTENSIONS_FILE,
    {
      version:
        2,

      updatedAt:
        null,

      repositories:
        [],

      extensions:
        [],

      enabledExtensions:
        []
    }
  );

if (
  !extensionState ||
  typeof extensionState !==
    "object"
) {
  extensionState = {
    version:
      2,

    updatedAt:
      null,

    repositories:
      [],

    extensions:
      [],

    enabledExtensions:
      []
  };
}

function getConfiguredRepositories() {
  const raw =
    safeString(
      process.env
        .CLOUDSTREAM_REPOSITORIES
    );

  if (!raw) {
    return DEFAULT_CLOUDSTREAM_REPOSITORIES;
  }

  return raw
    .split(",")
    .map(
      value =>
        value.trim()
    )
    .filter(Boolean)
    .map(
      (
        url,
        index
      ) => ({
        id:
          `custom-${index + 1}-${hash(
            url
          )}`,

        name:
          `CloudStream Repository ${index + 1}`,

        url
      })
    );
}

function extensionMatches(
  extension,
  requested
) {
  const target =
    normalizeExtensionName(
      requested
    );

  const values = [
    extension?.name,
    extension?.internalName
  ]
    .map(
      normalizeExtensionName
    )
    .filter(Boolean);

  if (
    values.includes(
      target
    )
  ) {
    return true;
  }

  return (
    EXTENSION_ALIASES[
      target
    ] || []
  ).some(
    alias =>
      values.includes(
        normalizeExtensionName(
          alias
        )
      )
  );
}

function normalizeExtension(
  plugin,
  repository,
  listUrl
) {
  if (
    !plugin ||
    typeof plugin !==
      "object"
  ) {
    return null;
  }

  const name =
    safeString(
      plugin.name,
      safeString(
        plugin.internalName,
        "Unknown Extension"
      )
    );

  const internalName =
    safeString(
      plugin.internalName,
      name
    );

  const pluginUrl =
    normalizeUrl(
      plugin.url ||
        plugin.file ||
        plugin.downloadUrl,
      listUrl ||
        repository.url
    );

  if (!pluginUrl) {
    return null;
  }

  return {
    id:
      hash(
        `${repository.id}:${internalName}:${pluginUrl}`
      ),

    name,

    internalName,

    pluginUrl,

    url:
      pluginUrl,

    status:
      plugin.status ??
      null,

    version:
      plugin.version ??
      null,

    apiVersion:
      plugin.apiVersion ??
      null,

    description:
      safeString(
        plugin.description
      ),

    repositoryUrl:
      normalizeUrl(
        plugin.repositoryUrl,
        repository.url
      ),

    iconUrl:
      normalizeUrl(
        plugin.iconUrl ||
          plugin.icon,
        listUrl ||
          repository.url
      ),

    tvTypes:
      Array.isArray(
        plugin.tvTypes
      )
        ? plugin.tvTypes
        : [],

    language:
      Array.isArray(
        plugin.language
      )
        ? plugin.language
        : (
            safeString(
              plugin.language
            )
              ? [
                  plugin.language
                ]
              : []
          ),

    authors:
      Array.isArray(
        plugin.authors
      )
        ? plugin.authors
        : [],

    fileSize:
      plugin.fileSize ??
      null,

    fileHash:
      safeString(
        plugin.fileHash
      ),

    repositoryId:
      repository.id,

    repositoryName:
      repository.name,

    discoveredAt:
      now()
  };
}

function extractPlugins(
  manifest
) {
  if (
    Array.isArray(
      manifest
    )
  ) {
    return manifest;
  }

  if (
    !manifest ||
    typeof manifest !==
      "object"
  ) {
    return [];
  }

  for (
    const key of [
      "plugins",
      "pluginList",
      "items",
      "extensions"
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

function pluginListUrls(
  manifest,
  repositoryUrl
) {
  const lists =
    Array.isArray(
      manifest?.pluginLists
    )
      ? manifest.pluginLists
      : [];

  return lists
    .map(
      item =>
        typeof item ===
        "string"
          ? item
          : item?.url ||
            item?.urlString ||
            item?.file
    )
    .map(
      value =>
        normalizeUrl(
          value,
          repositoryUrl
        )
    )
    .filter(Boolean);
}

async function syncOneRepository(
  repository
) {
  const manifest =
    await fetchJson(
      repository.url
    );

  const extensions =
    [];

  for (
    const plugin of
      extractPlugins(
        manifest
      )
  ) {
    const extension =
      normalizeExtension(
        plugin,
        repository,
        repository.url
      );

    if (extension) {
      extensions.push(
        extension
      );
    }
  }

  const lists =
    pluginListUrls(
      manifest,
      repository.url
    );

  for (
    const listUrl of lists
  ) {
    try {
      const list =
        await fetchJson(
          listUrl
        );

      for (
        const plugin of
          extractPlugins(
            list
          )
      ) {
        const extension =
          normalizeExtension(
            plugin,
            repository,
            listUrl
          );

        if (extension) {
          extensions.push(
            extension
          );
        }
      }
    } catch (
      error
    ) {
      console.warn(
        `[Extensions] ${repository.name}: ${listUrl}: ${error.message}`
      );
    }
  }

  return {
    repository: {
      ...repository,

      status:
        "online",

      manifestVersion:
        manifest?.manifestVersion ??
        null,

      description:
        safeString(
          manifest?.description
        ),

      pluginLists:
        lists,

      checkedAt:
        now()
    },

    extensions
  };
}

/*
 * Prevents multiple /api/sync requests or scheduled
 * syncs from modifying extension state simultaneously.
 */
let extensionSyncInProgress =
  null;

async function syncExtensions() {
  if (
    extensionSyncInProgress
  ) {
    return extensionSyncInProgress;
  }

  extensionSyncInProgress =
    (async () => {
      const repositories =
        getConfiguredRepositories();

      const repositoryResults =
        [];

      const discovered =
        [];

      await Promise.all(
        repositories.map(
          async repository => {
            try {
              const result =
                await syncOneRepository(
                  repository
                );

              repositoryResults.push(
                result.repository
              );

              discovered.push(
                ...result.extensions
              );

              console.log(
                `[Extensions] ${repository.name}: ${result.extensions.length} extensions`
              );
            } catch (
              error
            ) {
              console.error(
                `[Extensions] ${repository.name}: ${error.message}`
              );

              repositoryResults.push({
                ...repository,

                status:
                  "offline",

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
            `${normalizeExtensionName(
              extension.internalName
            )}:${extension.pluginUrl}`
        );

      const enabledExtensions =
        extensions.filter(
          extension =>
            REQUESTED_EXTENSIONS.some(
              requested =>
                extensionMatches(
                  extension,
                  requested
                )
            )
        );

      extensionState = {
        version:
          2,

        updatedAt:
          now(),

        repositories:
          repositoryResults,

        extensions,

        enabledExtensions
      };

      queueWrite(
        EXTENSIONS_FILE,
        extensionState
      );

      for (
        const requested of
          REQUESTED_EXTENSIONS
      ) {
        const found =
          enabledExtensions.some(
            extension =>
              extensionMatches(
                extension,
                requested
              )
          );

        if (!found) {
          console.warn(
            `[Extensions] ${requested}: NOT FOUND`
          );
        }
      }

      return extensionState;
    })();

  try {
    return await extensionSyncInProgress;
  } finally {
    extensionSyncInProgress =
      null;
  }
}

function getEnabledExtensions() {
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
    normalizeExtensionName(
      value
    );

  if (!target) {
    return null;
  }

  return getEnabledExtensions()
    .find(
      extension =>
        [
          extension.name,
          extension.internalName,
          extension.id
        ].some(
          value =>
            normalizeExtensionName(
              value
            ) === target
        )
    ) ||
    null;
}

/* ============================================================
   CLOUDSTREAM BRIDGE
============================================================ */

async function bridgeRequest(
  endpoint,
  body = {}
) {
  if (!BRIDGE_URL) {
    throw new Error(
      "CloudStream bridge URL is invalid or not configured"
    );
  }

  return fetchJson(
    `${BRIDGE_URL}/${endpoint.replace(
      /^\/+/,
      ""
    )}`,
    {
      method:
        "POST",

      body,

      timeout:
        BRIDGE_TIMEOUT_MS
    }
  );
}

function bridgeResultArray(
  result,
  key
) {
  if (
    Array.isArray(result)
  ) {
    return result;
  }

  if (
    Array.isArray(
      result?.[key]
    )
  ) {
    return result[key];
  }

  return [];
}

async function bridgeSearch(
  query,
  options = {}
) {
  const result =
    await bridgeRequest(
      "search",
      {
        query:
          safeString(query),

        type:
          safeString(
            options.type,
            "all"
          ),

        limit:
          Math.min(
            toPositiveInt(
              options.limit,
              50
            ),
            MAX_RESULTS
          ),

        extensions:
          getEnabledExtensions()
      }
    );

  return bridgeResultArray(
    result,
    "results"
  )
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

async function bridgeHome(
  options = {}
) {
  const result =
    await bridgeRequest(
      "home",
      {
        type:
          safeString(
            options.type,
            "all"
          ),

        limit:
          Math.min(
            toPositiveInt(
              options.limit,
              100
            ),
            MAX_RESULTS
          ),

        extensions:
          getEnabledExtensions()
      }
    );

  return bridgeResultArray(
    result,
    "items"
  )
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

async function bridgeLoad(
  item
) {
  const extension =
    findExtension(
      item.providerId
    ) ||
    findExtension(
      item.providerName
    );

  return normalizeBridgeLoad(
    await bridgeRequest(
      "load",
      {
        extension,

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
    ),
    item
  );
}

async function bridgeSources(
  item,
  data
) {
  const extension =
    findExtension(
      item.providerId
    ) ||
    findExtension(
      item.providerName
    );

  return normalizeBridgeSources(
    await bridgeRequest(
      "sources",
      {
        extension,

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
          safeString(data) ||
          null
      }
    ),
    item
  );
}

/* ============================================================
   CLOUDSTREAM RESULT NORMALIZATION
============================================================ */

function normalizeBridgeResult(
  result
) {
  if (
    !result ||
    typeof result !==
      "object"
  ) {
    return null;
  }

  const providerObject =
    result.provider &&
    typeof result.provider ===
      "object"
      ? result.provider
      : null;

  const providerName =
    safeString(
      result.providerName,

      safeString(
        providerObject?.name,

        typeof result.provider ===
        "string"
          ? result.provider
          : "CloudStream"
      )
    );

  const providerId =
    safeString(
      result.providerId,

      safeString(
        providerObject?.id,
        providerName
      )
    );

  return normalizeMediaItem({
    ...result,

    providerId,

    providerName,

    sourceUrl:
      result.sourceUrl ||
      result.url ||
      result.link,

    sourceId:
      safeString(
        result.sourceId,
        safeString(
          result.url,
          safeString(
            result.id
          )
        )
      ),

    raw:
      result.raw ||
      result
  });
}

/* ============================================================
   CLOUDSTREAM LOAD NORMALIZATION
============================================================ */

function normalizeBridgeLoad(
  result,
  originalItem
) {
  const merged =
    result &&
    typeof result ===
      "object"
      ? {
          ...originalItem,
          ...result,

          providerId:
            result.providerId ||
            originalItem.providerId,

          providerName:
            result.providerName ||
            originalItem.providerName,

          sourceId:
            result.sourceId ||
            originalItem.sourceId,

          sourceUrl:
            result.sourceUrl ||
            result.url ||
            originalItem.sourceUrl,

          data:
            result.data ||
            originalItem.data ||
            null,

          raw:
            result.raw ||
            result
        }
      : originalItem;

  const item =
    normalizeBridgeResult(
      merged
    );

  if (
    Array.isArray(
      result?.sources
    )
  ) {
    item.sources =
      normalizeSources(
        result.sources,
        item
      );
  }

  if (
    Array.isArray(
      result?.episodes
    )
  ) {
    item.episodes =
      result.episodes
        .map(
          normalizeEpisode
        )
        .filter(Boolean);
  }

  if (
    Array.isArray(
      result?.seasons
    )
  ) {
    item.seasons =
      result.seasons;
  }

  return item;
}

function normalizeEpisode(
  episode
) {
  if (
    !episode ||
    typeof episode !==
      "object"
  ) {
    return null;
  }

  return {
    ...episode,

    data:
      safeString(
        episode.data
      ) ||
      null,

    season:
      episode.season ??
      null,

    episode:
      episode.episode ??
      null,

    name:
      safeString(
        episode.name,
        safeString(
          episode.title,
          "Episode"
        )
      ),

    poster:
      normalizeUrl(
        episode.poster ||
        episode.posterUrl
      )
  };
}

/* ============================================================
   SOURCE NORMALIZATION
============================================================ */

function sourceToSource(
  value,
  parent
) {
  const url =
    normalizeUrl(
      value
    );

  if (!url) {
    return null;
  }

  const isM3u8 =
    /\.m3u8(?:$|\?)/i.test(
      url
    );

  const isDash =
    /\.mpd(?:$|\?)/i.test(
      url
    );

  return {
    id:
      hash(url),

    title:
      value,

    url,

    format:
      isM3u8
        ? "hls"
        : isDash
          ? "dash"
          : "",

    mime:
      mimeForFormat(
        isM3u8
          ? "hls"
          : isDash
            ? "dash"
            : ""
      ),

    quality:
      extractQuality(
        value
      ),

    providerId:
      parent.providerId,

    providerName:
      parent.providerName,

    isM3u8,

    isDash
  };
}

function normalizeSources(
  sources,
  parent
) {
  return uniqueBy(
    (
      Array.isArray(sources)
        ? sources
        : []
    )
      .map(
        source => {
          if (
            typeof source ===
            "string"
          ) {
            return sourceToSource(
              source,
              parent
            );
          }

          if (
            !source ||
            typeof source !==
              "object"
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
            safeString(
              source.format
            ).toLowerCase();

          if (!format) {
            format =
              safeString(
                source.type
              ).toLowerCase();
          }

          if (
            !format &&
            /\.m3u8(?:$|\?)/i.test(
              url
            )
          ) {
            format =
              "hls";
          } else if (
            !format &&
            /\.mpd(?:$|\?)/i.test(
              url
            )
          ) {
            format =
              "dash";
          }

          return {
            id:
              safeString(
                source.id,
                hash(url)
              ),

            title:
              safeString(
                source.title,
                safeString(
                  source.name,
                  "Source"
                )
              ),

            url,

            format,

            mime:
              source.mime ||
              mimeForFormat(
                format
              ),

            quality:
              safeString(
                source.quality,
                extractQuality(
                  source.title ||
                  source.name ||
                  url
                )
              ),

            headers:
              source.headers &&
              typeof source.headers ===
                "object"
                ? source.headers
                : undefined,

            referer:
              safeString(
                source.referer
              ) ||
              undefined,

            subtitles:
              Array.isArray(
                source.subtitles
              )
                ? source.subtitles
                : [],

            isM3u8:
              /\.m3u8(?:$|\?)/i.test(
                url
              ),

            isDash:
              /\.mpd(?:$|\?)/i.test(
                url
              ),

            providerId:
              parent.providerId,

            providerName:
              parent.providerName,

            raw:
              source
          };
        }
      )
      .filter(Boolean),

    source =>
      source.url
  );
}

function normalizeBridgeSources(
  result,
  parent
) {
  return normalizeSources(
    bridgeResultArray(
      result,
      "sources"
    ),
    parent
  );
}

/* ============================================================
   GLOBAL SEARCH
============================================================ */

async function searchProvider(
  provider,
  query,
  options
) {
  try {
    if (
      typeof provider.search !==
      "function"
    ) {
      return [];
    }

    const result =
      await provider.search(
        query,
        options
      );

    return Array.isArray(
      result
    )
      ? result
          .map(
            normalizeMediaItem
          )
          .filter(Boolean)
      : [];
  } catch (
    error
  ) {
    console.error(
      `[Provider:${provider.id}] Search: ${error.message}`
    );

    return [];
  }
}

async function searchAllProviders(
  query,
  options = {}
) {
  const tasks =
    [
      ...providers.values()
    ]
      .filter(
        provider =>
          typeof provider.search ===
          "function"
      )
      .map(
        provider =>
          searchProvider(
            provider,
            query,
            options
          )
      );

  if (BRIDGE_URL) {
    tasks.push(
      bridgeSearch(
        query,
        options
      ).catch(
        error => {
          console.error(
            `[CloudStream Search] ${error.message}`
          );

          return [];
        }
      )
    );
  }

  const results =
    await Promise.all(
      tasks
    );

  return uniqueBy(
    results
      .flat()
      .filter(Boolean),

    item =>
      `${normalizeExtensionName(
        item.providerId
      )}:${slug(
        item.title
      )}:${item.sourceId || item.id}`
  );
}

/* ============================================================
   HOME
============================================================ */

async function homeAllProviders(
  options = {}
) {
  const tasks =
    [
      ...providers.values()
    ]
      .filter(
        provider =>
          typeof provider.home ===
          "function"
      )
      .map(
        async provider => {
          try {
            const result =
              await provider.home(
                options
              );

            return Array.isArray(
              result
            )
              ? result
                  .map(
                    normalizeMediaItem
                  )
                  .filter(Boolean)
              : [];
          } catch (
            error
          ) {
            console.error(
              `[Provider:${provider.id}] Home: ${error.message}`
            );

            return [];
          }
        }
      );

  if (BRIDGE_URL) {
    tasks.push(
      bridgeHome(
        options
      ).catch(
        error => {
          console.error(
            `[CloudStream Home] ${error.message}`
          );

          return [];
        }
      )
    );
  }

  const results =
    await Promise.all(
      tasks
    );

  return uniqueBy(
    results
      .flat()
      .filter(Boolean),

    item =>
      `${normalizeExtensionName(
        item.providerId
      )}:${item.sourceId || item.id}`
  );
}

/* ============================================================
   PROVIDERS API
============================================================ */

app.get(
  "/api/providers",
  (req, res) => {
    const result =
      [
        ...providers.values()
      ].map(
        provider => ({
          id:
            provider.id,

          name:
            provider.name,

          type:
            provider.type ||
            "provider",

          cloudstream:
            false,

          playable:
            typeof provider.sources ===
              "function" ||
            typeof provider.load ===
              "function"
        })
      );

    if (BRIDGE_URL) {
      for (
        const extension of
          getEnabledExtensions()
      ) {
        result.push({
          id:
            extension.id,

          name:
            extension.name,

          internalName:
            extension.internalName,

          type:
            "cloudstream",

          cloudstream:
            true,

          playable:
            true,

          extension
        });
      }
    }

    res.json({
      ok:
        true,

      providers:
        result
    });
  }
);

/* ============================================================
   EXTENSIONS API
============================================================ */

app.get(
  "/api/extensions",
  (req, res) => {
    const enabled =
      new Set(
        getEnabledExtensions()
          .map(
            extension =>
              extension.id
          )
      );

    const extensions =
      Array.isArray(
        extensionState.extensions
      )
        ? extensionState.extensions
        : [];

    res.json({
      ok:
        true,

      updatedAt:
        extensionState.updatedAt,

      repositories:
        extensionState.repositories,

      count:
        extensions.length,

      enabledCount:
        enabled.size,

      bridgeConfigured:
        Boolean(BRIDGE_URL),

      bridgeUrl:
        BRIDGE_URL ||
        null,

      extensions:
        extensions.map(
          extension => ({
            ...extension,

            enabled:
              enabled.has(
                extension.id
              ),

            pluginUrl:
              extension.pluginUrl ||
              extension.url
          })
        )
    });
  }
);

/* ============================================================
   EXTENSION SYNC
============================================================ */

app.post(
  "/api/extensions/sync",
  async (req, res) => {
    try {
      const state =
        await syncExtensions();

      res.json({
        ok:
          true,

        updatedAt:
          state.updatedAt,

        repositories:
          state.repositories,

        extensions:
          state.extensions,

        enabledExtensions:
          state.enabledExtensions
      });
    } catch (
      error
    ) {
      console.error(
        "[Extensions Sync]",
        error
      );

      res.status(500).json({
        ok:
          false,

        error:
          error.message
      });
    }
  }
);

/* ============================================================
   SEARCH API
============================================================ */

app.get(
  "/api/search",
  async (req, res) => {
    const query =
      safeString(
        req.query.q
      );

    if (!query) {
      return res.status(400).json({
        ok:
          false,

        error:
          "Query is required"
      });
    }

    try {
      const results =
        await searchAllProviders(
          query,
          {
            type:
              safeString(
                req.query.type,
                "all"
              ),

            limit:
              Math.min(
                toPositiveInt(
                  req.query.limit,
                  50
                ),
                MAX_RESULTS
              )
          }
        );

      mergeIntoLibrary(
        results
      );

      res.json({
        ok:
          true,

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
      });
    } catch (
      error
    ) {
      console.error(
        "[Search]",
        error
      );

      res.status(502).json({
        ok:
          false,

        error:
          error.message
      });
    }
  }
);

/* ============================================================
   LIBRARY API
============================================================ */

app.get(
  "/api/library",
  async (req, res) => {
    const refresh =
      req.query.refresh ===
      "true";

    if (
      refresh ||
      mediaLibrary.length === 0
    ) {
      try {
        const home =
          await homeAllProviders({
            limit:
              MAX_RESULTS
          });

        mergeIntoLibrary(
          home
        );
      } catch (
        error
      ) {
        console.error(
          `[Library] ${error.message}`
        );
      }
    }

    const type =
      safeString(
        req.query.type,
        "all"
      ).toLowerCase();

    const results =
      type === "all"
        ? mediaLibrary
        : mediaLibrary.filter(
            item =>
              item.type ===
              type
          );

    res.json({
      ok:
        true,

      count:
        results.length,

      updatedAt:
        extensionState.updatedAt,

      results
    });
  }
);

/* ============================================================
   FULL SYNC
============================================================ */

app.post(
  "/api/sync",
  async (req, res) => {
    try {
      const state =
        await syncExtensions();

      const home =
        await homeAllProviders({
          limit:
            MAX_RESULTS
        });

      mergeIntoLibrary(
        home
      );

      res.json({
        ok:
          true,

        extensions:
          state.extensions.length,

        enabledExtensions:
          state.enabledExtensions.length,

        library:
          mediaLibrary.length,

        updatedAt:
          now()
      });
    } catch (
      error
    ) {
      console.error(
        "[Sync]",
        error
      );

      res.status(502).json({
        ok:
          false,

        error:
          error.message
      });
    }
  }
);

/* ============================================================
   TITLE
============================================================ */

function findLibraryItem(
  id
) {
  return (
    mediaLibrary.find(
      item =>
        item.id ===
        id
    ) ||
    null
  );
}

async function loadItem(
  item
) {
  const cloudstreamExtension =
    findExtension(
      item.providerId
    ) ||
    findExtension(
      item.providerName
    );

  if (
    BRIDGE_URL &&
    cloudstreamExtension
  ) {
    return bridgeLoad(
      item
    );
  }

  const provider =
    providers.get(
      item.providerId
    );

  if (
    provider &&
    typeof provider.load ===
      "function"
  ) {
    return normalizeMediaItem(
      await provider.load(
        item
      )
    );
  }

  return item;
}

app.get(
  "/api/title/:id",
  async (req, res) => {
    const item =
      findLibraryItem(
        safeString(
          req.params.id
        )
      );

    if (!item) {
      return res.status(404).json({
        ok:
          false,

        error:
          "Title not found"
      });
    }

    try {
      const loaded =
        await loadItem(
          item
        );

      mergeIntoLibrary([
        loaded
      ]);

      res.json({
        ok:
          true,

        item:
          loaded
      });
    } catch (
      error
    ) {
      console.error(
        `[Title] ${error.message}`
      );

      res.status(502).json({
        ok:
          false,

        error:
          error.message
      });
    }
  }
);

/* ============================================================
   SOURCES
============================================================ */

app.get(
  "/api/sources/:id",
  async (req, res) => {
    const item =
      findLibraryItem(
        safeString(
          req.params.id
        )
      );

    if (!item) {
      return res.status(404).json({
        ok:
          false,

        error:
          "Title not found"
      });
    }

    try {
      const cloudstreamExtension =
        findExtension(
          item.providerId
        ) ||
        findExtension(
          item.providerName
        );

      if (
        BRIDGE_URL &&
        cloudstreamExtension
      ) {
        const loaded =
          await bridgeLoad(
            item
          );

        let data =
          safeString(
            req.query.data
          ) ||
          safeString(
            loaded?.data
          );

        /*
         * TV/anime data is normally stored
         * on the selected episode.
         */
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

          let selected =
            loaded.episodes[0];

          if (
            Number.isFinite(
              season
            ) &&
            Number.isFinite(
              episode
            )
          ) {
            selected =
              loaded.episodes.find(
                entry =>
                  Number(
                    entry?.season
                  ) === season &&
                  Number(
                    entry?.episode
                  ) === episode
              ) ||
              selected;
          }

          data =
            safeString(
              selected?.data
            );
        }

        if (!data) {
          data =
            safeString(
              item.data
            );
        }

        if (!data) {
          throw new Error(
            "CloudStream LoadResponse data is missing"
          );
        }

        const sources =
          await bridgeSources(
            loaded ||
              item,
            data
          );

        if (!sources.length) {
          throw new Error(
            "CloudStream returned no playable sources"
          );
        }

        return res.json({
          ok:
            true,

          provider:
            loaded.providerName ||
            item.providerName,

          sources
        });
      }

      /*
       * Native provider fallback.
       */
      const provider =
        providers.get(
          item.providerId
        );

      if (
        provider &&
        typeof provider.sources ===
          "function"
      ) {
        const sources =
          await provider.sources(
            item
          );

        return res.json({
          ok:
            true,

          provider:
            provider.name,

          sources:
            normalizeSources(
              sources,
              item
            )
        });
      }

      if (
        provider &&
        typeof provider.load ===
          "function"
      ) {
        const loaded =
          await provider.load(
            item
          );

        return res.json({
          ok:
            true,

          provider:
            provider.name,

          sources:
            normalizeSources(
              loaded?.sources,
              item
            )
        });
      }

      return res.json({
        ok:
          true,

        provider:
          item.providerName,

        sources:
          []
      });
    } catch (
      error
    ) {
      console.error(
        `[Sources] ${error.message}`
      );

      res.status(502).json({
        ok:
          false,

        error:
          error.message,

        provider:
          item.providerName,

        sourceId:
          item.sourceId
      });
    }
  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/api/health",
  (req, res) => {
    const extensions =
      Array.isArray(
        extensionState.extensions
      )
        ? extensionState.extensions
        : [];

    const enabled =
      getEnabledExtensions();

    res.json({
      ok:
        true,

      service:
        "Mediav2",

      version:
        "2.0.0",

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
          BRIDGE_TIMEOUT_MS
      },

      extensions: {
        discovered:
          extensions.length,

        enabled:
          enabled.length,

        enabledNames:
          enabled.map(
            extension =>
              extension.name
          ),

        updatedAt:
          extensionState.updatedAt
      },

      providers:
        [
          ...providers.keys()
        ],

      library:
        mediaLibrary.length,

      timestamp:
        now()
    });
  }
);

/* ============================================================
   ROOT
============================================================ */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      `[HTTP] ${error.message}`
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(400).json({
      ok:
        false,

      error:
        error.message ||
        "Bad request"
    });
  }
);

/* ============================================================
   404
============================================================ */

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        ok:
          false,

        error:
          "API endpoint not found"
      });
    }

    res.status(404).send(
      "Mediav2: page not found"
    );
  }
);

/* ============================================================
   STARTUP
============================================================ */

let lastExtensionSync =
  0;

async function ensureExtensionSync() {
  await syncExtensions();

  lastExtensionSync =
    Date.now();

  return extensionState;
}

async function refreshLibrary() {
  try {
    const home =
      await homeAllProviders({
        limit:
          MAX_RESULTS
      });

    mergeIntoLibrary(
      home
    );
  } catch (
    error
  ) {
    console.error(
      `[Library Refresh] ${error.message}`
    );
  }
}

async function startupSync() {
  console.log(
    "=============================================="
  );

  console.log(
    `[Startup] Mediav2 on port ${PORT}`
  );

  console.log(
    `[Startup] CloudStream bridge: ${
      BRIDGE_URL ||
      "disabled"
    }`
  );

  try {
    await ensureExtensionSync();

    await refreshLibrary();

    console.log(
      `[Startup] Library: ${mediaLibrary.length} items`
    );

    console.log(
      `[Startup] Enabled CloudStream extensions: ${
        getEnabledExtensions()
          .map(
            extension =>
              extension.name
          )
          .join(", ") ||
        "none"
      }`
    );
  } catch (
    error
  ) {
    console.error(
      `[Startup] ${error.message}`
    );
  }

  console.log(
    "=============================================="
  );
}

/* ============================================================
   SCHEDULED SYNC
============================================================ */

setInterval(
  async () => {
    const interval =
      EXTENSION_SYNC_HOURS *
      60 *
      60 *
      1000;

    if (
      Date.now() -
        lastExtensionSync <
      interval
    ) {
      return;
    }

    try {
      console.log(
        "[Scheduled Sync] Starting..."
      );

      await ensureExtensionSync();

      await refreshLibrary();

      console.log(
        "[Scheduled Sync] Complete."
      );
    } catch (
      error
    ) {
      console.error(
        `[Scheduled Sync] ${error.message}`
      );
    }
  },
  15 * 60 * 1000
).unref();

/* ============================================================
   SERVER
============================================================ */

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `Mediav2 listening on port ${PORT}`
      );

      startupSync();
    }
  );

/* ============================================================
   SHUTDOWN
============================================================ */

function shutdown(
  signal
) {
  console.log(
    `[Process] ${signal} received`
  );

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(1);
    },
    10000
  ).unref();
}

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "[Process] Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[Process] Uncaught exception:",
      error
    );

    process.exit(1);
  }
);
