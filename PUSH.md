# 上传到 GitHub

本目录已经是一个**已初始化、已提交、工作区干净**的 git 仓库，
还带了 push 前的自动校验钩子。你只需要做两件事。

> **为什么要你自己跑**：`git push` 首次会弹出 GitHub 登录（Git Credential Manager），
> 需要浏览器授权。这一步必须在**你自己的终端**里完成。

---

## 直接抄这两行

**先**去 https://github.com/new 建一个空仓库（名字建议 `pickup-code-android`，
**不要**勾选 README / .gitignore / license），**然后**在你自己打开的 PowerShell 里跑：

```powershell
cd C:\Users\Wangxinyu\Desktop\deepseek\pickup-code-android

git remote add origin https://github.com/你的用户名/pickup-code-android.git
git push -u origin main
```

把 `你的用户名` 换成你的 GitHub 用户名。首次推送会弹窗让你登录，
点 "Sign in with your browser" 授权即可，登录一次以后就记住了。

推送完打开 `https://github.com/你的用户名/pickup-code-android` 就能看到。

> 仓库当前的默认分支是 `main`，可直接推。
> 想再确认一遍没问题，可以先单独跑 `npm test`。

---

## 第 1 步：在 GitHub 建一个空仓库

打开 https://github.com/new

- **Repository name**：比如 `pickup-code-android`
- **Description**（可选，直接抄）：
  ```
  把短信、App 通知、微信里的取件码自动汇总成一张清单。纯本地解析，未申请 INTERNET 权限。Android / Kotlin / 零第三方依赖。
  ```
- **Public / Private 都行**（Private 也有免费 Actions 额度）
- ⚠️ **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license"
  —— 本仓库里都已经有了，勾了会产生冲突

建完页面会显示仓库地址，形如：
```
https://github.com/你的用户名/pickup-code-android.git
```

---

## 第 2 步：推送

命令就是开头那两行（`git remote add` + `git push -u origin main`）。
首次推送会弹出窗口让你登录 GitHub：点 "Sign in with your browser" →
浏览器里授权 → 回到终端会自动继续。登录一次以后就记住了。

### 推送前会自动校验

仓库里装了 `pre-push` 钩子，推送时会自动跑：

| 检查 | 期望 |
|---|---|
| 解析规则语料回归 | `TOTAL 105 PASS 105 FAIL 0` |
| Kotlin / Node 规则一致性 | `ALL KOTLIN RULES ALIGNED WITH NODE` |
| JSON 编解码契约 | `CODEC: PASS 0` |
| 二维码编码/解码闭环 | `QR SELF-TEST: PASS 9 FAIL 0` |
| 资源 / 清单 / 禁用依赖 | `CHECKED 12 files, ERRORS 0` |
| Kotlin 跨文件调用 | `KOTLIN-LINT ERRORS 0` |

任何一项失败都会**阻止推送**（故意的）。要绕过（不建议）：`git push --no-verify`。

> 钩子是 Node 实现（`tools/pre-push.mjs`），因为 Windows 上 Git Bash 的 `sh.exe`
> 在某些受限环境里起不来。`.git/hooks/pre-push` 只是个转发壳。
> 没装的话跑一次 `node tools/install-hooks.mjs`。

---

## 第 3 步（可选）：把 APK 放到 Releases

别人 clone 下来还要自己编译。如果你愿意提供编译好的包，
上传到 Releases 会自动成为仓库首页的下载入口。

**用网页上传**（最简单）：

1. 仓库页面右侧 → `Releases` → `Create a new release`
2. **Choose a tag** → 输入 `v1.0.0` → 点 `Create new tag`
3. **Release title**：`取件码管家 v1.0.0`
4. **Describe this release**（可直接抄）：
   ```markdown
   ### 功能
   - 自动汇总快递短信里的取件码，支持的码形：`8-3-2015`、`A88123`、`H-01485`、`5-5-9-13`、`470812`
   - 监听拼多多 / 淘宝 / 京东 / 菜鸟的通知，自动识别取件码
   - 支持从微信复制取件码后「分享」或「粘贴导入」
   - 按取件点分组展示，带过期倒计时
   - 纯本地解析，**未申请 INTERNET 权限**

   ### 安装
   下载 `pickup-code-debug.apk` 传到手机安装（需允许「安装未知来源应用」）。
   首次打开请授予短信权限、开启通知使用权，并把电池策略设为「不受限制」。

   ### 说明
   debug 签名，仅供自用。`RECEIVE_SMS` 是 Google Play 受限权限，本应用不上架商店。

   ### 校验
   语料回归 105/105、Kotlin/Node 规则一致性比对、静态自检与跨文件调用检查 0 错误。
   ```
5. 把 `pickup-code-debug.apk` 拖到 **Attach binaries** 区域
6. 点 `Publish release`

**用命令行上传**（装了 GitHub CLI 的话）：

```powershell
gh release create v1.0.0 pickup-code-debug.apk --title "取件码管家 v1.0.0" --notes-file RELEASE_NOTES.md
```

---

## 之后怎么更新

```powershell
git add -A
git commit -m "fix: 说明改了什么"
git push
```

推上去后 `.github/workflows/build-apk.yml` 会自动跑一次云端编译
（装 JDK + Android SDK → 跑离线校验 → `gradle assembleDebug` → 上传 APK artifact），
相当于给仓库加了一道独立的编译验证。在工作流页面能下载到那个 artifact。
