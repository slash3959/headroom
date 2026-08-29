# OpenCode 远端代理包装器

这是一个独立的 Node.js 20.6+ 启动器，用来把原生 OpenCode 的 HTTP(S) 请求转发到一个已经运行中的远端代理。它只使用 Node 内置模块，运行时不依赖任何其他包。

```sh
node opencode-remote-proxy.mjs \
  --proxy http://10.64.1.105:8787 \
  -- [opencode arguments]
```

如果这次没有要传给 OpenCode 的额外参数，那么结尾的 `--` 可以省略；只有在你要把后续参数原样转发给 OpenCode 时，才需要用 `--` 作为分隔符。

如果你不想直接调用默认的 `opencode`，可以在 `--` 前使用 `--opencode <command>` 指定实际启动命令。

`--proxy` 必须是完整的 `http://` 或 `https://` origin，不能带用户名密码、query、fragment，也不能带非根路径。这个启动器不会帮你启动代理，也不会探测代理是否可用。

原生 OpenCode 是一个 Bun 编译出来的可执行文件，所以这里**不会**假设 Node 的 `NODE_OPTIONS` 能直接补丁 OpenCode 主进程。它只会修改 OpenCode 子进程自己的环境变量：

- `OPENCODE_REMOTE_PROXY_URL`：告诉插件应该把流量发往哪个远端代理。
- `OPENCODE_CONFIG_CONTENT`：只在当前会话里临时注入一个 `plugin` 条目，指向当前目录下的 `opencode-plugin.mjs` 绝对路径。

如果 `OPENCODE_CONFIG_CONTENT` 原本就是一个合法对象，那么已有 key 和已有 plugin 条目都会被保留；本插件只会追加一次，不会重复注入。若原值不是合法 JSON，则启动器会直接拒绝继续执行。

它不会读取或写入 `opencode.json`，不会注册 MCP，不会注入 provider 配置，也不会启动或探测代理。

OpenCode 会在自己的 Bun 进程里动态加载这个无依赖插件。插件会在该进程中安装 `fetch` 和兼容的 Node HTTP(S) 拦截逻辑，并返回一个空贡献对象。

和本地 Headroom OpenCode 包装方案对齐后，这个插件也会从 OpenCode 会话输入里提取 project 信息（优先 `input.project.id`，其次 `input.directory`），并在转发到远端代理的请求上附带 `x-headroom-project`。这样远端代理就能按和本地一致的方式做 project 归类、请求归因和 Recent Requests 展示。

对于 OpenCode 再拉起的 **Node 子进程**，插件会把 `OPENCODE_REMOTE_PROXY_URL`、派生出来的 `OPENCODE_REMOTE_PROXY_PROJECT`，以及根目录下的 `node-preload.mjs` 一起通过 `NODE_OPTIONS` 传下去。回环地址和已经指向代理本身的请求会保持直连；外部 `HTTP/2` 直连则会显式失败，而不是悄悄绕过代理。

这个分发目录是刻意做成扁平结构的：运行时代码、文档、包元数据和完整测试一共只有 7 个文件，没有生成目录，也没有嵌套子目录。

启动器会转发终止信号，并原样返回 OpenCode 的退出状态。

如果要做真正的 provider 网络端到端验证，仍然需要：

- 一个已经配置好的 OpenCode 账号
- 一个真实可用的兼容远端代理

本目录自带的测试主要验证以下内容：

- 会话级 `OPENCODE_CONFIG_CONTENT` 注入
- 插件是否被正确加载
- 本地捕获代理上的路由行为
- Node 子进程的继承传播
- 传输层拦截语义本身是否正确

## 测试

```sh
npm test
```
