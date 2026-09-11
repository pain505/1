# 取件码管家 — 接口契约（所有并行工作必须严格遵守）

> 本文件是唯一事实来源。任何实现与本文件冲突 = 实现错，不是文档错。

## 0. 目标

Android App「取件码管家」：在用户本机读取取件类短信 + 监听购物类 App 通知，
自动解析出**取件码 / 取件地址 / 快递公司 / 到件时间**，汇总成一个按取件点分组的列表，
一眼看出「去哪取、码是多少、还剩多久过期」。

- 包名 `com.pickupcode.app`，app 名称「取件码管家」，minSdk 29，targetSdk 34，compileSdk 34。
- 语言 Kotlin，视图体系（View/XML），**不用 Compose**。
- **只用 Android 平台 API，不引入任何 AndroidX / 第三方依赖**（网络受限，依赖越少越稳）。
- 构建：Gradle 8.x + AGP 8.x + Kotlin 1.9.x，产出 `assembleDebug` APK。

## 1. 目录结构（固定，不许改名）

```
pickup-code-android/
  CONTRACT.md
  README.md                      # 面向用户：怎么装、怎么用、怎么编译
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  gradle/wrapper/gradle-wrapper.properties
  local.properties.example
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/java/com/pickupcode/app/core/PickupItem.kt     # 纯 Kotlin，禁止 import android.*
  app/src/main/java/com/pickupcode/app/core/PickupParser.kt   # 纯 Kotlin，禁止 import android.*
  app/src/main/java/com/pickupcode/app/core/Json.kt           # 纯 Kotlin 极简 JSON 读写
  app/src/main/java/com/pickupcode/app/store/PickupStore.kt   # SharedPreferences 持久化 + 去重
  app/src/main/java/com/pickupcode/app/input/SmsReceiver.kt
  app/src/main/java/com/pickupcode/app/input/SmsScan.kt        # 首次导入历史短信
  app/src/main/java/com/pickupcode/app/input/NotifyListener.kt
  app/src/main/java/com/pickupcode/app/input/ShareImportActivity.kt
  app/src/main/java/com/pickupcode/app/ui/MainActivity.kt
  app/src/main/java/com/pickupcode/app/ui/PickupAdapter.kt
  app/src/main/res/layout/*.xml
  app/src/main/res/values/strings.xml, colors.xml, themes.xml
  app/src/main/res/drawable/*.xml
  app/src/main/res/xml/ (backup rules 可省)
  tools/node/extract.mjs         # Node 镜像实现（用于离线验证算法）
  tools/node/samples.json        # 测试语料（带期望值）
  tools/node/run-tests.mjs       # 跑语料，输出 PASS/FAIL 统计，退出码非 0 表示失败
```

## 2. 数据模型 `PickupItem`（Kotlin data class）

```kotlin
data class PickupItem(
    val id: String,          // 稳定去重键：normalize(code) + "|" + normalize(location)
    val code: String,        // 取件码原文，如 "8-3-2015" / "123456"
    val keyword: String,     // 命中的关键词，如 "取件码"
    val courier: String?,    // 快递公司，如 "菜鸟驿站"/"丰巢"/"京东"/"顺丰"，未知为 null
    val station: String?,    // 取件网点名，如 "菜鸟驿站(阳光花园店)"，未知为 null
    val note: String?,       // 附加提示，如 "请24小时内取件" 截断片段，未知为 null
    val source: String,      // "sms" | "notification" | "import" | "manual"
    val sourceApp: String?,  // 通知来源包名，短信为 null
    val rawText: String,     // 原始文案（截断到 300 字）
    val eventTime: Long,     // 短信/通知时间戳（毫秒）
    val createdAt: Long,     // 入库时间（毫秒）
    val picked: Boolean,     // 是否已取件
    val expireAt: Long?      // 过期时间戳（毫秒），算不出为 null
)
```

