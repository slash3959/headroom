import {
  installTransportHook,
  parseProxyOrigin,
} from "./transport.mjs";

// 这个入口运行在 OpenCode 自己的 Bun 进程里；它负责安装主进程拦截，并把
// 独立的 Node preload URL 交给后续 Node 子进程继承使用。
const NODE_PRELOAD_URL = new URL("./node-preload.mjs", import.meta.url).href;

function resolveProject(input) {
  if (typeof input?.project === "object" && input.project !== null && typeof input.project.id === "string") {
    return input.project.id;
  }
  if (typeof input?.directory === "string" && input.directory !== "") {
    return input.directory;
  }
  return undefined;
}

export default async function OpenCodeRemoteProxyPlugin(input) {
  const parsed = parseProxyOrigin(process.env.OPENCODE_REMOTE_PROXY_URL);
  if (!parsed.ok) {
    throw new Error(`OPENCODE_REMOTE_PROXY_URL ${parsed.error}`);
  }
  installTransportHook({
    preloadUrl: NODE_PRELOAD_URL,
    project: resolveProject(input),
    proxyOrigin: parsed.origin,
  });
  return {};
}
