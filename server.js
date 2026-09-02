const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const EXTENSIONS_FILE = path.join(DATA_DIR, "extensions.json");

const CACHE_TTL_MS =
  Number(process.env.CACHE_TTL_HOURS || 6) * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS || 15000);

const EXTENSION_SYNC_HOURS =
  Number(process.env.EXTENSION_SYNC_HOURS || 6);

const BRIDGE_URL = (
  process.env.CLOUDSTREAM_BRIDGE_URL || ""
).replace(/\/+$/, "");

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mediav2/2.0 (+https://github.com/star884/Mediav2)";

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ============================================================
   SAFE HELPERS
============================================================ */

function now() {
  return new Date().toISOString();
}

function safeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function slug(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);
}

function uniqueBy(items, keyFn) {
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

function normalizeUrl(value, baseUrl = null) {
  if (!value) return null;

  try {
    const url = baseUrl
      ? new URL(value, baseUrl)
      : new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(options.headers || {})
      },
      body:
        options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(
      `[Storage] Failed reading ${file}:`,
      error.message
    );

    return fallback;
  }
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  fs.renameSync(temp, file);
}

/* ============================================================
   MEDIA LIBRARY
============================================================ */

let mediaLibrary = readJson(CACHE_FILE, []);

if (!Array.isArray(mediaLibrary)) {
  mediaLibrary = [];
}

/*
  Provider contract:

  {
    id,
    name,
    type,
    search(query, options),
    home(options),
    load(id, options),
    sources(id, options)
  }

  A provider is allowed to fail independently.
  One broken provider must never break global search.
*/

const providers = new Map();

function registerProvider(provider) {
  if (!provider || !provider.id) {
    throw new Error("Provider requires an id");
  }

  providers.set(provider.id, provider);
}

/* ============================================================
   INTERNET ARCHIVE
   ============================================================

   This is a real provider using Internet Archive's public APIs.
   It is intentionally used as the built-in provider so the
   application works without pretending that CloudStream .cs3
   files can run inside Node.js.
============================================================ */