`Json.kt` 必须提供 `PickupItem` 的 `toJson(): String` 与 `fromJson(String): PickupItem?`，
以及 `List<PickupItem>` 的编解码。**不引第三方 JSON 库**，手写转义（`"` `\` `\n` `\r` `\t`
和控制字符 `\u00XX`）。解析失败必须返回 null 而不是抛异常。

## 3. 解析算法（`PickupParser`，纯函数，唯一权威规则）

```kotlin
object PickupParser {
    fun parse(text: String, source: String, eventTime: Long, sourceApp: String? = null): List<PickupItem>
    fun normalize(s: String): String   // 去空白、全角转半角、小写、去 () （） 空格 连字符与点
    fun detectCourier(text: String): String?
}
```

### 3.1 全角转半角

先做字符级归一：`U+FF01..U+FF5E` 减 `0xFEE0`；`U+3000` → 空格。之后所有匹配都在归一化文本上做。

### 3.2 关键词（按顺序匹配，命中最长者优先）

| 关键词 | 权重 |
|---|---|
| 取件码 / 取货码 / 提货码 / 取货号 / 取件号 / 取件编码 | 100 |
| 提货码 / 取包裹码 | 100 |
| 取件密码 / 开门码 / 开柜码 | 90 |
| 验证码（仅当同文出现 快递柜/驿站/取件/包裹） | 50 |
| 包裹码 / 快件码 | 80 |

### 3.3 取码规则（在关键词命中位置的 ±20 字符窗口内按序尝试）

1. **连字符码**：`(?<![\d-])(\d{1,2})-(\d{1,2})-(\d{2,4})(?![\d-])` → 如 `8-3-2015`
2. **两段码**：`(?<![\d-])(\d{1,2})-(\d{2,4})(?![\d-])` → 如 `2-3015`
3. **紧邻数字**：关键词后 0~3 个非数字字符内 `(\d{4,8})` → 如 `取件码 123456`、`取件码：8848`
4. **6位及以上纯数字**：关键词后 20 字符窗口内 `(?<!\d)(\d{6,10})(?!\d)` → 如丰巢 `123456`
5. **4~5 位纯数字**：窗口内 `(?<!\d)(\d{4,5})(?!\d)`，**要求**同文命中快递柜/驿站/超市/代收点等网点词

### 3.4 取值规则（防止把别人的号当取件码）

某候选值只要命中**任一**条件就丢弃：

- 落在手机号形态里：`(1[3-9]\d{9})` 内，或前面 0~2 字符处就是 `1[3-9]` 开头
- 是 `20\d{2}` 且后面紧跟 `年|月|日`
- 前后 3 字符内含 `元|分钟|小时|天|kg|克|电话|手机|订单|运单|编号` 之一
- 是 4 位且以 `19|20` 开头（年份）
- 等于这些保留号：`11183 11185 95554 95338 4001 10086 10010 10000 12305 95311`
- 与 `运单号/订单号/快递单号` 关键词距离 ≤ 6 字符
- 是 `\d{11,}` （太长，是单号不是取件码）

**3.4.1 位置形态排除**（逐字符判断，来自 O-kai 项目的实战回归用例）

- 候选 token **下一个字符是 `号`** → 丢（`货架号5-5-9-13` 里的 `5-5-9-13` 要留，
  但 `订单号123456号`、`取尾号9100` 这类要丢；注意 `货架号/柜号/箱号` 是**正向**前缀，
  见 3.4.2，不要误伤）
- 候选 token **前一个字符是 `*`** → 丢（`138****5678` 的掩码尾段）
- 候选 token 后面紧跟 `:` 且 token 形如 `\d{1,2}` → 丢（`时间 12:30`）
- 窗口（±8 字）内含 `尾号` → 丢（`取尾号9100包裹`）
- 候选 token 与 `运单号/订单号/快递单号/快件号` 距离 ≤ 6 字 → 丢
- 候选 token **前一个或后一个字符是 `格` / `区`** → 丢（`A区123格` 里的 `123` 是格口号）
- **锚点优先级**：关键词锚点命中时，**优先取锚点之后的候选**；只有当锚点之后窗口内确实没有
  合法候选时，才回头考虑锚点之前的。这条保证 `A区123格，取件码 470812` 取到 `470812` 而不是 `123`。

**3.4.2 货架号类正向前缀**：`货架号|货架|柜号|柜子号|箱号|编号|格口` 后面紧跟的 token
**要保留**（`货架号：5-5-9-13` → 取 `5-5-9-13`），此规则优先于 3.4.1 的 `号` 排除。

### 3.4.3 消息级黑色名单（命中即整条不当作取件通知）

若文本命中下列任一（且**未**同时命中 3.4.4 的强取件特征），直接返回空：

- `验证码` 且窗口内无 `取件`（纯登录/支付验证码）
- `余额|话费|流量|积分|账单|消费|扣费|充值|还款|信用卡|贷款`
- `中奖|领取优惠券|点击链接|退订`
- `外卖|已送达|送达时间|骑手|点餐`
- 银行/运营商发件人特征：`955\d{2}|10086|10010|10000|106\d{8}`

### 3.4.4 强取件特征（出现即可豁免黑色名单）

`取件码|取货码|提货码|取件号|凭码|货架号|柜号|驿站|快递柜|丰巢|菜鸟|兔喜|妈妈驿站`

### 3.4.5 兜底评分（仅当 3.3 与 `凭` 锚点都没抓到任何码时启用）

遍历全文所有**码形合法** token（码形见 3.3.0），对每个 token 取 ±30 字窗口打分：

- 窗口含 3.2 的关键词 → +2
- 窗口含动作词 `领取|取出|凭|取件|取货|及时|尽快|速取|出示` → +2
- token 本身是连字符码形 → +1
- token 是 `\d{6,9}` → +1
- 窗口含强取件特征（3.4.4）→ +1

**得分 ≥ 3 才采纳**，按得分降序取，最多 6 个。这条兜底是「一条都没抓到」时的安全网，
宁可用它多抓，也不要让用户的包裹静默消失。

### 3.3.0 码形定义（后续所有规则共用）

| 名称 | 正则 | 例子 |
|---|---|---|
| 连字符码形 | `(?:[A-Za-z]-\d{1,6}\|[A-Za-z]?\d{1,6})(?:-[A-Za-z]?\d{1,6}){0,3}` | `8-3-2015`、`H-01485`、`D4-7048`、`5-5-9-13`、`2-3-05025`、`109-6-4006` |
| 字母数字码形 | `[A-Za-z]?\d{3,9}` | `A88123`、`72778`、`207406` |
| 纯数字码形 | `\d{3,9}` | `480979`、`0614` |

**关键**：`A88123`（中邮驿站）、`H-01485`（邻里驿站）、`D4-7048`、`109-6-4006` 都是真实存在的
取件码形态 —— 只抓纯数字会漏掉一大批，必须支持字母段与前导字母。
连字符码允许 **2~4 段**（`5-5-9-13` 是 4 段）。

**日期形状排除（必须实现，Kotlin 与 Node 两边一致）**：上面的字面量会把裸日期吃进来，
所以 `isHyphenCode` 里追加一条精准排除 —— **三段**且首段是 **4 位数字**、后两段各 **1~2 位**
（即 `2024-06-15`、`2024-6-1`）判为日期，不作为取件码。
注意**只**排这种精确形状：`0614-056`（两段）、`109-6-4006`（首段 3 位）都是真实取件码，必须保留。

### 3.3.2 窗口与上限的关系（§3.3 与 §3.5 的边界）

§3.3 的「±20 字窗口」用于限定**码的起点**必须在关键词附近；一条由分隔符连起来的 cluster
一旦起头，允许继续向后延伸收集，最终由 §3.5 的「上限 6 个」截断。
没有这条放宽，`1-1001、1-1002、…` 这种 6 件包裹的短信会因为超出 20 字而漏码。

### 3.3.1 `凭` 锚点（第二条主路径，与关键词锚点并列）

`凭` 是取件短信里最高频的引导字。规则：

- `请凭取件码\s*(码形)` / `凭取件码\s*(码形)` / `请凭码\s*(码形)` — 最高优先
- `请凭\s*(码形)\s*(来取|取件|领取|到)` / `请凭\s*(码形)`
- `凭\s*(码形)\s*(到|来取|领取|取件)`

抓到的 cluster 还要按 3.5 拆分成多个码。

### 3.5 一条消息产出多个码

同一条短信可能含多个取件码（多件包裹）。规则：

- 抓到的原文 cluster 按 `[,，、;；\s]+` **切分**，每一段单独做码形校验（这样
  `取件码为16-4-9626, 15-3-2194, 16-3-0906` 能一次拿到 3 个码）
- 关键词锚点与 `凭` 锚点各自独立扫全文
- 最终按 `normalize(code)` 去重（**保持出现顺序**，用 LinkedHashSet 语义）；同一文本最多 6 个

### 3.6 是否算取件通知

`parse()` 返回非空 = 取件通知。若命中关键词但取不到码，也要返回**一个**
`code = ""` 的条目，`keyword` 填命中词 —— 用于「有取件但没解析出码」的提醒，UI 标记为「需人工确认」。

### 3.7 网点 / 快递公司识别 `detectCourier`

按顺序匹配，命中即返回：

| 匹配 | 返回 |
|---|---|
| 丰巢 / 蜂巢 | 丰巢 |
| 菜鸟驿站 / 菜鸟 | 菜鸟驿站 |
| 速递易 / 中邮速递 | 速递易 |
| 京东 / 京喜 | 京东 |
| 顺丰 / 丰巢速运 | 顺丰 |
| 中通 | 中通 |
| 圆通 | 圆通 |
| 申通 | 申通 |
| 韵达 | 韵达 |
| 邮政 / EMS / 中国邮政 | 邮政 |
| 极兔 | 极兔 |
| 德邦 | 德邦 |

`station` 抽取：优先 `(菜鸟驿站|丰巢|速递易|京东|顺丰)[（(]([^）)]{2,20})[）)]` 的第 2 组；
否则找 `到(.{2,20}?)取件` / `请到(.{2,20}?)领取` 的第 1 组。取不到为 null。

**三条实测补充（真实文案必需，已实现，勿当偏差改掉）：**

1. 品牌与括号之间常夹设施类型：`丰巢快递柜(中兴路店)` → 网点名取 `中兴路店`。
   正则放宽为 `(菜鸟驿站|丰巢|速递易|京东|顺丰)[^)，,。；;]{0,6}?[(]([^)]{2,20})[)]`。
2. 品牌表之外的自营驿站也带括号网点名：`(?:快递超市|驿站|代收点|自提柜|快递柜|便利店|门卫|物业)[(]([^)]{2,20})[)]`
   （覆盖中邮驿站 / 邻里驿站 / 妈妈驿站 / 兔喜生活 …）。
3. `detectCourier` 把「中邮」并入**邮政**（契约表里 `邮政|EMS|中国邮政` 不含中邮，
   但 `中邮速递` 已归速递易，所以只在邮政一项加 `中邮`，**不改变表格顺序**）。

`expireAt`：先找 `(\d{1,3})\s*小时内取件` / `(\d{1,3})小时内`，`eventTime + n*3600_000`；
否则找文案里的 `(\d{1,2})月(\d{1,2})日\s*(\d{1,2})?[:：]?(\d{2})?前?`，按当地时区当天算；
否则 null。

`note`：命中 `请?(\d{1,3})小时内取件` / `请及时取件` / `超时(?:将)?(?:退回|收费)` 的
整句（最长 40 字），否则 null。

### 3.8 权重排序

一个条目可命中多个关键词，取权重最高的那个作为 `keyword`。

## 4. 输入通道（Android）

| 通道 | 文件 | 说明 |
|---|---|---|
| 短信广播 | `input/SmsReceiver.kt` | 静态注册 `android.provider.Telephony.SMS_RECEIVED`，`exported=false`，`priority=999`。解析 `pdus` → `SmsMessage.createFromMessage`。**不得** abort 广播。 |
| 历史导入 | `input/SmsScan.kt` | 首次启动时用 `content://sms/inbox` 扫描最近 60 天，`_id,address,body,date`。需要 `READ_SMS`。 |
| 通知监听 | `input/NotifyListener.kt` | `NotificationListenerService`，从 `extras` 取 `EXTRA_TITLE/EXTRA_TEXT/EXTRA_BIG_TEXT/EXTRA_TEXT_LINES` 拼接后解析。 |
| 分享/粘贴 | `input/ShareImportActivity.kt` | `ACTION_SEND`（text/plain）+ `ACTION_PROCESS_TEXT`，无界面 Activity，导入后 toast 并 finish。 |

