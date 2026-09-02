package com.example

import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.*

class Cinestream : MainProvider() {
    override var mainUrl = "https://cinestream.example"
    override var name = "Cinestream"
    override var supportedTypes = setOf(TvType.Movie, TvType.TvSeries)
    override var lang = "en"
    override var hasMainPage = true

    override async fun getMainPage(page: Int, request: MainPageRequest): HomePageResponse {
        val items = listOf(
            MovieSearchResponse(
                name = "Sample Movie",
                url = "$mainUrl/movie/sample",
                apiName = this.name,
                type = TvType.Movie,
                posterUrl = "https://via.placeholder.com/300x450"
            )
        )
        return newHomePageResponse(request.name, items)
    }

    override async fun search(query: String): List<SearchResponse> {
        return emptyList()
    }

    override async fun load(url: String): LoadResponse {
        return newMovieLoadResponse("Sample Movie", url, TvType.Movie, "$url/play")
    }

    override async fun loadLinks(
        data: String,
        isCdn: Boolean,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit
    ): Boolean {
        callback(
            ExtractorLink(
                source = this.name,
                name = "Direct Stream",
                url = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
                referer = "",
                quality = Qualities.P1080.value
            )
        )
        return true
    }
}
