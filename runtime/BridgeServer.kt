package com.star884.mediav2.runtime

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.ExtractorLink
import com.lagradost.runtime.loader.ExtensionLoader
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.*
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private val mapper = jacksonObjectMapper()

private val http = HttpClient.newBuilder()
    .followRedirects(HttpClient.Redirect.NORMAL)
    .connectTimeout(java.time.Duration.ofSeconds(20))
    .build()

private val scope = CoroutineScope(
    SupervisorJob() + Dispatchers.IO
)

private val pluginLock = Any()

private val loadedPlugins =
    mutableMapOf<String, File>()

private val aliases = mapOf(
    "moviebox" to "MovieBox",
    "movie box" to "MovieBox",
    "4khdhub" to "4KHDHUB",
    "4k hd hub" to "4KHDHUB",
    "anidb" to "AniDB",
    "animepahe" to "AnimePahe",
    "cinestream" to "CineStream",
    "cine stream" to "CineStream",
    "streamplay" to "StreamPlay"
)

private val requestedExtensions =
    System.getenv("CLOUDSTREAM_EXTENSIONS")
        ?.split(",")
        ?.map { it.trim() }
        ?.filter { it.isNotBlank() }
        ?.toSet()
        ?: setOf(
            "StreamPlay",
            "MovieBox",
            "4KHDHUB",
            "AniDB",
            "AnimePahe",
            "CineStream"
        )

private val repositories =
    System.getenv("CLOUDSTREAM_REPOSITORIES")
        ?.split(",")
        ?.map { it.trim() }
        ?.filter { it.isNotBlank() }
        ?: listOf(
            "https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/refs/heads/builds/repo.json",
            "https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json"
        )

private val pluginDirectory =
    File(
        System.getenv("CLOUDSTREAM_PLUGIN_DIR")
            ?: "./data/cloudstream-plugins"
    )

private val port =
    System.getenv("PORT")?.toIntOrNull() ?: 10000

private val requestTimeout =
    System.getenv("CLOUDSTREAM_RUNTIME_TIMEOUT")
        ?.toLongOrNull()
        ?: 120_000L

private data class PluginSpec(
    val name: String,
    val internalName: String,
    val url: String,
    val version: Int,
    val repository: String
)

private data class ProviderInfo(
    val name: String,
    val className: String,
    val plugin: String?,
    val mainUrl: String,
    val types: List<String>
)

private data class SearchItem(
    val name: String,
    val url: String,
    val provider: String,
    val type: String?,
    val posterUrl: String?,
    val year: Int?
)

private data class EpisodeItem(
    val name: String?,
    val season: Int,
    val episode: Int,
    val data: String,
    val posterUrl: String?
)

private data class SourceItem(
    val source: String,
    val name: String,
    val url: String,
    val referer: String?,
    val quality: Int,
    val type: String,
    val headers: Map<String, String>
)

private fun response(
    exchange: HttpExchange,
    status: Int,
    value: Any
) {
    val bytes = mapper.writeValueAsString(value)
        .toByteArray(StandardCharsets.UTF_8)

    exchange.responseHeaders.set(
        "Content-Type",
        "application/json; charset=utf-8"
    )

    exchange.responseHeaders.set(
        "Access-Control-Allow-Origin",
        "*"
    )

    exchange.responseHeaders.set(
        "Access-Control-Allow-Headers",
        "Content-Type"
    )

    exchange.responseHeaders.set(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
    )

    exchange.sendResponseHeaders(status, bytes.size.toLong())

    exchange.responseBody.use {
        it.write(bytes)
    }
}

private fun body(exchange: HttpExchange): JsonNode {
    return mapper.readTree(
        exchange.requestBody.readBytes()
    )
}

private fun getText(
    node: JsonNode,
    key: String
): String? =
    node.get(key)
        ?.takeIf { !it.isNull }
        ?.asText()
        ?.takeIf { it.isNotBlank() }

private fun getInt(
    node: JsonNode,
    key: String
): Int? =
    node.get(key)
        ?.takeIf { !it.isNull }
        ?.asInt()

