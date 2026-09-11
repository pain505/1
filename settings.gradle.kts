// 取件码管家 — Gradle 设置
// 仓库顺序：阿里云镜像优先（国内快），官方仓库兜底。
// 网络受限时全部仓库都会失败，此时只能用 --offline + 预热的 GRADLE_USER_HOME 缓存。

pluginManagement {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "PickupCode"
include(":app")
