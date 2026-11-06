# HGhub iOS 版（自用侧载）

上游官方只发布 Windows / macOS / Android。本分支在不改业务功能的前提下补齐 iOS：

- `src/api.ts`：识别 iPhone / iPad（含 iPadOS 伪装成 Mac 的情况），自定义协议地址按 Rust 侧约定走 `hg://localhost`（原来只判 Mac，iPhone 上会误判成 `http://hg.localhost`，封面和视频会全挂）；新增 `ios` 平台类型，移动端布局、安全区、弹层与安卓共用同一套逻辑
- `src/store.tsx`、`src/App.tsx` 等：`Platform` 增加 `"ios"`，iOS 走移动端壳（底栏、安全区），不走桌面壳
- `src-tauri/src/api.rs`：iOS 的 `open_url` 与安卓一致（原来会落到 `xdg-open` 分支，iOS 上不存在）
- `src/index.css`：`.plat-ios` 与 `.plat-android` 同等处理
- `src-tauri/tauri.ios.conf.json`：iOS 最低系统 15.0
- `src-tauri/icons/ios/`：上游仓库本来就带全套 iOS 图标，`tauri ios init` 会直接用
- `.github/workflows/ios-unsigned.yml`：在 GitHub 的 macOS 机器上打**未签名** IPA，全程不需要 Apple 账号和任何密钥

## 路线 A：GitHub 云端打包（推荐，不用碰自己的 Mac）

1. 把这份代码推到**你自己的** GitHub 仓库（新建 private 仓库即可，别推回上游）
2. 打开仓库的 **Actions** 页 → 左侧选 **iOS (unsigned IPA)** → **Run workflow**
3. 跑完后在那次运行的页面底部 **Artifacts** 里下载 `ios-unsigned`，解压得到 `HGhub_<版本>_ios_unsigned.ipa`
4. 按下面「侧载安装」把 IPA 装进 iPhone

推 `v*` 标签也会自动触发一次，但产物只在 Actions 里，不会发 Release。

## 路线 B：在自己的 Mac 上本地打包

需要：完整 Xcode（打开一次接受协议）、Homebrew 的 CocoaPods、Rust。

```bash
rustup target add aarch64-apple-ios
pnpm install
pnpm tauri ios init          # 生成 src-tauri/gen/apple 工程（不入库）
pnpm tauri ios build --no-sign --ci --target aarch64
# 产物：src-tauri/gen/apple/build/ 下的 .ipa（未签名）
```

## 侧载安装（免费 Apple ID + SideStore）

未签名 IPA 不能直接装，SideStore 会在安装时用你的免费 Apple ID 现场重签：

1. iPhone：**设置 → 隐私与安全性 → 开发者模式** 打开（iOS 16+，会重启一次）
2. 电脑上先装一次 SideStore（用它的官方安装器，插线完成第一次安装），之后日常刷新不用再插线
3. 打开 SideStore，用你的 Apple ID 登录（这一步只在你手机和苹果服务器之间，不要把密码给任何人/任何网站）
4. SideStore 里点 **+**，选下载好的 `HGhub_..._ios_unsigned.ipa` 安装
5. **设置 → 通用 → VPN 与设备管理** 里信任你的开发者 App

免费签名的硬限制（苹果定的，绕不过去）：

- 签名 **7 天**过期；SideStore 能在同一 Wi-Fi 下自动续签，别让它断太久，过期了打开 SideStore 刷新一次即可
- 同时最多装 **3 个**侧载 App（SideStore 自己占 1 个）
- 每 7 天最多注册 10 个 App ID

## 已知未验证项

- 本分支只在本地验过前端构建（`tsc` 类型检查 + Vite 打包均通过）。**Rust/iOS 真机编译的第一次验证就是 Actions 那一跑**，若红了看日志：常见是 Xcode 版本、CocoaPods 或 Rust target 问题，代码逻辑本身与安卓共用、风险不大
- 播放走的是 hls.js，iOS 的 WKWebView 里若 hls.js 不可用会自动回退到系统原生 HLS（代码里已有这条后路），但自定义协议 `hg://` 在原生播放器下的表现**必须真机实测才算数**——装上后先随手点开一部剧验证，能播再长期用
- 应用内「检查更新」查的是上游 Release，iOS 版不会有对应产物，看到更新提示忽略即可，新版本手动重打 IPA 覆盖安装

## 许可证

上游自 v1.1.0 起为 PolyForm Noncommercial 1.0.0：仅限个人学习、自用，禁止任何商业用途。本分支仅供自用侧载，不要公开分发打包好的 IPA。