private fun normalizedName(name: String): String {
    val lower = name.trim().lowercase()

    return aliases[lower]
        ?: name.trim()
}

private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")

    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)

        while (true) {
            val count = input.read(buffer)

            if (count <= 0)
                break

            digest.update(buffer, 0, count)
        }
    }

    return digest.digest()
        .joinToString("") {
            "%02x".format(it)
        }
}

private fun download(
    url: String,
    destination: File
) {
    destination.parentFile?.mkdirs()

    val request = HttpRequest.newBuilder()
        .uri(URI(url))
        .timeout(java.time.Duration.ofMinutes(5))
        .GET()
        .build()

    val response = http.send(
        request,
        HttpResponse.BodyHandlers.ofByteArray()
    )

    if (response.statusCode() !in 200..299) {
        error(
            "Download failed: HTTP ${response.statusCode()} $url"
        )
    }

    val temporary =
        File(destination.parentFile, ".${destination.name}.tmp")

    temporary.writeBytes(response.body())

    if (temporary.length() <= 0) {
        temporary.delete()
        error("Downloaded plugin is empty: $url")
    }

    if (destination.exists()) {
        destination.delete()
    }

    if (!temporary.renameTo(destination)) {
        Files.move(
            temporary.toPath(),
            destination.toPath()
        )
    }
}

private fun getJson(url: String): JsonNode {
    val request = HttpRequest.newBuilder()
        .uri(URI(url))
        .timeout(java.time.Duration.ofSeconds(30))
        .header(
            "User-Agent",
            "Mediav2-CloudStream-Runtime/1.0"
        )
        .GET()
        .build()

    val response = http.send(
        request,
        HttpResponse.BodyHandlers.ofString()
    )

    if (response.statusCode() !in 200..299) {
        error(
            "Repository request failed: HTTP ${response.statusCode()} $url"
        )
    }

    return mapper.readTree(response.body())
}

private fun resolveUrl(
    base: String,
    value: String
): String {
    return try {
        URI(base)
            .resolve(value)
            .toString()
    } catch (_: Throwable) {
        value
    }
}

private fun readPluginSpecs(
    repositoryUrl: String
): List<PluginSpec> {

    val root = getJson(repositoryUrl)

    val result = mutableListOf<PluginSpec>()

    fun readManifest(
        url: String,
        node: JsonNode
    ) {
        if (node.isArray) {
            node.forEach {
                addPluginNode(
                    url,
                    it,
                    result
                )
            }

            return
        }

        val pluginLists = node.get("pluginLists")

        if (pluginLists?.isArray == true) {
            pluginLists.forEach {
                val child = it.asText()

                val childUrl =
                    resolveUrl(url, child)

                runCatching {
                    readManifest(
                        childUrl,
                        getJson(childUrl)
                    )
                }
            }
        }

        val plugins = node.get("plugins")

        if (plugins?.isArray == true) {
            plugins.forEach {
                addPluginNode(
                    url,
                    it,
                    result
                )
            }
        }
    }

    readManifest(repositoryUrl, root)

    return result
}

private fun addPluginNode(
    repositoryUrl: String,
    node: JsonNode,
    output: MutableList<PluginSpec>
) {
    val name =
        getText(node, "name")
            ?: getText(node, "internalName")
            ?: return

    val internalName =
        getText(node, "internalName")
            ?: name

    val pluginUrl =
        getText(node, "url")
            ?: getText(node, "file")
            ?: return

    val version =
        getInt(node, "version")
            ?: 0

    output += PluginSpec(
        name = name,
        internalName = internalName,
        url = resolveUrl(
            repositoryUrl,
            pluginUrl
        ),
        version = version,
        repository = repositoryUrl
    )
}

private fun matchesRequested(
    spec: PluginSpec
): Boolean {
    if (requestedExtensions.isEmpty())
        return true

    val candidates = listOf(
        spec.name,
        spec.internalName
    )

    return candidates.any { candidate ->
        requestedExtensions.any { wanted ->
            normalizedName(candidate)
                .equals(
                    normalizedName(wanted),
                    ignoreCase = true
                )
        }
    }
}