const InternetArchiveProvider = {
  id: "internet-archive",
  name: "Internet Archive",
  type: "public-media",

  async search(query, options = {}) {
    const q = safeString(query);

    if (!q) return [];

    const rows = Math.min(
      Number(options.limit || 40),
      100
    );

    const params = new URLSearchParams({
      q: `title:(${q}) AND mediatype:movies`,
      fl: [
        "identifier",
        "title",
        "description",
        "creator",
        "year",
        "date"
      ].join(","),
      rows: String(rows),
      output: "json",
      page: "1"
    });

    const url =
      `https://archive.org/advancedsearch.php?${params}`;

    const data = await fetchJson(url);

    const docs =
      data &&
      data.response &&
      Array.isArray(data.response.docs)
        ? data.response.docs
        : [];

    return docs.map(doc =>
      normalizeMediaItem({
        providerId: this.id,
        providerName: this.name,
        id: safeString(doc.identifier),
        title: safeString(doc.title, doc.identifier),
        type: "movie",
        description: safeString(doc.description),
        poster: null,
        year:
          Number.isFinite(Number(doc.year))
            ? Number(doc.year)
            : null,
        sourceId: safeString(doc.identifier),
        sourceUrl:
          `https://archive.org/details/${encodeURIComponent(
            safeString(doc.identifier)
          )}`
      })
    );
  },

  async home(options = {}) {
    const params = new URLSearchParams({
      q: "mediatype:movies",
      fl: "identifier,title,description,year,date",
      rows: String(Math.min(Number(options.limit || 40), 100)),
      output: "json",
      page: "1",
      sort: "downloads desc"
    });

    const data = await fetchJson(
      `https://archive.org/advancedsearch.php?${params}`
    );

    const docs =
      data &&
      data.response &&
      Array.isArray(data.response.docs)
        ? data.response.docs
        : [];

    return docs.map(doc =>
      normalizeMediaItem({
        providerId: this.id,
        providerName: this.name,
        id: safeString(doc.identifier),
        title: safeString(doc.title, doc.identifier),
        type: "movie",
        description: safeString(doc.description),
        poster: null,
        year:
          Number.isFinite(Number(doc.year))
            ? Number(doc.year)
            : null,
        sourceId: safeString(doc.identifier),
        sourceUrl:
          `https://archive.org/details/${encodeURIComponent(
            safeString(doc.identifier)
          )}`
      })
    );
  },

  async load(item) {
    const identifier =
      safeString(item.sourceId) ||
      safeString(item.id);

    if (!identifier) {
      throw new Error("Missing Internet Archive identifier");
    }

    const metadata = await fetchJson(
      `https://archive.org/metadata/${encodeURIComponent(
        identifier
      )}`
    );

    const files =
      metadata && Array.isArray(metadata.files)
        ? metadata.files
        : [];

    const playable = files
      .map(file => {
        const name = safeString(file.name);

        if (!name) return null;

        const lower = name.toLowerCase();

        let format = null;

        if (
          lower.endsWith(".mp4") ||
          lower.endsWith(".webm") ||
          lower.endsWith(".m3u8")
        ) {
          format = lower.endsWith(".m3u8")
            ? "hls"
            : lower.endsWith(".webm")
              ? "webm"
              : "mp4";
        }

        if (!format) return null;

        return {
          id: hash(`${identifier}:${name}`),
          title: name,
          url:
            `https://archive.org/download/${encodeURIComponent(
              identifier
            )}/${name}`,
          format,
          quality: extractQuality(name),
          mime: mimeForFormat(format)
        };
      })
      .filter(Boolean);

    return {
      ...normalizeMediaItem({
        providerId: this.id,
        providerName: this.name,
        id: identifier,
        title:
          safeString(metadata.metadata?.title) ||
          identifier,
        type: "movie",
        description:
          safeString(metadata.metadata?.description),
        poster: null,
        sourceId: identifier,
        sourceUrl:
          `https://archive.org/details/${encodeURIComponent(
            identifier
          )}`
      }),
      sources: uniqueBy(
        playable,
        source => source.url
      )
    };
  }
};

registerProvider(InternetArchiveProvider);

/* ============================================================
   CLOUDSTREAM EXTENSION REGISTRY
============================================================ */

let extensionState = readJson(
  EXTENSIONS_FILE,
  {
    version: 1,
    updatedAt: null,
    repositories: [],
    extensions: []
  }
);

if (!extensionState || typeof extensionState !== "object") {
  extensionState = {
    version: 1,
    updatedAt: null,
    repositories: [],
    extensions: []
  };
}

/*
  IMPORTANT:

  This registry understands CloudStream's repository format.

  It DOES NOT execute .cs3 files.

  A .cs3 is a compiled CloudStream extension. Its metadata can be
  indexed by Mediav2, but search/load/loadLinks require a
  CloudStream-compatible runtime.

  If CLOUDSTREAM_BRIDGE_URL is configured, the server can delegate
  those operations to that runtime.
*/

function getConfiguredRepositories() {
  const configured = safeString(
    process.env.CLOUDSTREAM_REPOSITORIES
  );

  if (!configured) {
    return [];
  }

  return configured
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map((url, index) => ({
      id: `repository-${index + 1}-${hash(url)}`,
      name: `CloudStream Repository ${index + 1}`,
      url
    }));
}

