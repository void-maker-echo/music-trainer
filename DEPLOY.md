# 音感训练营部署说明

## 本地运行

```bash
npm start
```

启动后终端会显示：

- 训练入口：`http://localhost:8789`
- 所有者管理入口：`http://localhost:8789/admin`
- 本次本地管理员口令
- 初始一次性邀请码

第一次启动时，服务器会在 `data/invites.json` 里创建一个初始一次性邀请码。以后可以打开 `/admin`，输入管理员口令生成新的邀请码。

## 正式部署

这是普通 Node.js 网页服务，支持部署到能运行 Node 18+ 的平台，例如云服务器、Render、Railway、Fly.io、宝塔面板等。

## 推荐：Render 永久公网网址

项目已经包含 `render.yaml`，可以直接用 Render 部署。步骤：

1. 先把本项目推送到 GitHub 仓库。
2. 打开 Render 控制台，选择 `New +` -> `Blueprint`。
3. 连接这个 GitHub 仓库。
4. Render 会读取 `render.yaml` 并创建 `music-trainer` Web Service。
5. 在环境变量里设置 `ADMIN_TOKEN` 为你的管理员口令。
6. 部署成功后，Render 会显示一个固定公网网址，例如：

```text
https://music-trainer-xxxx.onrender.com
```

这个地址就是学生访问的网址。管理员入口是在后面加 `/admin`：

```text
https://music-trainer-xxxx.onrender.com/admin
```

Render 免费服务长时间无人访问可能会休眠，第一次打开会慢一点，但网址是固定的。需要更稳定的课堂使用体验，可以升级 Render 付费实例或部署到自己的云服务器。

正式部署时必须设置环境变量：

```bash
ADMIN_TOKEN=一个足够长的管理员口令
INVITE_SECRET=一个足够长的随机密钥
PORT=平台指定端口
```

部署完成后，平台会给你一个公网访问地址，比如：

- `https://你的应用名.onrender.com`
- `https://你的域名.com`
- `http://服务器IP:端口`

这个地址就是别人打开网页的网址。管理员生成邀请码的地址是在公网地址后面加 `/admin`，例如：

```text
https://你的域名.com/admin
```

## 安全说明

- 邀请码只在服务器端校验，前端页面不再生成或保存邀请码。
- 邀请码在 `data/invites.json` 中以哈希形式保存。
- 默认新邀请码是一次性使用，可以在管理页调整可使用次数。
- 训练页面需要服务器设置的登录 Cookie，未登录会跳转到 `/login.html`。
- `data/` 和 `.env` 已加入 `.gitignore`，不要提交真实运行数据和密钥。
