# 编译说明

三条路线，按需要选。**只想拿到 APK 的话看路线 A。**

---

## 路线 A：命令行一键构建（推荐）

需要 **JDK 17** 与 **Android SDK 34**（含 `build-tools;34.0.0`）。

```bash
npm run build
```

它直接调用 Android SDK 的命令行工具走完标准构建流程，**完全不需要 Gradle**：

```
aapt2 compile → aapt2 link (+R.java) → kotlinc → d8 → 塞入 classes.dex → zipalign → apksigner
```

产物：

- `pickup-code-debug.apk`（项目根目录）
- `manual-build/pickup-code-debug.apk`（中间产物目录）

也支持 `node tools/build-manual.mjs --debuggable`，会额外把 `android:debuggable="true"`
写进清单，方便用 `adb shell run-as` 读应用私有数据做验证（**不要用于正式包**）。

### 关于 SDK / JDK 路径

脚本按下面的顺序找工具链，可用环境变量 `TC_ROOT` 覆盖：

| 变量 | 作用 |
|---|---|
| `TC_ROOT` | 工具链根目录（优先级最高） |
| `JAVA_HOME` | JDK 17 |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Android SDK |

没有设 `TC_ROOT` 时，默认找**项目上一级目录**下的 `.android-toolchain/`：

```
<项目上级>/.android-toolchain/
├── jdk/bin/java.exe
├── kotlinc/lib/kotlin-stdlib.jar
└── sdk/
    ├── build-tools/34.0.0/aapt2.exe
    └── platforms/android-34/android.jar
```

没有这套布局的话，跑一次 `node tools/fetch-toolchain.mjs` 自动下载
JDK + Android cmdline-tools + Gradle + Kotlin 编译器，再用
`pwsh -File tools/install-sdk.ps1` 装 SDK 组件。

---

## 路线 B：双击一键构建（Gradle）

Windows 上双击：

```
tools\build-now.cmd
```

它会检查工具链 → 设置环境变量 → 跑离线校验 → `gradlew assembleDebug` →
检测到 USB 连接的手机就顺手 `adb install`。

第一次会联网下载 AGP 8.5.2 与 Kotlin 1.9.24 插件（约 300MB）。

---

## 路线 C：Android Studio

1. 下载安装 [Android Studio](https://developer.android.com/studio)（自带 JDK 和 Android SDK）
2. `File → Open`，选中项目根目录（**不是**里面的子目录）
3. 等 Gradle Sync 完成（`settings.gradle.kts` 里已把阿里云镜像放最前，国内网络通常能直接过）
4. `Build → Build Bundle(s) / APK(s) → Build APK(s)`
5. 产物：`app/build/outputs/apk/debug/app-debug.apk`

---

## 路线 D：Gradle 命令行

```bash
cp local.properties.example local.properties   # 然后把 sdk.dir 改成你的 SDK 路径
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 是机器相关的，已在 `.gitignore` 里，不要提交。

---

## 不用编译器也能验证

只要有 Node（≥ 18），就能把解析逻辑和静态一致性全验一遍：

```bash
npm test
```

详见 README 的「验证」一节。

---

## 附：为什么会有路线 A

`tools/build-manual.mjs` 存在是因为开发环境里 **Gradle 起不来**：
该环境禁止 AF_UNIX 的 `connect` 调用，导致 `Selector.open()` 必失败
（`Unable to establish loopback connection`），而 Gradle daemon 与它的 worker
都依赖 selector。提权也无效，因为拦的是 socket 调用而不是文件权限。

而 `aapt2` / `kotlinc` / `d8` / `zipalign` / `apksigner` 都不需要 selector，
所以可以直接串起来手工构建。这条路顺便成了一份可复现的
「不用 Gradle 构建 Android APK」参考实现。

### 手工构建容易踩的两个坑

如果你也在做类似的事，这两点务必注意（我们都实际踩过）：

1. **Kotlin 标准库必须自己打包进去**。Gradle 会自动带 `kotlin-stdlib` 依赖，
   手工构建没有这一步，而 Android 平台不提供 Kotlin 运行时 ——
   结果是启动瞬间 `NoClassDefFoundError: kotlin/collections/CollectionsKt`。
   本项目的做法是把 `kotlin-stdlib.jar` 解出来和业务 class 一起丢给 d8。

2. **`SmsReceiver` 必须 `android:exported="true"`**。实测（Android 14 模拟器，
   A/B 对照）`exported="false"` 时系统的 `SMS_RECEIVED` 广播不会投递，
   短信自动识别完全失效。安全上用
   `android:permission="android.permission.BROADCAST_SMS"` 限制只有系统短信模块能触发。

3. **清单里要有 `package` 与 `versionCode`**。AGP 从 `build.gradle.kts` 的
   `namespace` 和 `defaultConfig` 注入这两项，手工调 aapt2 不会 ——
   缺 `versionCode` 会直接装不上。