function normalizeExtension(plugin, repository) {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }

  const name = safeString(
    plugin.name,
    safeString(plugin.internalName, "Unknown Extension")
  );

  const internalName = safeString(
    plugin.internalName,
    name
  );

  const url = normalizeUrl(
    plugin.url,
    repository.url
  );

  if (!url) {
    return null;
  }

  const tvTypes = Array.isArray(plugin.tvTypes)
    ? plugin.tvTypes
    : [];

  const language = Array.isArray(plugin.language)
    ? plugin.language
    : safeString(plugin.language)
      ? [plugin.language]
      : [];

  const authors = Array.isArray(plugin.authors)
    ? plugin.authors
    : safeString(plugin.authors)
      ? [plugin.authors]
      : [];

  return {
    id: hash(
      `${repository.id}:${internalName}:${url}`
    ),
    internalName,
    name,
    url,
    status: safeString(plugin.status, "unknown"),
    version: safeString(plugin.version, "unknown"),
    apiVersion: safeString(
      plugin.apiVersion,
      "unknown"
    ),
    description: safeString(plugin.description),
    repositoryUrl: normalizeUrl(
      plugin.repositoryUrl,
      repository.url
    ),
    iconUrl: normalizeUrl(
      plugin.iconUrl,
      repository.url
    ),
    tvTypes,
    language,
    authors,
    fileSize: plugin.fileSize || null,
    fileHash: safeString(plugin.fileHash),
    repositoryId: repository.id,
    repositoryName: repository.name,
    updatedAt: now()
  };
}

function extractPluginArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  for (const key of [
    "plugins",
    "pluginList",
    "items",
    "extensions"
  ]) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  return [];
}

async function syncOneExtensionRepository(repository) {
  const repoManifest = await fetchJson(repository.url);

  const pluginLists = Array.isArray(
    repoManifest.pluginLists
  )
    ? repoManifest.pluginLists
    : [];

  const repositories = [];
  const extensions = [];

  repositories.push({
    ...repository,
    status: "online",
    manifestVersion:
      repoManifest.manifestVersion || null,
    description:
      safeString(repoManifest.description),
    pluginLists
  });

  /*
    Some manifests expose plugins directly. Support that too.
  */

  const directPlugins =
    extractPluginArray(repoManifest);

  for (const plugin of directPlugins) {
    const normalized = normalizeExtension(
      plugin,
      repository
    );

    if (normalized) {
      extensions.push(normalized);
    }
  }

  for (const pluginListUrl of pluginLists) {
    try {
      const absoluteUrl = normalizeUrl(
        pluginListUrl,
        repository.url
      );

      if (!absoluteUrl) {
        continue;
      }

      const pluginList = await fetchJson(
        absoluteUrl
      );

      for (const plugin of extractPluginArray(
        pluginList
      )) {
        const normalized = normalizeExtension(
          plugin,
          {
            ...repository,
            url: absoluteUrl
          }
        );

        if (normalized) {
          extensions.push(normalized);
        }
      }
    } catch (error) {
      console.error(
        `[Extensions] Failed plugin list ${pluginListUrl}:`,
        error.message
      );
    }
  }

  return {
    repository:
      repositories[0],
    extensions
  };
}

async function syncExtensions() {
  const repositories =
    getConfiguredRepositories();

  if (repositories.length === 0) {
    console.log(
      "[Extensions] No CLOUDSTREAM_REPOSITORIES configured."
    );

    extensionState = {
      version: 1,
      updatedAt: now(),
      repositories: [],
      extensions: []
    };

    writeJson(
      EXTENSIONS_FILE,
      extensionState
    );

    return extensionState;
  }

  const allRepositories = [];
  const allExtensions = [];

  for (const repository of repositories) {
    try {
      const result =
        await syncOneExtensionRepository(
          repository
        );

      allRepositories.push(
        result.repository
      );

      allExtensions.push(
        ...result.extensions
      );

      console.log(
        `[Extensions] ${repository.name}: ` +
        `${result.extensions.length} extensions`
      );
    } catch (error) {
      console.error(
        `[Extensions] ${repository.name} failed:`,
        error.message
      );

      allRepositories.push({
        ...repository,
        status: "offline",
        error: error.message,
        checkedAt: now()
      });
    }
  }

  extensionState = {
    version: 1,
    updatedAt: now(),
    repositories: allRepositories,
    extensions: uniqueBy(
      allExtensions,
      extension => extension.id
    )
  };

  writeJson(
    EXTENSIONS_FILE,
    extensionState
  );

  return extensionState;
}