private fun pluginFileName(
    spec: PluginSpec
): String {
    val safe =
        spec.internalName
            .replace(
                Regex("[^A-Za-z0-9._-]"),
                "_"
            )

    return "$safe.cs3"
}

private fun installedVersionFile(
    spec: PluginSpec
): File =
    File(
        pluginDirectory,
        "${pluginFileName(spec)}.json"
    )

private fun syncPlugins(): List<PluginSpec> {
    pluginDirectory.mkdirs()

    val all =
        repositories
            .flatMap { repo ->
                runCatching {
                    readPluginSpecs(repo)
                }.getOrElse {
                    println(
                        "Repository failed: $repo -> ${it.message}"
                    )

                    emptyList()
                }
            }
            .filter(::matchesRequested)
            .distinctBy {
                it.internalName.lowercase()
            }

    for (spec in all) {
        val file =
            File(
                pluginDirectory,
                pluginFileName(spec)
            )

        val metadata =
            installedVersionFile(spec)

        val installedVersion =
            runCatching {
                getInt(
                    mapper.readTree(
                        metadata.readText()
                    ),
                    "version"
                ) ?: -1
            }.getOrDefault(-1)

        val needsDownload =
            !file.exists() ||
                installedVersion < spec.version

        if (needsDownload) {
            println(
                "Downloading ${spec.name} v${spec.version}"
            )

            runCatching {
                download(
                    spec.url,
                    file
                )

                val checksum =
                    sha256(file)

                metadata.writeText(
                    mapper.writeValueAsString(
                        mapOf(
                            "name" to spec.name,
                            "internalName" to spec.internalName,
                            "version" to spec.version,
                            "url" to spec.url,
                            "sha256" to checksum,
                            "repository" to spec.repository
                        )
                    )
                )
            }.onFailure {
                println(
                    "Plugin download failed: ${spec.name}: ${it.message}"
                )
            }
        }
    }

    return all
}

private fun loadInstalledPlugins() {
    synchronized(pluginLock) {
        pluginDirectory
            .walkTopDown()
            .filter {
                it.isFile &&
                    (
                        it.extension.equals(
                            "cs3",
                            true
                        ) ||
                        it.extension.equals(
                            "jar",
                            true
                        )
                    )
            }
            .forEach { file ->

                if (loadedPlugins.containsKey(file.absolutePath))
                    return@forEach

                try {
                    ExtensionLoader.loadAndInit(
                        file
                    )

                    loadedPlugins[
                        file.absolutePath
                    ] = file

                    println(
                        "Loaded plugin: ${file.name}"
                    )
                } catch (error: Throwable) {
                    println(
                        "Plugin failed: ${file.name}: ${error.message}"
                    )
                }
            }
    }
}

private fun providers(): List<MainAPI> {
    synchronized(APIHolder.allProviders) {
        return APIHolder.allProviders
            .distinctBy {
                it.javaClass.name
            }
            .toList()
    }
}

private fun providerFor(
    node: JsonNode
): MainAPI? {
    val providerName =
        getText(node, "providerName")

    val providerId =
        getText(node, "providerId")

    val url =
        getText(node, "url")

    return providers().firstOrNull { api ->
        (
            providerName != null &&
                api.name.equals(
                    providerName,
                    true
                )
            ) ||
            (
                providerId != null &&
                    (
                        api.name.equals(
                            providerId,
                            true
                        ) ||
                        api.javaClass.simpleName.equals(
                            providerId,
                            true
                        )
                    )
                ) ||
            (
                url != null &&
                    url.startsWith(
                        api.mainUrl,
                        true
                    )
                )
    }
}

