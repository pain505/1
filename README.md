# 取件码管家 (PickupCode)

**把散落在短信、App 通知、微信里的取件码，自动汇总成一张清单。**

打开就能看到「去哪取、码是多少、还剩多久过期」。纯本地解析，**App 没有申请
`INTERNET` 权限 —— 它物理上无法联网**。

<p align="center">
  <em>Android 10+ · Kotlin · 零第三方依赖 · MIT</em>
</p>

---

## 它解决什么问题

取件码散落在四个地方，每个都烦：

| 来源 | 麻烦在哪 |
|---|---|
| 快递短信（菜鸟、丰巢、速递易…） | 躺在几十条验证码/营销短信里，翻半天 |
| 拼多多 / 淘宝 / 京东通知 | 划过去就没了，不点开 App 根本想不起来 |
| 微信 / 支付宝小程序 | 只有一段文字，得自己记住或截图 |
| 快递柜 | 24 小时就收费，忘了就一直扣 |

这个 App 把前两类**全自动**抓下来（短信广播 + 通知监听），后两类支持**分享/粘贴导入**，
统一成一张按取件点分组的清单，带过期倒计时。

## 界面长什么样

```
┌────────────────────────────────────────┐
│  取件码管家                             │
│  未取 2 件 · 今日到期 1 件               │
├────────────────────────────────────────┤
│  ▸ 菜鸟驿站(阳光花园店)              2  │
│  ┌──────────────────────────────────┐  │
│  │  8-3-2015           还剩 5 小时   │  │
│  │  菜鸟驿站 · 2小时前               │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │  8-3-2016          今天 21 点前   │  │
│  └──────────────────────────────────┘  │
│  ▸ 丰巢智能柜(A区)                      │
│  ┌──────────────────────────────────┐  │
│  │  470812            还剩不到 1 小时│  │
│  └──────────────────────────────────┘  │
│  ▸ 已取件                               │
└────────────────────────────────────────┘
```

短按一行 = 复制取件码；长按 = 标记已取 / 删除 / 查看原文。

## 技术上有意思的地方

### 1. 解析规则的硬骨头：取件码长得五花八门

只抓「取件码 + 一串数字」会漏掉一大半。真实世界里存在这些形态：

| 形态 | 例子 | 谁在用 |
|---|---|---|
| 多段连字符 | `8-3-2015`、`5-5-9-13`、`2-3-05025`、`109-6-4006` | 菜鸟、兔喜、妈妈驿站 |
| 字母段 | `A88123`、`H-01485`、`D4-7048` | 中邮驿站、邻里驿站 |
| 纯数字 | `470812`、`72778` | 丰巢、速递易 |
| `凭` 引导 | `请凭0614-056取件`、`凭0202-0047到` | 申通、邮政 |

同时还要**不能误报**。以下都是精心排除过的负样本：

- 手机号 `13812345678`、掩码号 `138****5678`
- 订单号 / 运单号（`YT764306505052`）
- 年份日期 `2024-06-15`、时间 `12:30`
- 格口号 `A区123格` 里的 `123`
- 快递员尾号 `取尾号9100`
- 银行/登录验证码、外卖通知、10086 流量提醒

解析器有**两条锚点路径**（关键词锚点 + `凭` 引导字），都抓不到时还有一层
**兜底评分**（特征词 + 动作词 + 码形打分，≥3 分才采纳），避免包裹静默消失。

### 2. 离线可验证：把解析逻辑做成 Node 与 Kotlin 双实现

Android 代码的解析逻辑很难测（要跑模拟器、造短信）。所以核心算法写了两份：

- `app/.../core/PickupParser.kt` —— 真正跑在 App 里的
- `tools/node/extract.mjs` —— 同规则的 Node 镜像，**可以用命令行秒级回归**

**105 条真实风格语料**（含 22 条必须拒收的负样本）跑在 Node 版上，
再用 `tools/node/check-kotlin-parity.mjs` 把两版的正则**逐条自动比对**，
防止改一边忘另一边。

### 3. 没有 Gradle 也能出 APK

`tools/build-manual.mjs` 直接用 Android SDK 的原生命令走完标准构建流程：

```
aapt2 compile → aapt2 link (+R.java) → kotlinc → d8 → 塞入 classes.dex → zipalign → apksigner
```

这条路是在一个**跑不了 Gradle** 的环境里逼出来的（沙箱禁止 AF_UNIX 的 `connect`，
导致 `Selector.open()` 必失败，而 Gradle daemon 与 worker 都依赖它）。
副产品是一份可复现的「手工构建 Android APK」参考实现。

### 4. 静态自检打不过真实运行 —— 两个只有跑起来才暴露的 bug

开发过程中，105 条语料全绿、跨文件调用检查 0 错误、资源引用 0 缺失，
但装到模拟器上一开就闪退：

```
NoClassDefFoundError: Failed resolution of: Lkotlin/collections/CollectionsKt;
```

**Kotlin 标准库没打进 APK** —— Gradle 会自动带 `kotlin-stdlib` 依赖，手工构建漏了，
而 Android 平台不提供 Kotlin 运行时。

