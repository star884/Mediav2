pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        maven { setUrl("https://jitpack.io") }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { setUrl("https://jitpack.io") }
    }
}

rootProject.name = "MyCloudstreamRepo"

include(":StreamPlay")
include(":Moviebox")
include(":HDHUB4K")
include(":AniDb")
include(":Animepahe")
include(":Cinestream")

project(":StreamPlay").projectDir = file("src/StreamPlay")
project(":Moviebox").projectDir = file("src/Moviebox")
project(":HDHUB4K").projectDir = file("src/HDHUB4K")
project(":AniDb").projectDir = file("src/AniDb")
project(":Animepahe").projectDir = file("src/Animepahe")
project(":Cinestream").projectDir = file("src/Cinestream")