private fun searchProvider(
    api: MainAPI,
    query: String
): List<SearchItem> {

    return try {
        val results =
            runBlocking {
                withTimeout(
                    requestTimeout
                ) {
                    api.search(
                        query,
                        1
                    )?.items.orEmpty()
                }
            }

        results.map { item ->

            val year =
                when (item) {
                    is MovieSearchResponse ->
                        item.year

                    is TvSeriesSearchResponse ->
                        item.year

                    is AnimeSearchResponse ->
                        item.year

                    else ->
                        null
                }

            SearchItem(
                name = item.name,
                url = item.url,
                provider = api.name,
                type = item.type?.name,
                posterUrl = item.posterUrl,
                year = year
            )
        }
    } catch (error: Throwable) {
        println(
            "Search failed: ${api.name}: ${error.message}"
        )

        emptyList()
    }
}

private fun searchAll(
    query: String,
    requested: List<String>
): List<SearchItem> {

    val selected =
        providers()
            .filter { api ->
                requested.isEmpty() ||
                    requested.any {
                        normalizedName(it)
                            .equals(
                                normalizedName(api.name),
                                true
                            )
                    } ||
                    requested.any {
                        normalizedName(it)
                            .equals(
                                normalizedName(
                                    api.javaClass.simpleName
                                ),
                                true
                            )
                    }
            }

    return runBlocking {
        selected
            .map { api ->
                async(Dispatchers.IO) {
                    searchProvider(
                        api,
                        query
                    )
                }
            }
            .awaitAll()
            .flatten()
            .distinctBy {
                "${it.provider}|${it.url}"
            }
    }
}

private fun loadResponse(
    api: MainAPI,
    url: String
): LoadResponse? {
    return runBlocking {
        withTimeoutOrNull(
            requestTimeout
        ) {
            api.load(url)
        }
    }
}

private fun extractEpisodes(
    response: LoadResponse
): List<EpisodeItem> {

    return when (response) {

        is MovieLoadResponse -> {
            listOf(
                EpisodeItem(
                    name = response.name,
                    season = 1,
                    episode = 1,
                    data = response.dataUrl,
                    posterUrl = response.posterUrl
                )
            )
        }

        is TvSeriesLoadResponse -> {
            response.episodes.map {
                EpisodeItem(
                    name = it.name,
                    season = it.season,
                    episode = it.episode,
                    data = it.data,
                    posterUrl = it.posterUrl
                )
            }
        }

        is AnimeLoadResponse -> {
            response.episodes
                .values
                .flatten()
                .map {
                    EpisodeItem(
                        name = it.name,
                        season = it.season,
                        episode = it.episode,
                        data = it.data,
                        posterUrl = it.posterUrl
                    )
                }
        }

        is LiveStreamLoadResponse -> {
            listOf(
                EpisodeItem(
                    name = response.name,
                    season = 1,
                    episode = 1,
                    data = response.dataUrl,
                    posterUrl = response.posterUrl
                )
            )
        }

        else -> emptyList()
    }
}

private fun loadDto(
    api: MainAPI,
    response: LoadResponse
): Map<String, Any?> {

    val episodes =
        extractEpisodes(response)

    return mapOf(
        "name" to response.name,
        "url" to response.url,
        "provider" to api.name,
        "type" to response.type.name,
        "posterUrl" to response.posterUrl,
        "backgroundPosterUrl" to response.backgroundPosterUrl,
        "year" to response.year,
        "plot" to response.plot,
        "episodes" to episodes
    )
}

private fun sourceType(
    link: ExtractorLink
): String {
    return when (link.type.name.uppercase()) {
        "M3U8" -> "hls"
        "DASH" -> "dash"
        else -> "video"
    }
}

private fun sourceDto(
    link: ExtractorLink,
    provider: String
): SourceItem {

    val headers =
        link.headers.toMutableMap()

    if (
        link.referer.isNotBlank() &&
        headers.keys.none {
            it.equals(
                "Referer",
                true
            )
        }
    ) {
        headers["Referer"] =
            link.referer
    }

    return SourceItem(
        source = provider,
        name = link.name,
        url = link.url,
        referer =
            link.referer
                .takeIf { it.isNotBlank() },
        quality = link.quality,
        type = sourceType(link),
        headers = headers
    )
}

