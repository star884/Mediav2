const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

/* ============================================================
   CONFIG
============================================================ */

const PORT =
  Number(process.env.PORT || 3000);

const DATA_DIR =
  path.join(__dirname, "data");

const CACHE_FILE =
  path.join(DATA_DIR, "cache.json");

const EXTENSIONS_FILE =
  path.join(DATA_DIR, "extensions.json");

const CACHE_TTL_MS =
  Number(process.env.CACHE_TTL_HOURS || 6) *
  60 *
  60 *
  1000;

const REQUEST_TIMEOUT_MS =
  Number(
    process.env.REQUEST_TIMEOUT_MS || 20000
  );

const EXTENSION_SYNC_HOURS =
  Number(
    process.env.EXTENSION_SYNC_HOURS || 6
  );

/*
 * Mediav2 and the JVM CloudStream runtime run
 * inside the same container.
 *
 * The runtime listens on 10001 by default.
 */
const BRIDGE_URL =
  (
    process.env.CLOUDSTREAM_BRIDGE_URL ||
    "http://127.0.0.1:10001"
  ).replace(/\/+$/, "");

/*
 * CloudStream operations can legitimately take
 * considerably longer than normal HTTP requests.
 */
const BRIDGE_TIMEOUT_MS =
  Number(
    process.env.CLOUDSTREAM_BRIDGE_TIMEOUT_MS ||
    130000
  );

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mediav2/2.0 (+https://github.com/star884/Mediav2)";

fs.mkdirSync(
  DATA_DIR,
  { recursive: true }
);

app.use(cors());

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* ============================================================
   HELPERS
============================================================ */

function now() {
  return new Date().toISOString();
}

function safeString(
  value,
  fallback = ""
) {
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

function uniqueBy(
  items,
  keyFn
) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function normalizeUrl(
  value,
  baseUrl = null
) {
  if (!value) {
    return null;
  }

  try {
    const url = baseUrl
      ? new URL(value, baseUrl)
      : new URL(value);

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

function readJson(
  file,
  fallback
) {
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
      `[Storage] Failed reading ${file}:`,
      error.message
    );

    return fallback;
  }
}

function writeJson(
  file,
  value
) {
  const temporary =
    `${file}.tmp`;

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

function mimeForFormat(
  format
) {
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

function extractQuality(
  value
) {
  const match =
    safeString(value).match(
      /(?:^|[._\-\s])(2160|1440|1080|720|576|480|360)p?(?:[._\-\s]|$)/i
    );

  return match
    ? `${match[1]}p`
    : "Unknown";
}

async function fetchJson(
  url,
  options = {}
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            options.method ||
            "GET",

          headers: {
            Accept:
              "application/json",

            "User-Agent":
              USER_AGENT,

            ...(options.headers || {})
          },

          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(
                  options.body
                ),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        `Request timed out after ${
          options.timeout ||
          REQUEST_TIMEOUT_MS
        }ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ============================================================
   MEDIA NORMALIZATION
============================================================ */

function normalizeMediaItem(
  item
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
      safeString(
        item.id
      )
    );

  const title =
    safeString(
      item.title,
      "Untitled"
    );

  const type =
    safeString(
      item.type,
      "unknown"
    ).toLowerCase();

  const id =
    safeString(
      item.id
    ) ||
    hash(
      `${providerId}:${sourceId}:${title}`
    );

  const sourceUrl =
    normalizeUrl(
      item.sourceUrl ||
      item.url ||
      item.link
    );

  const poster =
    normalizeUrl(
      item.poster ||
      item.posterUrl ||
      item.image
    );

  const backdrop =
    normalizeUrl(
      item.backdrop ||
      item.backdropUrl
    );

  return {
    id,

    providerId,

    providerName,

    sourceId,

    sourceUrl,

    title,

    originalTitle:
      safeString(
        item.originalTitle,
        title
      ),

    type,

    year:
      Number.isFinite(
        Number(item.year)
      )
        ? Number(item.year)
        : null,

    poster,

    backdrop,

    description:
      safeString(
        item.description
      ),

    rating:
      item.rating ?? null,

    duration:
      item.duration ?? null,

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
      item.season ?? null,

    episode:
      item.episode ?? null,

    /*
     * IMPORTANT:
     * CloudStream's LoadResponse data is needed
     * by loadLinks().
     */
    data:
      safeString(
        item.data
      ) || null,

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

function mergeIntoLibrary(
  items
) {
  const normalized =
    items
      .map(
        normalizeMediaItem
      )
      .filter(
        item =>
          item.title &&
          item.title !==
            "Untitled"
      );

  mediaLibrary =
    uniqueBy(
      [
        ...normalized,
        ...mediaLibrary
      ],
      item =>
        `${item.providerId}:${item.sourceId || item.id}`
    );

  writeJson(
    CACHE_FILE,
    mediaLibrary
  );

  return normalized;
}

/* ============================================================
   PROVIDER SYSTEM
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
        Number(
          options.limit || 40
        ),
        100
      );

    const params =
      new URLSearchParams({
        q:
          `title:(${q}) AND mediatype:movies`,

        fl:
          [
            "identifier",
            "title",
            "description",
            "creator",
            "year",
            "date"
          ].join(","),

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

    const docs =
      data?.response?.docs;

    if (
      !Array.isArray(docs)
    ) {
      return [];
    }

    return docs.map(
      doc =>
        normalizeMediaItem({
          providerId:
            this.id,

          providerName:
            this.name,

          id:
            safeString(
              doc.identifier
            ),

          sourceId:
            safeString(
              doc.identifier
            ),

          sourceUrl:
            `https://archive.org/details/${encodeURIComponent(
              safeString(
                doc.identifier
              )
            )}`,

          title:
            safeString(
              doc.title,
              doc.identifier
            ),

          description:
            safeString(
              doc.description
            ),

          year:
            Number.isFinite(
              Number(doc.year)
            )
              ? Number(
                  doc.year
                )
              : null,

          type:
            "movie"
        })
    );
  },

  async home(
    options = {}
  ) {
    const params =
      new URLSearchParams({
        q:
          "mediatype:movies",

        fl:
          "identifier,title,description,year,date",

        rows:
          String(
            Math.min(
              Number(
                options.limit || 40
              ),
              100
            )
          ),

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

    const docs =
      data?.response?.docs;

    if (
      !Array.isArray(docs)
    ) {
      return [];
    }

    return docs.map(
      doc =>
        normalizeMediaItem({
          providerId:
            this.id,

          providerName:
            this.name,

          id:
            safeString(
              doc.identifier
            ),

          sourceId:
            safeString(
              doc.identifier
            ),

          sourceUrl:
            `https://archive.org/details/${encodeURIComponent(
              safeString(
                doc.identifier
              )
            )}`,

          title:
            safeString(
              doc.title,
              doc.identifier
            ),

          description:
            safeString(
              doc.description
            ),

          year:
            Number.isFinite(
              Number(doc.year)
            )
              ? Number(
                  doc.year
                )
              : null,

          type:
            "movie"
        })
    );
  },

  async load(
    item
  ) {
    const identifier =
      safeString(
        item.sourceId,
        safeString(
          item.id
        )
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

    const files =
      Array.isArray(
        metadata?.files
      )
        ? metadata.files
        : [];

    const sources =
      files
        .map(
          file => {
            const name =
              safeString(
                file.name
              );

            if (!name) {
              return null;
            }

            const lower =
              name.toLowerCase();

            let format;

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
                )}/${name}`,

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
          }
        )
        .filter(Boolean);

    return {
      ...normalizeMediaItem({
        providerId:
          this.id,

        providerName:
          this.name,

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
            metadata?.metadata?.title,
            identifier
          ),

        description:
          safeString(
            metadata?.metadata?.description
          ),

        type:
          "movie"
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

    return loaded.sources ||
      [];
  }
};

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

