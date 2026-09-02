package com.example

import com.lagradost.cloudstream3.*
import com.lagradost.cloudstream3.utils.*

class Cinestream : MainProvider() {

    override var mainUrl =
        "https://example.invalid"

    override var name =
        "Cinestream"

    override var supportedTypes =
        setOf(
            TvType.Movie,
            TvType.TvSeries
        )

    override var lang =
        "en"

    override var hasMainPage =
        false

    override suspend fun getMainPage(
        page: Int,
        request: MainPageRequest
    ): HomePageResponse {
        return newHomePageResponse(
            request.name,
            emptyList()
        )
    }

    override suspend fun search(
        query: String
    ): List<SearchResponse> {
        /*
         * This provider intentionally has no fake
         * implementation.
         *
         * A real provider endpoint/API must be
         * supplied before this can perform searches.
         */
        return emptyList()
    }

    override suspend fun load(
        url: String
    ): LoadResponse {
        throw Error(
            "Cinestream provider endpoint is not configured."
        )
    }

    override suspend fun loadLinks(
        data: String,
        isCdn: Boolean,
        subtitleCallback:
            (SubtitleFile) -> Unit,
        callback:
            (ExtractorLink) -> Unit
    ): Boolean {
        /*
         * Do not return a fake demonstration
         * stream.
         */
        return false
    }
}
