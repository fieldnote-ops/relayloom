# RelayLoom

RelayLoom 是一个独立、默认关闭的外部聊天中继。首个兼容适配器把钉钉 Stream 公共协议接入 DeepSeek Harness Agent。

当前仓库属于开发者预览，不能宣称为已验证的生产机器人：无凭据协议核心、官方 SDK 绑定、Webhook 出站传输和真实 DSH 安装/启动已经过测试；但尚未在真实钉钉租户中完成“接收 → ACK → 回复”闭环。

## 已实现

- 在异步模型任务结束前立即 ACK；
- 按 `msgId` 去重并限制内存；
- 私聊与群聊 @ 过滤；
- staff id 白名单默认拒绝；
- 稳定、发送者隔离的会话，以及不暴露原始会话信息的确定性存储 id；
- DSH Agent 创建/恢复、preset 挂载、已提交回答转发、取消与有界拆卸；
- 一次性、会过期、绑定发送者和会话的 `/approve`、`/reject` 决策；
- 官方 `sessionWebhook` Markdown 回复，并限制精确 HTTPS 域名、拒绝重定向、限制响应大小、设置超时、检查过期时间及拆分长输出；
- bundle 默认 `enabled: false`，所以安装和启动不会读取钉钉凭据或发起钉钉请求。

文字审批是安全回退协议，不代表交互式审批卡已经可用。卡片渲染/更新、附件、重连重放和真实租户闭环仍待验证。

## 从 GitHub 安装

DeepSeek Harness 仍处于 Developer Preview，建议审阅后固定 RelayLoom 的完整提交 SHA：

```sh
dsh plugin --profile web add github:fieldnote-ops/relayloom#FULL_COMMIT_SHA
```

安装后仍默认关闭。创建钉钉企业内部机器人、并在启动环境设置凭据后，才修改 profile：

```yaml
- id: relayloom
  name: relayloom
  config:
    enabled: true
    clientIdEnv: DINGTALK_CLIENT_ID
    clientSecretEnv: DINGTALK_CLIENT_SECRET
    allowedUsers:
      - your-staff-id
    preset: standard
```

RelayLoom 不从 YAML 读取凭据；启用时空白名单会直接拒绝启动。

## 证据边界

本地测试覆盖协议规范化、ACK 顺序、去重、串行化、DSH 会话创建/恢复、已提交输出、取消、审批身份绑定、Webhook SSRF 防护和默认关闭生命周期。HarnessProof v0.1.5 在隔离副本中安装精确锁定依赖，通过官方 DSH 命令加入插件，观察到 bundle 层，启动 DSH `0.1.0-rc.6` 并收到 HTTP 200；全过程不需要凭据，也不访问外部服务。

这些证据不证明真实钉钉机器人、审批卡行为、独立安全审计、陌生用户采用、Marketplace 接受、购买或收入。

## 开发

```sh
npm ci --ignore-scripts
npm run check
```

直接运行依赖为钉钉官方 `dingtalk-stream` Node SDK。协议参考见英文 README。

RelayLoom 是 FIELD NOTE 的 AI 辅助、人工复核互操作实验，与钉钉、阿里巴巴、DeepSeek 或其关联方无隶属、赞助、背书或官方关系。产品名称仅用于说明兼容目标；项目不使用相应 logo 或品牌视觉。

MIT 许可。