private fun getSources(
    api: MainAPI,
    data: String
): List<SourceItem> {

    val links =
        mutableListOf<ExtractorLink>()

    return try {
        runBlocking {
            withTimeout(
                requestTimeout
            ) {
                api.loadLinks(
                    data = data,
                    isCasting = false,
                    subtitleCallback = {},
                    callback = {
                        synchronized(links) {
                            links += it
                        }
                    }
                )
            }
        }

        links
            .filter {
                it.url.startsWith(
                    "http://"
                ) ||
                    it.url.startsWith(
                        "https://"
                    )
            }
            .distinctBy {
                "${it.url}|${it.quality}"
            }
            .map {
                sourceDto(
                    it,
                    api.name
                )
            }

    } catch (error: Throwable) {

        println(
            "loadLinks failed: ${api.name}: ${error.message}"
        )

        emptyList()
    }
}

private fun route(
    exchange: HttpExchange
) {
    if (exchange.requestMethod.equals(
            "OPTIONS",
            true
        )
    ) {
        response(
            exchange,
            204,
            emptyMap<String, Any>()
        )
        return
    }

    val path =
        exchange.requestURI.path

    try {
        when {

            path == "/health" -> {
                response(
                    exchange,
                    200,
                    mapOf(
                        "ok" to true,
                        "runtime" to "Mediav2 CloudStream JVM Runtime",
                        "providers" to providers().size,
                        "plugins" to loadedPlugins.size
                    )
                )
            }

            path == "/providers" -> {

                val list =
                    providers().map {
                        ProviderInfo(
                            name = it.name,
                            className =
                                it.javaClass.simpleName,
                            plugin = it.sourcePlugin,
                            mainUrl = it.mainUrl,
                            types =
                                it.supportedTypes
                                    .map { type ->
                                        type.name
                                    }
                        )
                    }

                response(
                    exchange,
                    200,
                    mapOf(
                        "providers" to list
                    )
                )
            }

            path == "/search" -> {

                val node =
                    body(exchange)

                val query =
                    getText(
                        node,
                        "query"
                    ) ?: ""

                val requested =
                    node.get("extensions")
                        ?.takeIf { it.isArray }
                        ?.map {
                            it.asText()
                        }
                        ?: emptyList()

                if (query.isBlank()) {
                    response(
                        exchange,
                        200,
                        mapOf(
                            "results" to emptyList<SearchItem>()
                        )
                    )
                    return
                }

                val results =
                    searchAll(
                        query,
                        requested
                    )

                response(
                    exchange,
                    200,
                    mapOf(
                        "results" to results
                    )
                )
            }

            path == "/load" -> {

                val node =
                    body(exchange)

                val api =
                    providerFor(node)

                if (api == null) {
                    response(
                        exchange,
                        404,
                        mapOf(
                            "error" to
                                "CloudStream provider not found"
                        )
                    )
                    return
                }

                val url =
                    getText(
                        node,
                        "url"
                    )

                if (url == null) {
                    response(
                        exchange,
                        400,
                        mapOf(
                            "error" to
                                "Missing url"
                        )
                    )
                    return
                }

                val loaded =
                    loadResponse(
                        api,
                        url
                    )

                if (loaded == null) {
                    response(
                        exchange,
                        404,
                        mapOf(
                            "error" to
                                "Provider returned no LoadResponse"
                        )
                    )
                    return
                }

                response(
                    exchange,
                    200,
                    loadDto(
                        api,
                        loaded
                    )
                )
            }

            path == "/sources" -> {

                val node =
                    body(exchange)

                val api =
                    providerFor(node)

                if (api == null) {
                    response(
                        exchange,
                        404,
                        mapOf(
                            "error" to
                                "CloudStream provider not found"
                        )
                    )
                    return
                }

                val data =
                    getText(
                        node,
                        "data"
                    )

                if (data == null) {
                    response(
                        exchange,
                        400,
                        mapOf(
                            "error" to
                                "Missing data"
                        )
                    )
                    return
                }

                val sources =
                    getSources(
                        api,
                        data
                    )

                response(
                    exchange,
                    200,
                    mapOf(
                        "sources" to sources
                    )
                )
            }

            path == "/home" -> {

                val requested =
                    body(exchange)
                        .get("extensions")
                        ?.takeIf { it.isArray }
                        ?.map {
                            it.asText()
                        }
                        ?: emptyList()

                val selected =
                    providers()
                        .filter { api ->
                            requested.isEmpty() ||
                                requested.any {
                                    normalizedName(it)
                                        .equals(
                                            normalizedName(
                                                api.name
                                            ),
                                            true
                                        )
                                }
                        }

                val result =
                    runBlocking {

                        selected.map { api ->
                            async(Dispatchers.IO) {

                                try {

                                    if (!api.hasMainPage)
                                        return@async emptyList<SearchItem>()

                                    val pages =
                                        api.mainPage

                                    val output =
                                        mutableListOf<SearchItem>()

                                    for (page in pages.take(3)) {

                                        val home =
                                            withTimeoutOrNull(
                                                requestTimeout
                                            ) {
                                                api.getMainPage(
                                                    1,
                                                    MainPageRequest(
                                                        page.name,
                                                        page.data,
                                                        page.horizontalImages
                                                    )
                                                )
                                            }

                                        home
                                            ?.items
                                            ?.flatMap {
                                                it.list
                                            }
                                            ?.mapTo(output) {
                                                val year =
                                                    when (it) {
                                                        is MovieSearchResponse ->
                                                            it.year

                                                        is TvSeriesSearchResponse ->
                                                            it.year

                                                        is AnimeSearchResponse ->
                                                            it.year

                                                        else ->
                                                            null
                                                    }

                                                SearchItem(
                                                    name = it.name,
                                                    url = it.url,
                                                    provider = api.name,
                                                    type = it.type?.name,
                                                    posterUrl = it.posterUrl,
                                                    year = year
                                                )
                                            }
                                    }

                                    output

                                } catch (
                                    error: Throwable
                                ) {
                                    println(
                                        "Home failed: ${api.name}: ${error.message}"
                                    )

                                    emptyList()
                                }
                            }
                        }.awaitAll()
                            .flatten()
                            .distinctBy {
                                "${it.provider}|${it.url}"
                            }
                    }

                response(
                    exchange,
                    200,
                    mapOf(
                        "results" to result
                    )
                )
            }

            else -> {
                response(
                    exchange,
                    404,
                    mapOf(
                        "error" to "Not found"
                    )
                )
            }
        }

    } catch (error: Throwable) {

        error.printStackTrace()

        response(
            exchange,
            500,
            mapOf(
                "error" to (
                    error.message
                        ?: error.javaClass.simpleName
                    )
            )
        )
    }
}