function normalizeExtensionName(
  value
) {
  return safeString(value)
    .toLowerCase()
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

function extensionMatches(
  extension,
  requested
) {
  const requestedName =
    normalizeExtensionName(
      requested
    );

  const values = [
    extension.name,
    extension.internalName
  ]
    .filter(Boolean)
    .map(
      normalizeExtensionName
    );

  if (
    values.includes(
      requestedName
    )
  ) {
    return true;
  }

  const aliases =
    EXTENSION_ALIASES[
      requestedName
    ] || [];

  return aliases.some(
    alias =>
      values.includes(
        normalizeExtensionName(
          alias
        )
      )
  );
}

function getConfiguredRepositories() {
  const configured =
    safeString(
      process.env
        .CLOUDSTREAM_REPOSITORIES
    );

  if (!configured) {
    return DEFAULT_CLOUDSTREAM_REPOSITORIES;
  }

  return configured
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
          `custom-${index + 1}-${hash(url)}`,

        name:
          `CloudStream Repository ${index + 1}`,

        url
      })
    );
}

function normalizeExtension(
  plugin,
  repository,
  pluginListUrl
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
      plugin.url,
      pluginListUrl ||
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
        plugin.iconUrl,
        pluginListUrl ||
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
        : safeString(
            plugin.language
          )
          ? [
              plugin.language
            ]
          : [],

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

async function syncOneRepository(
  repository
) {
  const repoManifest =
    await fetchJson(
      repository.url
    );

  const extensions =
    [];

  /*
   * Some repositories expose plugins directly.
   */
  for (
    const plugin of
      extractPlugins(
        repoManifest
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

  /*
   * Standard CloudStream format:
   *
   * repo.json
   *    |
   *    +-- pluginLists[]
   *            |
   *            +-- plugins.json
   */
  const pluginLists =
    Array.isArray(
      repoManifest?.pluginLists
    )
      ? repoManifest.pluginLists
      : [];

  for (
    const pluginList
      of pluginLists
  ) {
    const pluginListUrl =
      normalizeUrl(
        pluginList,
        repository.url
      );

    if (!pluginListUrl) {
      continue;
    }

    try {
      const pluginManifest =
        await fetchJson(
          pluginListUrl
        );

      for (
        const plugin of
          extractPlugins(
            pluginManifest
          )
      ) {
        const extension =
          normalizeExtension(
            plugin,
            repository,
            pluginListUrl
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
      console.error(
        `[Extensions] Failed ${pluginListUrl}:`,
        error.message
      );
    }
  }

  return {
    repository: {
      ...repository,

      status:
        "online",

      manifestVersion:
        repoManifest?.manifestVersion ??
        null,

      description:
        safeString(
          repoManifest?.description
        ),

      pluginLists,

      checkedAt:
        now()
    },

    extensions
  };
}

async function syncExtensions() {
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
            `[Extensions] ${repository.name}: ` +
            `${result.extensions.length} extensions`
          );
        } catch (
          error
        ) {
          console.error(
            `[Extensions] ${repository.name}:`,
            error.message
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

  const enabled =
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

    enabledExtensions:
      enabled
  };

  writeJson(
    EXTENSIONS_FILE,
    extensionState
  );

  console.log(
    `[Extensions] ${extensions.length} discovered; ` +
    `${enabled.length} requested/enabled.`
  );

  for (
    const requested
      of REQUESTED_EXTENSIONS
  ) {
    const matches =
      enabled.filter(
        extension =>
          extensionMatches(
            extension,
            requested
          )
      );

    if (
      matches.length
    ) {
      console.log(
        `[Extensions] ${requested}: ` +
        matches
          .map(
            extension =>
              extension.name
          )
          .join(", ")
      );
    } else {
      console.warn(
        `[Extensions] ${requested}: NOT FOUND`
      );
    }
  }

  return extensionState;
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
      "CLOUDSTREAM_BRIDGE_URL is not configured"
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
        BRIDGE_TIMEOUT_MS,

      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );
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
        normalizeExtensionName(
          extension.name
        ) === target ||
        normalizeExtensionName(
          extension.internalName
        ) === target ||
        normalizeExtensionName(
          extension.id
        ) === target
    ) || null;
}

/* ============================================================
   CLOUDSTREAM SEARCH
============================================================ */

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

        extensions:
          getEnabledExtensions()
      }
    );

  const results =
    Array.isArray(result)
      ? result
      : Array.isArray(
          result?.results
        )
        ? result.results
        : [];

  return results
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

