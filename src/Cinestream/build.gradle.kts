plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.lagradost.cloudstream3.gradle")
}

cloudstream {
    setManifest {
        name = "Cinestream"

        description =
            "Mediav2 CloudStream provider adapter"

        authors =
            listOf("star884")

        version = 1

        requiresTypes =
            listOf(
                "Movie",
                "TvSeries"
            )

        iconUrl =
            "https://raw.githubusercontent.com/recloudstream/cloudstream/master/app/src/main/res/drawable/ic_launcher_foreground.png"
    }
}

android {
    namespace =
        "com.example.cinestream"

    compileSdk = 34

    defaultConfig {
        minSdk = 21
    }
}
