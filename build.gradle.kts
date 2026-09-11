// 取件码管家 — 根构建脚本
// 只用 plugins 块声明版本（不使用 buildscript {}），子模块 apply。
// 本项目零第三方依赖：这两个插件自身会从上面的仓库解析。

plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
