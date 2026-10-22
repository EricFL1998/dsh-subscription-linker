plugins {
    id("com.android.application") version "8.9.0"
    id("org.jetbrains.kotlin.android") version "2.1.10"
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.10"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.10"
}

android {
    namespace = "com.dsh.mobile.dsh_plugin_subscription_oauth"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.mobile.dsh_plugin_subscription_oauth"
        minSdk = 26
        targetSdk = 35
        // 1.0.1：补上 `settings.section#subscriptions` 的原生设置页注册，
        // 装了伴生 APK 后设置页不再回退 Web UI。
        versionCode = 2
        versionName = "1.0.1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    // 伴生 APK 刻意**不打包** SDK 与 Compose：宿主 App 用父优先 ClassLoader
    // 提供唯一一份 SDK/Compose 类型（见 SDK 文档「ClassLoader：按约定加载」）。
    // 只编译期引用，运行时由宿主解析，避免第二份 PageRegistry 把注册表写串。
    compileOnly(files("libs/dsh-native-ui-sdk.jar"))
    compileOnly(platform("androidx.compose:compose-bom:2025.02.00"))
    compileOnly("androidx.compose.ui:ui")
    compileOnly("androidx.compose.foundation:foundation")
    compileOnly("androidx.compose.runtime:runtime")
    compileOnly("androidx.compose.material3:material3")
    compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
}
