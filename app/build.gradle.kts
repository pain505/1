// 取件码管家 — app 模块
// 零第三方依赖：dependencies {} 保持为空，kotlin-stdlib 由 Kotlin 插件自动带上。
// 视图体系为 View/XML + findViewById，故关闭 viewBinding 与 buildConfig。

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pickupcode.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.pickupcode.app"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = false
        viewBinding = false
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    // 故意为空：本项目只用 Android 平台 API（android.*），
    // 不引入 AndroidX / Google / kotlinx / 任何第三方库。
}