fun main() {

    println(
        "Starting Mediav2 CloudStream JVM Runtime"
    )

    pluginDirectory.mkdirs()

    println(
        "Repositories: ${repositories.size}"
    )

    println(
        "Requested extensions: ${requestedExtensions.joinToString()}"
    )

    runCatching {
        syncPlugins()
    }.onFailure {
        println(
            "Initial plugin sync failed: ${it.message}"
        )
    }

    loadInstalledPlugins()

    println(
        "CloudStream providers loaded: ${providers().size}"
    )

    val server =
        HttpServer.create(
            InetSocketAddress(
                "0.0.0.0",
                port
            ),
            0
        )

    server.createContext("/") { exchange ->
        route(exchange)
    }

    server.executor =
        Executors.newFixedThreadPool(16)

    server.start()

    println(
        "Mediav2 runtime listening on :$port"
    )

    scope.launch {
        while (isActive) {

            delay(
                TimeUnit.HOURS
                    .toMillis(6)
            )

            try {
                syncPlugins()
                loadInstalledPlugins()
            } catch (error: Throwable) {
                println(
                    "Periodic sync failed: ${error.message}"
                )
            }
        }
    }

    Runtime.getRuntime()
        .addShutdownHook(
            Thread {
                server.stop(1)
                scope.cancel()
            }
        )
}