通知监听只处理白名单包名（拼多多 `com.xunmeng.pinduoduo`、淘宝 `com.taobao.taobao`、
京东 `com.jingdong.app.mall`、支付宝 `com.eg.android.AlipayGphone`、菜鸟 `com.cainiao.wireless`、
微信 `com.tencent.mm`、QQ `com.tencent.mobileqq`），避免刷屏。

## 5. 存储 `PickupStore`

- `SharedPreferences` 单键存整个 `List<PickupItem>` 的 JSON。
- `upsert(items): Int` 按 `id` 去重；已存在则合并（`picked` 取 `or`，`station/courier/expireAt/note` 取非空值），返回新增条数。
- `all(): List<PickupItem>`、`markPicked(id, Boolean)`、`remove(id)`、`clearPicked()`。
- **自动过期**：`all()` 返回时过滤掉 `eventTime` 早于 45 天 的未取件条目（并在写入时物理清理）。
- 全静态方法 + `init(context)`，线程安全（`@Synchronized`）。

## 6. UI `MainActivity`

- 顶部：标题 + 统计条「未取 N 件 · 今日到期 M 件」。
- 权限区：未授权时显示可点击的提示行 → 依次申请 `RECEIVE_SMS`、`READ_SMS`，
  以及跳转 `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`。
