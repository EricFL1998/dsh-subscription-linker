plugins {
    id("com.android.application") version "8.9.0"
    id("org.jetbrains.kotlin.android") version "2.1.10"
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.10"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.10"
}

// 伴生 APK 的版本跟随插件版本（仓库根 package.json），这样 Release tag、
// APK 文件名、Android versionName 三处永远对齐，不再出现 tag 0.17.17 / APK 1.0.1。
val pluginVersion: String = run {
    @Suppress("UNCHECKED_CAST")
    val pkg = groovy.json.JsonSlurper()
        .parse(rootProject.file("../../package.json")) as Map<String, Any?>
    pkg["version"] as String
}
val pluginVersionCode: Int = run {
    val parts = pluginVersion.split("-").first().split(".").map { it.toIntOrNull() ?: 0 }
    (parts.getOrElse(0) { 0 } * 10_000) +
        (parts.getOrElse(1) { 0 } * 100) +
        parts.getOrElse(2) { 0 }
}

android {
    namespace = "com.dsh.mobile.dsh_plugin_subscription_oauth"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.mobile.dsh_plugin_subscription_oauth"
        minSdk = 26
        targetSdk = 35
        versionCode = pluginVersionCode
        versionName = pluginVersion
        manifestPlaceholders["dshPluginVersion"] = pluginVersionCode.toString()
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
