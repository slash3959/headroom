# `opencode-remote-proxy` 与 `headroom wrap opencode` 对比说明

本文说明 `opencode-remote-proxy` 替代了什么、没有替代什么，以及它在什么意义上是更精简的方案。

## 结论先行

`opencode-remote-proxy` 是一个面向 OpenCode 的**精简远端代理集成方案**。

它替代的是 `headroom wrap opencode` 中负责**把 OpenCode 流量导向代理**的那一层能力；它**并没有**替代 wrapper 其余的控制面职责，例如持久化配置修改、MCP 注册、provider 安装、备份/恢复，或者 wrapper 负责的生命周期辅助逻辑。

因此，更准确的表述应该是：

> `opencode-remote-proxy` 是对 `wrap opencode` 中**代理接入层**的精简替代，而不是对整个 wrapper 体验的完整替代。

## 为什么会有这个方案

`headroom wrap opencode` 的价值在于，它能为 OpenCode 提供一套接近开箱即用的本地接入体验，例如：

- 准备环境变量
- 注入 provider 配置
- 注册 Headroom MCP 支持
- 按需注册 Serena / memory 集成
- 通过 Headroom 管理的路径启动 OpenCode
- 在取消 wrapping 时保留并恢复用户原有配置

这些能力很方便，但它们的范围已经超过了“远端代理支持”本身。

`opencode-remote-proxy` 采取的是更窄的策略：

- 注入一个会话级的 OpenCode plugin
- 在进程内安装 transport hook
- 把代理路由能力传播到 Node 子进程
- 避免修改用户磁盘上的配置文件

正因为它的职责范围更窄，所以当真实目标只是“把 OpenCode 接到远端代理”时，它会显得更轻、更干净。

## 架构差异

### `opencode-remote-proxy`

`opencode-remote-proxy` 这条路径主要由三个文件构成：

- `opencode-remote-proxy.mjs`
- `opencode-plugin.mjs`
- `transport.mjs`

它的大致工作流程是：

1. 解析 `--proxy` 和可选的 `--opencode` 等启动参数。
2. 构建 OpenCode 的启动环境。
3. 启动 OpenCode。
4. 为当前会话加载 OpenCode plugin。
5. 为 `fetch`、`http`、`https`、`http2` 以及部分 `child_process` 入口安装 transport hook。
6. 将命中的请求路由到配置好的代理地址。
7. 通过 preload 注入，确保 Node 子进程继承相同的代理行为。

这是一种**以数据面为中心**的设计。它的重点是尽可能少地增加额外系统行为，只完成流量拦截与重路由。

### `headroom wrap opencode`

`headroom wrap opencode` 的主路径分布在 `headroom/cli/wrap.py` 和 `headroom/providers/opencode/config.py` 中。

除了流量路由以外，它还承担了很多 wrapper 侧职责，例如：

- 检查 `opencode` 是否存在于 `PATH`
- 启动或复用本地 Headroom proxy
- 向 OpenCode 配置中注入 provider 配置
- 在修改前快照 OpenCode 配置
- 在 unwrap 时恢复原始配置
- 注册 Headroom MCP 集成
- 注册或禁用 Serena 集成
- 按需配置 memory MCP
- 处理启动环境的整理与清理

这是一种**控制面 + 数据面**同时覆盖的设计。它天然就比纯 remote-proxy 路由要更宽。

## 能力对比矩阵

| 能力 | `headroom wrap opencode` | `opencode-remote-proxy` | 说明 |
|---|---|---|---|
| 启动 OpenCode | 是 | 是 | 两者都可以拉起 OpenCode |
| 将 OpenCode 流量路由到代理 | 是 | 是 | 这是两者共同覆盖的核心能力 |
| 会话级注入 | 部分具备 | 是 | `opencode-remote-proxy` 是会话局部行为 |
| 避免修改用户磁盘配置 | 否 | 是 | 这是 remote-proxy 的明显简化点 |
| Hook `fetch/http/https` 流量 | 是，但主要经由 wrapper 路径实现 | 是，且实现更直接 | `transport.mjs` 是核心 |
| 将路由能力传播到 Node 子进程 | 主要依赖环境与 wrapper 设置 | 是，通过 child-process hook + preload | remote-proxy 更直接 |
| Provider 配置注入 | 是 | 否 | 仅 wrapper 负责 |
| Headroom MCP 注册 | 是 | 否 | 仅 wrapper 负责 |
| Serena 注册/禁用 | 是 | 否 | 仅 wrapper 负责 |
| Memory MCP 配置 | 是 | 否 | 仅 wrapper 负责 |
| 配置快照 / 恢复 | 是 | 否 | 仅 wrapper 负责 |
| 持久安装 / unwrap 流程 | 是 | 否 | 仅 wrapper 负责 |
| 端口/客户端标记管理 | 是 | 否 | 仅 wrapper 负责 |