- 列表：按 `station ?: courier ?: "未识别网点"` 分组，组内按 `expireAt ?: Long.MAX` 升序。
  每行显示：**取件码大字**、网点名、快递公司标签、时间（"2小时前"/"3天前"）、过期倒计时
  （"还剩 5 小时" / "已过期" / "已取件"）。
- 行操作：点击=复制取件码到剪贴板；长按=弹出「标记已取 / 删除 / 复制原文」。
- 右上角菜单：`立即扫描短信` / `粘贴导入` / `清空已取` / `使用说明`。
- 空态：一段说明文字告诉用户去授权。
- 已取件条目置灰划掉，默认折叠在列表末尾分组「已取件」。

## 7. 验证要求

### 7.1 Node 镜像（离线可跑，必须通过）

`tools/node/extract.mjs` 必须**逐条实现第 3 节全部规则**，导出的函数：
`extract(text, source='sms', eventTime=Date.now(), sourceApp=null) -> Item[]`，
字段名与 Kotlin `PickupItem` 完全一致。`tools/node/run-tests.mjs` 读 `samples.json`
逐条比对，输出：

```
TOTAL n  PASS x  FAIL y
FAIL: <id> 期望 code=..., 实得 [<codes>]
```

进程退出码 0 = 全过，1 = 有失败。

