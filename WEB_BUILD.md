# HGhub 网页版（纯手机使用）

原理：前端还是同一套界面，桌面版里干活的 Rust 后端被等价搬成一个零依赖的
Node 服务（`web/server.mjs`：接口信封、封面 AES 解密、HLS 代理、线路切换、
登录会话全都在）。浏览器打开就是 App，iPhone 上「添加到主屏幕」后全屏运行，
没有签名、没有过期、不用电脑。

已实测（2026-11-07 本地）：首页信息流、搜索、排行榜、封面解密、播放信息、
m3u8 改写、分片拉取全链路真实跑通。

## 本地先跑一眼

```bash
pnpm install && pnpm build
ACCESS_TOKEN=换成你的口令 node web/server.mjs
# 打开 http://localhost:8080/?key=换成你的口令 （第一次带口令，之后自动记住）
```

## 部署（任选其一，Dockerfile 已备好）

### Railway / Render 等容器平台

仓库推上去选 Dockerfile 部署即可。环境变量：

- `ACCESS_TOKEN`：**必设**。不设等于把站公开，谁拿到网址都能用你的服务器流量刷剧
- `PORT`：平台自动注入，不用管

### 自己的 VPS（Docker）

```bash
docker build -t hghub-web .
docker run -d --name hghub-web --restart unless-stopped \
  -p 8080:8080 -e ACCESS_TOKEN=换成你的口令 hghub-web
```

前面再套一层 HTTPS（Caddy / Nginx 反代到 8080）就能用域名访问；
直接用 `http://服务器IP:8080` 也能跑，只是登录密码走明文，自用短时间可以、长期建议上 HTTPS。

## 手机上怎么用

1. Safari 打开 `https://你的地址/?key=口令`（第一次）
2. 分享菜单 → **添加到主屏幕**
3. 之后点桌面图标打开，全屏、竖屏，和原生 App 一样的用法
4. 登录、收藏、线路切换都按浏览器会话保存（cookie），清浏览器数据会掉登录

## 注意

- 「检查更新」查的是上游桌面版 Release，网页版忽略提示即可
- 上游接口、解密方式若变更，桌面版和网页版会一起失效，跟上游仓库更新后重新部署即可
- 许可证同上游：PolyForm Noncommercial，仅限个人自用，不要公开分发或拿去变现
- `ACCESS_TOKEN` 别发给任何人；它和登录密码是两回事（口令是进站门，账号在站内另登）