/* ============================================================
   CLOUDSTREAM HOME
============================================================ */

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
            Number(
              options.limit || 100
            ),
            200
          ),

        extensions:
          getEnabledExtensions()
      }
    );

  const results =
    Array.isArray(result)
      ? result
      : Array.isArray(
          result?.items
        )
        ? result.items
        : [];

  return results
    .map(
      normalizeBridgeResult
    )
    .filter(Boolean);
}

/* ============================================================
   CLOUDSTREAM LOAD
============================================================ */

async function bridgeLoad(
  item
) {
  const extension =
    findExtension(
      item.providerId
    ) ||
    findExtension(
      item.providerName
    ) ||
    null;

  const result =
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
          item.url ||
          null
      }
    );

  return normalizeBridgeLoad(
    result,
    item
  );
}

/* ============================================================
   CLOUDSTREAM SOURCES
============================================================ */

async function bridgeSources(
  item,
  data = null
) {
  const extension =
    findExtension(
      item.providerId
    ) ||
    findExtension(
      item.providerName
    ) ||
    null;

  const result =
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
          item.url ||
          null,

        /*
         * This is the important CloudStream
         * LoadResponse data passed to loadLinks().
         */
        data:
          data ||
          item.data ||
          null
      }
    );

  return normalizeBridgeSources(
    result,
    item
  );
}

