plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.lagradost.cloudstream3.gradle")
}

cloudstream {
    setManifest {
        name = "Cinestream"
        description = "Streams movies and series from Cinestream source"
        authors = listOf("CustomRepo")
        version = 1
        requiresTypes = listOf("Movie", "TvSeries")
        iconUrl = "https://raw.githubusercontent.com/recloudstream/cloudstream/master/app/src/main/res/drawable/ic_launcher_foreground.png"
    }
}

android {
    namespace = "com.example.cinestream"
    compileSdk = 34
    
    defaultConfig {
        minSdk = 21
    }
}