`samples.json` 格式：

```json
[{"id":"cainiao-01","text":"【菜鸟驿站】您的包裹已到菜鸟驿站(阳光花园店)，取件码 8-3-2015，请凭码取件",
  "expect":{"codes":["8-3-2015"],"courier":"菜鸟驿站","station":"阳光花园店"}},
 {"id":"neg-phone","text":"您的快递已到，配送员电话 13812345678","expect":{"codes":[]}}]
```

**至少 40 条语料**，覆盖：菜鸟多码、丰巢 6 位码、速递易、京东/拼多多/淘宝通知文案、
顺丰、邮政、多件包裹、全角冒号、无码只有关键词、负样本（验证码、银行、10086、
外卖、手机号、订单号、年份）。

### 7.2 Kotlin 一致性

`PickupParser.kt` 与 `extract.mjs` 必须行为一致；以 Node 版跑过语料为准，
Kotlin 版逐条对齐（正则与顺序完全一致）。

### 7.3 编译验证

目标：`gradlew.bat assembleDebug` 成功产出 APK。
本机无 JDK/SDK，由主 agent 负责安装工具链；子 agent 只负责产出源码与 Gradle 配置正确。

## 8. 合规

- 只在本机解析、不上传任何数据，README 里必须写明。
- 明确告知：读短信权限属于敏感权限，**不能上架 Google Play**（Google 只允许默认短信应用申请
  该权限），本 App 面向自用 / 侧载安装。
