# NIcoNIco 网关拦截核查资料（待发送）

您好，同频服务端向贵站 `https://yes.hubniconico.com` 发起文本 AI 请求，收到的不是模型 JSON 错误，而是 Cloudflare HTML 拦截页。更换密钥后部分请求正常，Windows 成员新建对话发送“你好”仍被拦截。

请按以下信息核查安全网关事件及对应规则，确认这一 API 接入的受支持调用方式；不要直接判断为成员额度不足或要求每位成员另建密钥。

- 时间：2026-09-10 11:07:00.620（香港时间，UTC+8）；UTC 为 03:07:00.620。
- 模型：`gpt-5.6-sol`，深度模式。
- HTTP 状态：403。
- Cloudflare Ray ID：`a38b3850ee2efb86-SIN`。
- 同频请求编号：`67301553-9d18-4cf8-b67b-ad6c0f6c9dfe`。
- 前一条同类失败：11:06:45.224（UTC+8），Ray ID `a38b37f0999cfb86-SIN`。
- 响应分类：`gateway_block / cloudflare_block_page / html`。

请告知触发规则、是否与请求来源/请求格式相关，以及官方支持的修正方案。本资料未包含 API 密钥、密码或成员个人资料。

说明：以上是已核实的故障资料，尚未向服务商发送，也不代表故障已解除。

## 对“是不是没让它走代理”的补充回复

这是自建的同频桌面软件，桌面端请求同频后端，再由 Cloudflare Workers 请求 NIcoNIco；API 密钥仅保存在后端，不是每台 Windows 电脑直接请求你们的接口。

请确认贵站是否支持 Cloudflare Workers 服务端调用，并按 Ray ID `a38b3850ee2efb86-SIN`（2026-09-10 11:07:00，UTC+8）核查命中的网关规则，告知支持的接入方式。客户端开代理不等于改变服务端的 API 出口，因此暂不据此调整成员电脑的代理设置。

2026-09-10 本机已安装应用 `electron/app-config.json` 的 `apiUrl` 已读取核实为 `https://notify.samhubs.com`；服务端调用路径和全局密钥读取逻辑已核对。尚未对故障 Windows 机器进行新的成功验收。