/* ============================================================
   CLOUDSTREAM BRIDGE
============================================================ */

async function bridgeRequest(
  endpoint,
  body = null
) {
  if (!BRIDGE_URL) {
    throw new Error(
      "CLOUDSTREAM_BRIDGE_URL is not configured"
    );
  }

  const url =
    `${BRIDGE_URL}/${endpoint.replace(/^\/+/, "")}`;

  return fetchJson(url, {
    method: body === null ? "GET" : "POST",
    body
  });
}

async function bridgeSearch(query, options = {}) {
  if (!BRIDGE_URL) {
    return [];
  }

  try {
    const result = await bridgeRequest(
      "/search",
      {
        query,
        type: options.type || "all",
        extensions:
          options.extensions || null
      }
    );

    return Array.isArray(result)
      ? result
      : Array.isArray(result.results)
        ? result.results
        : [];
  } catch (error) {
    console.error(
      "[CloudStream Bridge] Search failed:",
      error.message
    );

    return [];
  }
}

async function bridgeHome(options = {}) {
  if (!BRIDGE_URL) {
    return [];
  }

  try {
    const result = await bridgeRequest(
      "/home",
      {
        type: options.type || "all",
        extensions:
          options.extensions || null,
        limit:
          Number(options.limit || 100)
      }
    );

    return Array.isArray(result)
      ? result
      : Array.isArray(result.items)
        ? result.items
        : [];
  } catch (error) {
    console.error(
      "[CloudStream Bridge] Home failed:",
      error.message
    );

    return [];
  }
}

async function bridgeSources(payload) {
  if (!BRIDGE_URL) {
    throw new Error(
      "CloudStream bridge is not configured"
    );
  }

  return bridgeRequest(
    "/sources",
    payload
  );
}

/* ============================================================
   NORMALIZATION
============================================================ */

function normalizeMediaItem(item) {
  const providerId =
    safeString(item.providerId, "unknown");

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

  return {
    id:
      safeString(item.id) ||
      hash(
        `${providerId}:${sourceId}:${title}`
      ),

    title,
    type:
      safeString(item.type, "unknown"),

    providerId,
    providerName:
      safeString(
        item.providerName,
        providerId
      ),

    description:
      safeString(item.description),

    poster:
      normalizeUrl(item.poster),

    backdrop:
      normalizeUrl(item.backdrop),

    year:
      item.year == null
        ? null
        : Number(item.year) || null,

    sourceId,

    sourceUrl:
      normalizeUrl(item.sourceUrl),

    metadata:
      item.metadata &&
      typeof item.metadata === "object"
        ? item.metadata
        : {},

    updatedAt: now()
  };
}

function normalizeBridgeResult(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return normalizeMediaItem({
    ...item,
    providerId:
      safeString(
        item.providerId,
        safeString(item.provider)
      ),
    providerName:
      safeString(
        item.providerName,
        safeString(item.provider)
      )
  });
}

function extractQuality(name) {
  const match = String(name).match(
    /(2160p|1440p|1080p|720p|480p|360p|4k)/i
  );

  return match
    ? match[1].toUpperCase()
    : "Unknown";
}

function mimeForFormat(format) {
  switch (format) {
    case "hls":
      return "application/x-mpegURL";

    case "webm":
      return "video/webm";

    case "mp4":
    default:
      return "video/mp4";
  }
}

/* ============================================================
   LIBRARY SYNC
============================================================ */

let syncRunning = false;