/* ============================================================
   BRIDGE RESULT NORMALIZATION
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

  /*
   * The runtime may return:
   *
   * provider: "CineStream"
   *
   * or:
   *
   * provider: {
   *   id: "...",
   *   name: "CineStream"
   * }
   *
   * or explicit providerName/providerId.
   */
  const providerName =
    safeString(
      result.providerName,
      safeString(
        typeof result.provider === "object"
          ? result.provider?.name
          : result.provider,
        "CloudStream"
      )
    );

  const providerId =
    safeString(
      result.providerId,
      safeString(
        typeof result.provider === "object"
          ? result.provider?.id
          : null,
        providerName
      )
    );

  const sourceUrl =
    normalizeUrl(
      result.sourceUrl ||
      result.url ||
      result.link
    );

  return normalizeMediaItem({
    ...result,

    providerId,

    providerName,

    sourceUrl,

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
   BRIDGE LOAD NORMALIZATION
============================================================ */

function normalizeBridgeLoad(
  result,
  originalItem
) {
  if (
    !result ||
    typeof result !==
      "object"
  ) {
    return normalizeMediaItem(
      originalItem
    );
  }

  const item =
    normalizeBridgeResult({
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
    });

  /*
   * Preserve CloudStream's actual LoadResponse data.
   */
  if (
    safeString(
      result.data
    )
  ) {
    item.data =
      result.data;
  }

  /*
   * Preserve source lists returned by
   * the runtime, if present.
   */
  if (
    Array.isArray(
      result.sources
    )
  ) {
    item.sources =
      normalizeSources(
        result.sources,
        item
      );
  }

  /*
   * Preserve episodes exactly enough for
   * the frontend to request a particular
   * episode's data.
   */
  if (
    Array.isArray(
      result.episodes
    )
  ) {
    item.episodes =
      result.episodes.map(
        episode => ({
          ...episode,

          data:
            safeString(
              episode?.data
            ) || null,

          season:
            episode?.season ??
            null,

          episode:
            episode?.episode ??
            null,

          name:
            safeString(
              episode?.name,
              safeString(
                episode?.title,
                "Episode"
              )
            ),

          poster:
            normalizeUrl(
              episode?.poster ||
              episode?.posterUrl
            )
        })
      );
  }

  if (
    Array.isArray(
      result.seasons
    )
  ) {
    item.seasons =
      result.seasons;
  }

  return item;
}

/* ============================================================
   SOURCE NORMALIZATION
============================================================ */

function normalizeSources(
  sources,
  parent
) {
  if (
    !Array.isArray(
      sources
    )
  ) {
    return [];
  }

  return uniqueBy(
    sources
      .map(
        source => {
          if (
            typeof source ===
              "string"
          ) {
            const url =
              normalizeUrl(
                source
              );

            if (!url) {
              return null;
            }

            return {
              id:
                hash(url),

              title:
                source,

              url,

              format:
                /\\.m3u8(?:$|\\?)/i.test(
                  url
                )
                  ? "hls"
                  : "",

              mime:
                /\\.m3u8(?:$|\\?)/i.test(
                  url
                )
                  ? "application/vnd.apple.mpegurl"
                  : null,

              quality:
                extractQuality(
                  source
                ),

              providerId:
                parent.providerId,

              providerName:
                parent.providerName
            };
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

          if (!format) {
            if (
              /\\.m3u8(?:$|\\?)/i.test(
                url
              )
            ) {
              format =
                "hls";
            } else if (
              /\\.mpd(?:$|\\?)/i.test(
                url
              )
            ) {
              format =
                "dash";
            }
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
              ) || undefined,

            subtitles:
              Array.isArray(
                source.subtitles
              )
                ? source.subtitles
                : [],

            isM3u8:
              /\\.m3u8(?:$|\\?)/i.test(
                url
              ),

            isDash:
              /\\.mpd(?:$|\\?)/i.test(
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
  const sources =
    Array.isArray(result)
      ? result
      : Array.isArray(
          result?.sources
        )
        ? result.sources
        : [];

  return normalizeSources(
    sources,
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
      `[Provider:${provider.id}] Search failed:`,
      error.message
    );

    return [];
  }
}

async function searchAllProviders(
  query,
  options = {}
) {
  const tasks =
    [];

  /*
   * Native providers.
   */
  for (
    const provider of
      providers.values()
  ) {
    tasks.push(
      searchProvider(
        provider,
        query,
        options
      )
    );
  }

  /*
   * Actual CloudStream JVM runtime.
   */
  if (BRIDGE_URL) {
    tasks.push(
      bridgeSearch(
        query,
        options
      ).catch(
        error => {
          console.error(
            "[CloudStream Search]",
            error.message
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

  const merged =
    results
      .flat()
      .filter(Boolean);

  return uniqueBy(
    merged,
    item =>
      `${normalizeExtensionName(
        item.providerId
      )}:${slug(
        item.title
      )}:${item.sourceId || item.id}`
  );
}

/* ============================================================
   HOME AGGREGATION
============================================================ */

async function homeAllProviders(
  options = {}
) {
  const tasks =
    [];

  for (
    const provider of
      providers.values()
  ) {
    if (
      typeof provider.home !==
      "function"
    ) {
      continue;
    }

    tasks.push(
      (async () => {
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
            `[Provider:${provider.id}] Home failed:`,
            error.message
          );

          return [];
        }
      })()
    );
  }

  if (BRIDGE_URL) {
    tasks.push(
      bridgeHome(
        options
      ).catch(
        error => {
          console.error(
            "[CloudStream Home]",
            error.message
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
   PROVIDER API
============================================================ */

app.get(
  "/api/providers",
  (req, res) => {
    const result =
      [];

    for (
      const provider of
        providers.values()
    ) {
      result.push({
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
      });
    }

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

    res.json({
      ok:
        true,

      updatedAt:
        extensionState.updatedAt,

      repositories:
        extensionState.repositories,

      count:
        Array.isArray(
          extensionState.extensions
        )
          ? extensionState.extensions.length
          : 0,

      enabledCount:
        enabled.size,

      bridgeConfigured:
        Boolean(
          BRIDGE_URL
        ),

      bridgeUrl:
        BRIDGE_URL,

      extensions:
        (
          Array.isArray(
            extensionState.extensions
          )
            ? extensionState.extensions
            : []
        ).map(
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
   SEARCH
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
                Number(
                  req.query.limit ||
                  50
                ),
                100
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
   LIBRARY
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
              100
          });

        if (
          home.length
        ) {
          mergeIntoLibrary(
            home
          );
        }
      } catch (
        error
      ) {
        console.error(
          "[Library]",
          error.message
        );
      }
    }

    const type =
      safeString(
        req.query.type,
        "all"
      ).toLowerCase();

    let results =
      mediaLibrary;

    if (
      type !== "all"
    ) {
      results =
        results.filter(
          item =>
            item.type ===
            type
        );
    }

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
   SYNC EVERYTHING
============================================================ */

app.post(
  "/api/sync",
  async (req, res) => {
    try {
      const extensions =
        await syncExtensions();

      const home =
        await homeAllProviders({
          limit:
            100
        });

      if (
        home.length
      ) {
        mergeIntoLibrary(
          home
        );
      }

      res.json({
        ok:
          true,

        extensions:
          extensions.extensions.length,

        enabledExtensions:
          extensions.enabledExtensions.length,

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
   TITLE
============================================================ */

app.get(
  "/api/title/:id",
  async (req, res) => {
    const id =
      safeString(
        req.params.id
      );

    const item =
      mediaLibrary.find(
        candidate =>
          candidate.id ===
          id
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
      /*
       * CloudStream gets first priority.
       */
      if (
        BRIDGE_URL &&
        item.providerId
      ) {
        try {
          const loaded =
            await bridgeLoad(
              item
            );

          if (
            loaded
          ) {
            /*
             * Update the cached item with
             * CloudStream's LoadResponse data.
             */
            mergeIntoLibrary([
              loaded
            ]);

            return res.json({
              ok:
                true,

              item:
                loaded
            });
          }
        } catch (
          error
        ) {
          console.error(
            "[CloudStream Load]",
            error.message
          );
        }
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

          item:
            normalizeBridgeLoad(
              loaded,
              item
            )
        });
      }

      return res.json({
        ok:
          true,

        item
      });
    } catch (
      error
    ) {
      console.error(
        "[Title]",
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
   SOURCES
============================================================ */

app.get(
  "/api/sources/:id",
  async (req, res) => {
    const id =
      safeString(
        req.params.id
      );

    const item =
      mediaLibrary.find(
        candidate =>
          candidate.id ===
          id
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
      /*
       * ======================================================
       * CLOUDSTREAM
       *
       * CloudStream's loadLinks() requires the
       * LoadResponse data string.
       *
       * Therefore:
       *
       * 1. Load the title.
       * 2. Select the requested episode if applicable.
       * 3. Extract episode.data.
       * 4. Pass that data to /sources.
       * ======================================================
       */
      if (
        BRIDGE_URL &&
        item.providerId
      ) {
        try {
          let loaded =
            null;

          try {
            loaded =
              await bridgeLoad(
                item
              );
          } catch (
            loadError
          ) {
            console.error(
              "[CloudStream Load Before Sources]",
              loadError.message
            );
          }

          const requestedSeason =
            Number(
              req.query.season
            );

          const requestedEpisode =
            Number(
              req.query.episode
            );

          let data =
            safeString(
              req.query.data
            );

          /*
           * If the frontend supplied the actual
           * CloudStream data, use it directly.
           */
          if (
            !data
          ) {
            data =
              safeString(
                loaded?.data
              );
          }

          /*
           * For TV/anime content, the required
           * data normally lives on the episode.
           */
          if (
            !data &&
            loaded &&
            Array.isArray(
              loaded.episodes
            ) &&
            loaded.episodes.length
          ) {
            let episode =
              loaded.episodes[0];

            if (
              Number.isFinite(
                requestedSeason
              ) &&
              Number.isFinite(
                requestedEpisode
              )
            ) {
              episode =
                loaded.episodes.find(
                  candidate =>
                    Number(
                      candidate?.season
                    ) ===
                      requestedSeason &&
                    Number(
                      candidate?.episode
                    ) ===
                      requestedEpisode
                ) ||
                episode;
            }

            data =
              safeString(
                episode?.data
              );
          }

          /*
           * Finally fall back to the cached
           * item's data.
           */
          if (
            !data
          ) {
            data =
              safeString(
                item.data
              );
          }

          if (
            data
          ) {
            const sourceItem =
              loaded ||
              item;

            const sources =
              await bridgeSources(
                sourceItem,
                data
              );

            /*
             * If the runtime found sources,
             * return them immediately.
             */
            if (
              sources.length
            ) {
              return res.json({
                ok:
                  true,

                provider:
                  sourceItem.providerName ||
                  item.providerName,

                sources
              });
            }

            console.warn(
              "[CloudStream Sources] Runtime returned no sources"
            );
          } else {
            console.warn(
              "[CloudStream Sources] No CloudStream data available"
            );
          }
        } catch (
          error
        ) {
          console.error(
            "[CloudStream Sources]",
            error.message
          );
        }
      }

      /*
       * ======================================================
       * NATIVE PROVIDER FALLBACK
       * ======================================================
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
              loaded?.sources ||
                [],
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
        "[Sources]",
        error
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

      bridge:
        {
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

      extensions:
        {
          discovered:
            Array.isArray(
              extensionState.extensions
            )
              ? extensionState.extensions.length
              : 0,

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

let startupComplete =
  false;

async function startupSync() {
  try {
    console.log(
      "================================================"
    );

    console.log(
      "[Startup] Mediav2 starting"
    );

    console.log(
      `[Startup] CloudStream bridge: ${
        BRIDGE_URL || "disabled"
      }`
    );

    console.log(
      "[Startup] Syncing CloudStream repositories..."
    );

    await syncExtensions();

    lastExtensionSync =
      Date.now();

    /*
     * Populate the library from actual
     * provider home results.
     */
    const home =
      await homeAllProviders({
        limit:
          100
      });

    if (
      home.length
    ) {
      mergeIntoLibrary(
        home
      );
    }

    startupComplete =
      true;

    console.log(
      `[Startup] Library contains ${mediaLibrary.length} items.`
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

    console.log(
      "================================================"
    );
  } catch (
    error
  ) {
    console.error(
      "[Startup Sync]",
      error.message
    );

    /*
     * Keep the HTTP server alive even when
     * an external repository temporarily fails.
     */
    startupComplete =
      true;
  }
}

/* ============================================================
   SCHEDULED EXTENSION SYNC
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
        "[Scheduled Extension Sync] Starting..."
      );

      await syncExtensions();

      lastExtensionSync =
        Date.now();

      /*
       * Refresh the library after extension
       * metadata has been updated.
       */
      const home =
        await homeAllProviders({
          limit:
            100
        });

      if (
        home.length
      ) {
        mergeIntoLibrary(
          home
        );
      }

      console.log(
        "[Scheduled Extension Sync] Complete."
      );
    } catch (
      error
    ) {
      console.error(
        "[Scheduled Extension Sync]",
        error.message
      );
    }
  },
  15 * 60 * 1000
);

/* ============================================================
   SERVER
============================================================ */

app.listen(
  PORT,
  async () => {
    console.log(
      `Mediav2 listening on port ${PORT}`
    );

    await startupSync();
  }
);

/* ============================================================
   PROCESS SAFETY
============================================================ */

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
  }
); 