修完闪退，又发现**新短信根本进不来**：`SmsReceiver` 用了
`android:exported="false"`，实测 A/B 对照确认系统 `SMS_RECEIVED` 不会投递。

这两个 bug 都是静态检查抓不到的，只能靠真机/模拟器。相关脚本留在 `tools/` 里
（`emulator-setup.ps1`、`emulator-sms.mjs`、`verify-on-emulator.mjs`），
方便以后继续做端到端验证。

## 安装

### 方式一：下载已编译的 APK

从 [Releases](../../releases) 下载 `pickup-code-debug.apk`，传到手机安装
（需允许「安装未知来源应用」）。

### 方式二：自己编译

```bash
# 需要 JDK 17 + Android SDK 34（build-tools 34.0.0）
npm run build        # → pickup-code-debug.apk
```

也可以双击 `tools/build-now.cmd` 走 Gradle，或用 Android Studio 打开本目录
（`File → Open` → `Build → Build APK(s)`）。详见 [`BUILD.md`](BUILD.md)。

### 装好后

1. **允许读取短信** —— 否则收不到快递短信
2. **开启通知使用权** —— 设置 → 通知 → 通知使用权 → 打开「取件码管家」
3. **放开省电限制** —— 设置 → 应用 → 电池 → 不受限制（否则系统会杀后台）

详细的分品牌路径和疑难排查见 [`使用手册.md`](使用手册.md)。

## 验证

不需要 Android 环境，有 Node 就能跑：

```bash
npm test
```

会依次执行：

| 检查 | 覆盖 |
|---|---|
| 语料回归 | 105 条真实风格短信，含 22 条负样本 |
| Kotlin/Node 一致性 | 47 条正则逐条比对 |
| JSON 编解码契约 | SharedPreferences 存储格式 |
| 二维码闭环 | 自写编码器 ↔ 解码器互验（扫码下载功能用） |
| 资源/清单静态检查 | R 引用、清单组件、禁用依赖 |
| Kotlin 跨文件调用 | 函数 arity、成员存在性、契约名 |

## 项目结构

```
pickup-code-android/
├── app/src/main/java/com/pickupcode/app/
│   ├── core/    PickupItem.kt      数据模型（纯 Kotlin）
│   │            PickupParser.kt    解析算法（纯 Kotlin，可脱离 Android 单测）
│   │            Json.kt            手写极简 JSON
│   ├── store/   PickupStore.kt     SharedPreferences 持久化 + 去重 + 45 天过期
│   ├── input/   SmsReceiver.kt     短信广播
│   │            SmsScan.kt         历史短信导入
│   │            NotifyListener.kt  通知监听
│   │            ShareImportActivity.kt
│   └── ui/      MainActivity.kt    列表 UI
│                PickupAdapter.kt
│                UiFormat.kt
├── tools/                          离线验证 / 构建 / 二维码（不打包进 APK）
├── CONTRACT.md                     接口契约与解析规则定义
├── BUILD.md                        编译说明
└── 使用手册.md                      面向使用者的操作手册
```

## 技术栈

- **Kotlin** + View/XML（`findViewById`，不用 Compose）
- **零第三方依赖** —— 不引 AndroidX、不引任何库，`dependencies {}` 是空的
- minSdk 29 / targetSdk 34 / compileSdk 34
- 四个输入通道：`SMS_RECEIVED` 广播、`content://sms/inbox` 扫描、
  `NotificationListenerService`、`ACTION_SEND` / `ACTION_PROCESS_TEXT`

## 隐私

- **不联网**：清单里没有 `INTERNET` 权限，代码里也没有任何网络调用
- 所有解析与存储都在本机 `SharedPreferences` 完成
- 无账号、无统计、无广告、无云同步

## 合规说明

`RECEIVE_SMS` / `READ_SMS` 属于 Google Play 的**受限权限**，只有「默认短信应用」
才有资格申请。因此本应用**不能上架 Google Play**，定位是**自用工具 + 侧载安装**。
如需上架国内应用商店，请自行评估各商店对短信权限的政策。

请只在自己的手机上解析自己的快递短信。

## 致谢

解析规则的很多细节（字母段码形、多段连字符、`尾号`/`格口` 排除、各驿站特殊格式）
是从下面这些开源项目的**实战回归用例**里学到的思路。**没有复制任何代码**，
但规则思路受益于它们，特此致谢：

- [O-kai/Xiaomi-HyperOs-pickup-code-grabber](https://github.com/O-kai/Xiaomi-HyperOs-pickup-code-grabber)
  （MIT）—— 字母段码形 `A88123`/`D4-7048`、多段连字符 `5-5-9-13`、
  `尾号` 与 `格口` 排除、兜底评分阈值
- [yimeifun/ExpressPickupHelper](https://github.com/yimeifun/ExpressPickupHelper)
  （MIT）—— `凭0614-056取件` 系列锚点、各驿站/快递公司特殊格式、消息级黑名单
- [SongZX0106/PickCode](https://github.com/SongZX0106/PickCode)（木兰宽松许可证）
  —— 通知监听通道与本地化存储的产品形态参考

## License

[MIT](LICENSE)