async function syncLibrary() {
  if (syncRunning) {
    return;
  }

  syncRunning = true;

  try {
    const collected = [];

    /*
      Provider home/catalogue
    */

    for (const provider of providers.values()) {
      if (typeof provider.home !== "function") {
        continue;
      }

      try {
        const items =
          await provider.home({
            limit: 50
          });

        for (const item of items) {
          const normalized =
            normalizeMediaItem(item);

          if (normalized) {
            collected.push(normalized);
          }
        }
      } catch (error) {
        console.error(
          `[Library] ${provider.name} failed:`,
          error.message
        );
      }
    }

    /*
      CloudStream bridge catalogue.
    */

    const bridgeItems =
      await bridgeHome({
        limit: 100
      });

    for (const item of bridgeItems) {
      const normalized =
        normalizeBridgeResult(item);

      if (normalized) {
        collected.push(normalized);
      }
    }

    mediaLibrary = uniqueBy(
      collected,
      item =>
        `${item.providerId}:${item.sourceId}:${item.title}`
    );

    writeJson(
      CACHE_FILE,
      mediaLibrary
    );

    console.log(
      `[Library] Synchronised ${mediaLibrary.length} titles.`
    );
  } finally {
    syncRunning = false;
  }
}

/* ============================================================
   GLOBAL SEARCH
============================================================ */

async function searchAllProviders(
  query,
  options = {}
) {
  const results = [];

  const providerTasks =
    [...providers.values()]
      .filter(
        provider =>
          typeof provider.search === "function"
      )
      .map(async provider => {
        try {
          const items =
            await provider.search(
              query,
              options
            );

          for (const item of items) {
            const normalized =
              normalizeMediaItem(item);

            if (normalized) {
              results.push(normalized);
            }
          }
        } catch (error) {
          console.error(
            `[Search] ${provider.name} failed:`,
            error.message
          );
        }
      });

  await Promise.allSettled(
    providerTasks
  );

  const bridgeResults =
    await bridgeSearch(
      query,
      options
    );

  for (const item of bridgeResults) {
    const normalized =
      normalizeBridgeResult(item);

    if (normalized) {
      results.push(normalized);
    }
  }

  const deduped = uniqueBy(
    results,
    item =>
      `${item.providerId}:${item.sourceId}:${item.title}`
  );

  /*
    Search results become part of the local library.

    This is what makes the library grow when users search.
  */

  const merged = uniqueBy(
    [
      ...mediaLibrary,
      ...deduped
    ],
    item =>
      `${item.providerId}:${item.sourceId}:${item.title}`
  );

  mediaLibrary = merged;

  writeJson(
    CACHE_FILE,
    mediaLibrary
  );

  return deduped;
}

/* ============================================================
   API
============================================================ */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mediav2",
    time: now(),
    providers: providers.size,
    extensions:
      extensionState.extensions.length,
    library:
      mediaLibrary.length,
    cloudstreamBridge:
      Boolean(BRIDGE_URL),
    extensionSync:
      extensionState.updatedAt
  });
});

app.get("/api/providers", (req, res) => {
  res.json({
    providers:
      [...providers.values()].map(
        provider => ({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          runtime: "native"
        })
      ),

    cloudstreamBridge: {
      enabled: Boolean(BRIDGE_URL),
      runtime:
        BRIDGE_URL
          ? "external-cloudstream-runtime"
          : null
    }
  });
});

app.get("/api/extensions", (req, res) => {
  res.json({
    updatedAt:
      extensionState.updatedAt,

    repositories:
      extensionState.repositories,

    count:
      extensionState.extensions.length,

    extensions:
      extensionState.extensions
  });
});

