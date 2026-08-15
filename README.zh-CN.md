# RelayLoom

[![Self-test](https://github.com/fieldnote-ops/relayloom/actions/workflows/self-test.yml/badge.svg?branch=main)](https://github.com/fieldnote-ops/relayloom/actions/workflows/self-test.yml)

RelayLoom 是一个独立、默认关闭的外部聊天中继。首个兼容适配器把钉钉 Stream 公共协议接入 DeepSeek Harness Agent。

当前仓库属于开发者预览，不能宣称为已验证的生产机器人：无凭据协议核心、官方 SDK 绑定、Webhook 出站传输和真实 DSH 安装/启动已经过测试；但尚未在真实钉钉租户中完成“接收 → ACK → 回复”闭环。

## 不只是通知 Webhook

| 维度 | 已实现边界 |
| --- | --- |
| 方向 | 接收钉钉 Stream 回调并发送有界 `sessionWebhook` 回复，不局限于单向群通知。 |
| 回调顺序 | 异步 Agent 任务结束前先 ACK；按 `msgId` 去重重试。 |
| 会话隔离 | 会话按发送者和 conversation 隔离；持久化 id 确定且不暴露原始租户标识。 |
| 审批回退 | `/approve`、`/reject` 一次性、会过期，并绑定原发送者与 conversation；不宣称交互式卡片已实现。 |
| 默认安全 | bundle 默认关闭；启用时要求非空 staff-id 白名单；凭据只从指定环境变量读取；拒绝不安全 Webhook 目标和重定向。 |
| 证据缺口 | 无凭据测试与 DSH rc.6/`latest`/`next` consumer 已通过；真实租户“接收 → ACK → 回复”仍**未**通过。 |

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

## 真实租户传输探针

0.2.3 提供一个显式启用的探针，在不调用模型或 DSH Agent 的前提下补齐传输证据。它只等待一个已配置 staff 账号发来的随机挑战，立即 ACK Stream 回调，发送一条有界 `sessionWebhook` 回复，并新建权限为 `0600` 的 JSON 报告。报告不记录凭据、原始 staff id、会话 id、消息 id、Webhook 或消息正文。

在钉钉开发者后台创建**企业内部应用**，在该应用内部添加机器人扩展，并保持机器人为 **Stream 模式**。从应用信息页复制 Client ID（AppKey）与 Client Secret（AppSecret）；不要使用旧版独立机器人入口。详见钉钉官方的[创建机器人](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/)与 [Node Stream 机器人](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/nodejs/build-bot/)说明。

先克隆仓库，并在禁用生命周期脚本的情况下安装锁定依赖：

```sh
git clone https://github.com/fieldnote-ops/relayloom.git
cd relayloom
npm ci --ignore-scripts --registry=https://registry.npmjs.org
```

通过交互读取 Client ID、Client Secret 和允许发送者的 staff id，避免任何一个值进入 shell 历史，然后运行：

```sh
printf 'DingTalk Client ID: '
IFS= read -r DINGTALK_CLIENT_ID
printf 'DingTalk Client Secret: '
IFS= read -r -s DINGTALK_CLIENT_SECRET
printf '\n允许发送者 staff id: '
IFS= read -r RELAYLOOM_ALLOWED_USER
export DINGTALK_CLIENT_ID DINGTALK_CLIENT_SECRET RELAYLOOM_ALLOWED_USER
npm run tenant:smoke
unset DINGTALK_CLIENT_ID DINGTALK_CLIENT_SECRET RELAYLOOM_ALLOWED_USER
```

从该 staff 账号向企业内部机器人发送进程打印的精确随机挑战。默认等待 180 秒；可用 `RELAYLOOM_PROBE_REPORT` 指定新的工作区相对报告路径，已有报告绝不会被覆盖。该命令会真实访问钉钉，但安装、DSH 启动、测试和 CI 都不会自动运行它。

## 从 GitHub 安装

为保证命令可以直接复制，请固定到最近一次完成公开验证的运行时提交，不要依赖移动分支：

```sh
dsh plugin --profile web add github:fieldnote-ops/relayloom#e789dded22a6eeb00bddde0d06e47d15e23eced6
```

该提交已经通过公开 Node 24 单元任务以及 DSH rc.6/latest/next consumer matrix。安装后仍默认关闭。创建钉钉企业内部机器人、并在启动环境设置凭据后，才修改 profile：

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

本地测试覆盖协议规范化、ACK 顺序、去重、串行化、DSH 会话创建/恢复、已提交输出、取消、审批身份绑定、Webhook SSRF 防护和默认关闭生命周期。HarnessProof v0.1.6 在隔离副本中安装精确锁定依赖，通过官方 DSH 命令加入插件，观察到 bundle 层，启动 DSH `0.1.0-rc.6` 并收到 HTTP 200；全过程不需要凭据，也不访问外部服务。真实租户探针是另一个显式网络操作，不能从 HarnessProof 结果推断其成功。

这些证据不证明真实钉钉机器人、审批卡行为、独立安全审计、陌生用户采用、Marketplace 接受、购买或收入。

## 开发

```sh
npm ci --ignore-scripts
npm run check
```

直接运行依赖为钉钉官方 `dingtalk-stream` Node SDK。协议参考见英文 README。

RelayLoom 是 FIELD NOTE 的 AI 辅助、人工复核互操作实验，与钉钉、阿里巴巴、DeepSeek 或其关联方无隶属、赞助、背书或官方关系。产品名称仅用于说明兼容目标；项目不使用相应 logo 或品牌视觉。

MIT 许可。
