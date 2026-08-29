import {
  installTransportHook,
  parseProxyOrigin,
} from "./transport.mjs";

// 这个入口只给 Node 子进程使用。OpenCode 主进程是 Bun 可执行文件，本身不依赖
// NODE_OPTIONS 注入；真正的主进程拦截由 opencode-plugin.mjs 完成。
const parsed = parseProxyOrigin(process.env.OPENCODE_REMOTE_PROXY_URL);
if (!parsed.ok) {
  throw new Error(`OPENCODE_REMOTE_PROXY_URL ${parsed.error}`);
}
installTransportHook({
  preloadUrl: import.meta.url,
  project: process.env.OPENCODE_REMOTE_PROXY_PROJECT,
  proxyOrigin: parsed.origin,
});
