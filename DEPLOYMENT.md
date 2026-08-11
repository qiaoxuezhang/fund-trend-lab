# 净值罗盘部署说明

更新日期：2026年8月11日

## 推荐结构

当前零成本路线使用“GitHub 公开仓库 + Render Free Web Service + Render HTTPS 域名”。客户的自选基金、分组、成本、交易记录和止盈目标仍保存在各自浏览器中，云服务只处理公开基金数据查询与可重新生成的缓存。

## 部署到 Render

1. 使用现有 GitHub 仓库 `qiaoxuezhang/fund-trend-lab`。
2. 在 Render 控制台选择 `New > Blueprint`，连接该仓库。
3. Render 会读取根目录的 `render.yaml`，以 Docker 方式创建服务。
4. 等待 `/api/health` 返回成功后，使用 Render 分配的 HTTPS 地址访问。
5. 在服务环境变量中保持：

```text
HOST=0.0.0.0
NODE_ENV=production
ALLOW_INDEXING=false
```

6. 需要品牌域名时，在 Render 的 Custom Domains 中添加域名，再按控制台提示配置 DNS。

免费实例适合当前约 10 人的邀请测试。长时间无人访问后的首次打开可能需要等待服务启动；服务端不保存客户数据，因此休眠和重新部署不影响浏览器本地组合。

## Cloudflare 固定隧道方案

如果应用持续运行在自己的服务器上，可以登录 Cloudflare 账户，创建 Named Tunnel，将自有域名转发到：

```text
http://127.0.0.1:4173
```

Named Tunnel 的域名与隧道身份固定，适合已有 Cloudflare 域名的情况。不要把 Quick Tunnel 的随机地址当作长期品牌网址。

## 局域网测试

启动服务后，同一 Wi-Fi 的设备可访问：

```text
http://192.168.31.151:4173/
```

如果无法访问，先确认电脑没有休眠、手机与电脑处于同一局域网，并允许 Node.js 通过 Windows 专用网络防火墙。局域网 IP 由路由器分配，可能变化。

## 手机安装

通过 HTTPS 公网地址访问时，支持 PWA 的浏览器会提供“安装应用”或“添加到主屏幕”。安装后可以像普通应用一样从桌面启动。离线缓存只保存页面外壳，最新基金数据仍需要网络连接。

## 发布前检查

- `/api/health` 返回 `200`。
- 首页和单基金分析在手机、电脑上均无横向溢出。
- 新浏览器首次访问时组合为空。
- HTTPS 有效，分享按钮复制或分享的是正式公网域名。
- 当前邀请测试环境设置 `ALLOW_INDEXING=false`，并同时通过页面 meta 标签和响应头禁止搜索引擎索引。
- 不在源码、日志或环境变量中存放客户持仓、密码与保险箱文件。
