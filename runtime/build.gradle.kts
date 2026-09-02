plugins {
    kotlin("jvm")
    application
}

dependencies {
    implementation(project(":plugin-runtime"))
    implementation(project(":android-stubs"))
    implementation(project(":library"))

    implementation(kotlin("reflect"))
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.13.1")
}

application {
    mainClass.set(
        "com.star884.mediav2.runtime.BridgeServerKt"
    )
}

tasks.jar {
    duplicatesStrategy =
        DuplicatesStrategy.EXCLUDE

    manifest {
        attributes(
            "Main-Class" to
                "com.star884.mediav2.runtime.BridgeServerKt"
        )
    }

    from(
        configurations.runtimeClasspath.get()
            .map { file ->
                if (file.isDirectory)
                    file
                else
                    zipTree(file)
            }
    )
}