app.post("/api/extensions/sync", async (req, res) => {
  try {
    const state =
      await syncExtensions();

    res.json({
      ok: true,
      updatedAt:
        state.updatedAt,
      count:
        state.extensions.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/library", (req, res) => {
  const category =
    safeString(req.query.category, "all")
      .toLowerCase();

  const search =
    safeString(req.query.search)
      .toLowerCase();

  let filtered =
    [...mediaLibrary];

  if (
    category &&
    category !== "all"
  ) {
    filtered =
      filtered.filter(
        item =>
          safeString(item.type)
            .toLowerCase() === category
      );
  }

  if (search) {
    filtered =
      filtered.filter(item =>
        [
          item.title,
          item.description,
          item.providerName,
          item.year
        ]
          .join(" ")
          .toLowerCase()
          .includes(search)
      );
  }

  res.json({
    count: filtered.length,
    library: filtered
  });
});

app.get("/api/search", async (req, res) => {
  const query =
    safeString(req.query.q);

  if (!query) {
    return res.status(400).json({
      error: "Query is required"
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
            )
        }
      );

    res.json({
      query,
      count: results.length,
      results
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/api/sync", async (req, res) => {
  try {
    await syncExtensions();
    await syncLibrary();

    res.json({
      ok: true,
      library:
        mediaLibrary.length,
      extensions:
        extensionState.extensions.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/title/:id", async (req, res) => {
  const id =
    safeString(req.params.id);

  const item =
    mediaLibrary.find(
      candidate =>
        candidate.id === id
    );

  if (!item) {
    return res.status(404).json({
      error: "Title not found"
    });
  }

  const provider =
    providers.get(
      item.providerId
    );

  if (
    provider &&
    typeof provider.load === "function"
  ) {
    try {
      const loaded =
        await provider.load(item);

      return res.json({
        item:
          normalizeMediaItem(
            loaded
          ),
        sources:
          Array.isArray(
            loaded.sources
          )
            ? loaded.sources
            : []
      });
    } catch (error) {
      console.error(
        `[Title] ${item.providerName}:`,
        error.message
      );
    }
  }

  if (BRIDGE_URL) {
    try {
      const result =
        await bridgeRequest(
          "/load",
          {
            providerId:
              item.providerId,
            sourceId:
              item.sourceId,
            id:
              item.id
          }
        );

      return res.json(result);
    } catch (error) {
      console.error(
        "[CloudStream Bridge] Load failed:",
        error.message
      );
    }
  }

  res.json({
    item,
    sources: []
  });
});

app.get("/api/sources/:id", async (req, res) => {
  const id =
    safeString(req.params.id);

  const item =
    mediaLibrary.find(
      candidate =>
        candidate.id === id
    );

  if (!item) {
    return res.status(404).json({
      error: "Title not found"
    });
  }

  const provider =
    providers.get(
      item.providerId
    );

  if (
    provider &&
    typeof provider.load === "function"
  ) {
    try {
      const loaded =
        await provider.load(item);

      return res.json({
        title:
          item.title,
        provider:
          item.providerName,
        sources:
          Array.isArray(
            loaded.sources
          )
            ? loaded.sources
            : []
      });
    } catch (error) {
      console.error(
        `[Sources] ${item.providerName}:`,
        error.message
      );
    }
  }

  if (BRIDGE_URL) {
    try {
      const result =
        await bridgeSources({
          providerId:
            item.providerId,
          sourceId:
            item.sourceId,
          id:
            item.id
        });

      return res.json(
        result
      );
    } catch (error) {
      return res.status(502).json({
        error:
          "CloudStream bridge failed",
        details:
          error.message
      });
    }
  }

  return res.json({
    title:
      item.title,
    provider:
      item.providerName,
    sources: []
  });
});

/* ============================================================
   AUTOMATIC BACKGROUND TASKS
============================================================ */

async function startup() {
  console.log(
    `[Mediav2] Starting on port ${PORT}`
  );

  try {
    await syncExtensions();
  } catch (error) {
    console.error(
      "[Startup] Extension sync failed:",
      error.message
    );
  }

  try {
    await syncLibrary();
  } catch (error) {
    console.error(
      "[Startup] Library sync failed:",
      error.message
    );
  }
}

setInterval(
  async () => {
    try {
      await syncExtensions();
      await syncLibrary();
    } catch (error) {
      console.error(
        "[Background Sync]",
        error.message
      );
    }
  },
  EXTENSION_SYNC_HOURS *
    60 *
    60 *
    1000
);

app.get("*", (req, res) => {
  if (
    req.path.startsWith("/api/")
  ) {
    return res.status(404).json({
      error: "API endpoint not found"
    });
  }

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.listen(
  PORT,
  () => {
    startup().catch(error =>
      console.error(
        "[Startup]",
        error
      )
    );
  }
);
