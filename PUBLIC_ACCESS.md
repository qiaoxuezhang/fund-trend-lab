# 公网访问状态

更新日期：2026年8月11日

## 当前固定地址

```text
https://fund-trend-lab.onrender.com/
```

该地址由 Render 提供 HTTPS。新访客默认空组合，添加的基金和历史交易只保存在访问者自己的浏览器中。需要限制访问时，在 Render 设置 `APP_ACCESS_PASSWORD` 与 `APP_SESSION_SECRET`，重新部署后主页和基金 API 都会启用访问验证。

## 同一 Wi-Fi 访问

服务现在默认监听全部本机网络接口。当前局域网地址为：

```text
http://192.168.31.151:4173/
```

手机和电脑必须连接同一 Wi-Fi；如果 Windows 防火墙阻止端口 `4173`，需要允许 Node.js 在“专用网络”中通信。局域网地址不适合公开推广，也不应在路由器上直接映射到互联网。

## Render Free 边界

- 免费实例可能在无人访问时休眠，首次打开会有冷启动等待。
- 当前没有客户账户数据库；用户通过浏览器本地数据隔离，并可使用加密保险箱手动迁移。
- Render 子域名用于技术访问，品牌推广建议绑定自有域名。

## 长期固定地址

项目已经提供 `Dockerfile`、`render.yaml`、PWA Manifest 和 Service Worker。可在 Render 的 Custom Domains 中绑定自有品牌域名；具体步骤见 `DEPLOYMENT.md`。

本地开发服务仍使用 `http://127.0.0.1:4173/`，只用于本机测试，不影响 Render 公网地址。
