package com.example

import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.*

class Cinestream : MainProvider() {
    override var mainUrl = "https://cinestream.example"
    override var name = "Cinestream"
    override var supportedTypes = setOf(TvType.Movie, TvType.TvSeries)
    override var lang = "en"
    override var hasMainPage = true

    override suspend fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val items = listOf(
            MovieSearchResponse(
                name = "Sample Title",
                url = "$mainUrl/watch/sample",
                apiName = this.name,
                type = TvType.Movie,
                posterUrl = "https://via.placeholder.com/300x450"
            )
        )
        return newHomePageResponse(request.name, items)
    }

    override suspend fun search(query: String): List<SearchResponse> {
        return emptyList()
    }

    override suspend fun load(url: String): LoadResponse {
        return newMovieLoadResponse("Sample Title", url, TvType.Movie, "$url/play")
    }

    override suspend fun loadLinks(
        data: String,
        isCdn: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit
    ): Boolean {
        callback(
            ExtractorLink(
                source = this.name,
                name = "Stream",
                url = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
                referer = "",
                quality = Qualities.P1080.value
            )
        )
        return true
    }
}