## `opencode-remote-proxy` 明确替代了什么

在下面这些场景里，`opencode-remote-proxy` 是一个很好的替代方案：

- 你只需要让 OpenCode 请求通过指定代理转发
- 你希望行为只作用于当前会话，而不是持久安装
- 你不希望自动修改 `opencode.json`
- 你希望系统副作用更少、运行面更小

在这个前提下，它就是更精简的方案。

## 它没有替代什么

`opencode-remote-proxy` 不应该被描述成“已经替代了整个 `headroom wrap opencode`”。

它目前没有替代 wrapper 的整套便利层能力，包括：

- 向 OpenCode 配置中注入 provider
- 为 Headroom 工具注册 MCP
- Serena 的设置与禁用逻辑
- memory MCP 的设置
- 已修改配置的备份与恢复
- wrapper 管理的持久安装 / unwrap 工作流
- 其他围绕本地接入的控制面生命周期辅助逻辑

如果这些能力仍然属于产品承诺的一部分，那么 wrapper 依然有保留价值。

## 为什么说它是“最精简”的方向

如果讨论范围被限定在“远端代理支持”本身，那么这个方案之所以更精简，主要有三个原因：

1. 它把范围收敛在**流量拦截与路由**上。
2. 它不为了单次会话去制造持久本地状态。
3. 它没有围绕一个可在进程内解决的问题，再额外搭建一层更大的 wrapper 控制面。

换句话说，它是**删掉了 wrapper 职责**，而不是把那些职责搬到别处继续存在。

## 取舍与代价

更小的设计并不意味着没有代价。它本质上是用更窄的职责边界，换掉了 wrapper 的一部分便利性。

### 优点

- 更少的磁盘配置修改
- 更少的安装与启动副作用
- 更清晰、更窄的职责边界
- 更容易被理解为“远端代理支持”本身

### 代价

- 没有内建替代 wrapper 的那些便利能力
- transport hook 依赖运行时拦截点是否稳定
- 兼容性依赖 OpenCode / Bun / Node 的执行路径继续经过这些 hook 点

如果目标本来就是一个边界明确、能力收敛的 remote-proxy 方案，那么这样的取舍是合理的。

## 推荐表述方式

如果需要给这个目录或功能写一句概述，建议使用类似下面的说法：

> `opencode-remote-proxy` 是一个会话级的 OpenCode remote-proxy 启动方案，它替代了 `headroom wrap opencode` 中的流量代理接入层，但不替代 wrapper 更广泛的配置与集成管理能力。

不建议使用下面这种说法：

> `opencode-remote-proxy` 替代了 `headroom wrap opencode`。

这个说法过宽，容易让读者误以为 wrapper 的其余能力也已全部覆盖。

## 使用建议

在下面这些情况下，更适合使用 `opencode-remote-proxy`：

- 你想要最轻量的 remote-proxy 路径
- 你不希望有持久配置修改
- 你只需要把 OpenCode 流量导向代理

在下面这些情况下，更适合继续使用 `headroom wrap opencode`：

- 你想要 Headroom 的一键式本地接入体验
- 你需要配置注入与恢复
- 你依赖 Headroom MCP 注册或相关设置辅助逻辑
- 你希望一个命令完成的不只是路由接入，还包括周边准备工作

## 最终结论

`opencode-remote-proxy` 是**面向 remote proxy 支持的更精简方案**。

但它**不是** `headroom wrap opencode` 的完整功能替代；它更准确的定位，是对 wrapper 中**代理路由那一层能力**的精简替代。
