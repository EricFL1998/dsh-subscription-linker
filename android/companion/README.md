# 订阅插件原生伴生 APK（`android/companion`）

这个工程编译 `dsh-plugin-subscription-oauth` 的原生伴生 APK：把订阅设置页、dock
用量胶囊、模型页 provider 扩展、模型选择器快切按钮交给 App 的原生容器渲染。

## 版本规则（跟插件版本对齐）

`build.gradle.kts` 直接读仓库根 `package.json` 的 `version`：

- `versionName` = 插件版本（例如 `0.17.17`）；
- `versionCode` = `major*10000 + minor*100 + patch`（例如 `1717`）；
- `dsh.plugin.version` manifest 占位符也用同一个 `versionCode`。

因此 App/商店里看到的 APK 版本、插件版本、Release tag 永远是同一个号。

## 构建

本工程是**独立的 Gradle 工程**（不进 App 仓库）。借用 App 仓库的 wrapper 即可：

```bash
# 在 App 仓库根目录执行
JAVA_HOME=<jdk17> ./gradlew -p "<本仓库>/android/companion" assembleDebug
```

产物：`android/companion/build/outputs/apk/debug/dsh-subscription-oauth-companion-debug.apk`

需要本机 SDK 路径：把 `local.properties.example` 复制为 `local.properties` 并填
`sdk.dir`（或设置 `ANDROID_HOME`）。

## SDK 不随 APK 打包

SDK 与 Compose 都是 `compileOnly`（`libs/dsh-native-ui-sdk.jar` 由 SDK 仓库的
AAR 解出）。运行时由宿主 App 以父优先 ClassLoader 提供唯一一份
`PageRegistry`/Compose，避免第二份注册表把页面注册写串，APK 也从 ~16 MB 降到 ~0.95 MB。

`libs/dsh-native-ui-sdk.jar` 更新方式：从 [dsh-mobile-plugin-sdk](https://github.com/EricFL1998/dsh-mobile-plugin-sdk)
仓库的 `artifacts/dsh-native-ui-sdk-release.aar` 里解出 `classes.jar` 覆盖。

## 发布

按 SDK 的 `docs/publishing.md` 约定：

- tag：`v<js-version>-subscription-native`（例如 `v0.17.17-subscription-native`）；
- 资产名：`dsh-plugin-subscription-oauth-companion-<js-version>.apk`
  （例如 `dsh-plugin-subscription-oauth-companion-0.17.17.apk`）；
- 更新 APK 时新建 tag + Release，不覆盖已有资产。
