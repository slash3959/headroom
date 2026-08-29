import { createRequire, syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";
import { urlToHttpOptions } from "node:url";

// 这个 transport 模块故意保持为单文件：用户要求最终产物尽量少文件、且目录
// 扁平化，因此把“URL 校验、会话配置注入、HTTP/子进程拦截、安装与恢复生命周期”
// 放在同一个模块里。虽然文件较长，但职责仍然只有一个：拦截并转发传输层流量。

const BASE_URL_HEADER = "x-headroom-base-url";
const ORIGINAL_PATH_HEADER = "x-headroom-original-path";
const PROJECT_HEADER = "x-headroom-project";
const PROJECT_ENV = "OPENCODE_REMOTE_PROXY_PROJECT";
const PROXY_ERROR = "proxy must be an absolute http(s) origin without credentials, query, fragment, or path";
const CONFIG_ERROR = "OPENCODE_CONFIG_CONTENT must be a valid JSON object with a plugin array";
const TRANSPORT_STATE = Symbol.for("opencode-remote-proxy.transport-state");

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const http2 = require("node:http2");
const childProcess = require("node:child_process");

export function parseProxyOrigin(value) {
  const hasAbsoluteScheme = typeof value === "string" && /^https?:\/\//i.test(value);
  if (!hasAbsoluteScheme || value !== value.trim() || !URL.canParse(value)) {
    return { error: PROXY_ERROR, ok: false };
  }

  const url = new URL(value);
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  const validProtocol = url.protocol === "http:" || url.protocol === "https:";
  const validPath = url.pathname === "/";
  const validAuthority =
    !authority.includes("@") && url.username === "" && url.password === "";
  const validSuffix = !value.includes("?") && !value.includes("#");
  if (!validProtocol || !validPath || !validAuthority || !validSuffix) {
    return { error: PROXY_ERROR, ok: false };
  }
  return { ok: true, origin: url.origin };
}

// 本地回环和已经指向代理本身的请求都不应再次转发，否则要么死循环，要么把本地
// 调试流量误送到远端。
function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function normalizedPath(pathname) {
  if (pathname.endsWith("/chat/completions")) {
    return "/v1/chat/completions";
  }
  if (pathname.endsWith("/responses")) {
    return "/v1/responses";
  }
  return undefined;
}

export function createRoute(target, proxyOrigin) {
  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (!isHttp || isLoopbackHostname(target.hostname) || target.origin === proxyOrigin) {
    return undefined;
  }
  const replacementPath = normalizedPath(target.pathname);
  const pathname = replacementPath ?? target.pathname;
  return {
    baseUrl: target.origin,
    originalPath: replacementPath === undefined ? undefined : target.pathname,
    url: new URL(`${pathname}${target.search}`, proxyOrigin),
  };
}

function createRoutedHeaders(source, route, project = undefined) {
  const headers = new Headers(source);
  headers.delete("host");
  headers.set(BASE_URL_HEADER, route.baseUrl);
  if (route.originalPath === undefined) {
    headers.delete(ORIGINAL_PATH_HEADER);
  } else {
    headers.set(ORIGINAL_PATH_HEADER, route.originalPath);
  }
  if (project === undefined) {
    headers.delete(PROJECT_HEADER);
  } else {
    headers.set(PROJECT_HEADER, project);
  }
  return headers;
}

function createRoutedNodeHeaders(source, route, project = undefined) {
  const entries = source instanceof Headers ? [...source.entries()] : Object.entries(source ?? {});
  const headers = {};
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (
      normalized !== "host" &&
      normalized !== BASE_URL_HEADER &&
      normalized !== ORIGINAL_PATH_HEADER &&
      normalized !== PROJECT_HEADER
    ) {
      headers[name] = value;
    }
  }
  headers[BASE_URL_HEADER] = route.baseUrl;
  if (route.originalPath !== undefined) {
    headers[ORIGINAL_PATH_HEADER] = route.originalPath;
  }
  if (project !== undefined) {
    headers[PROJECT_HEADER] = project;
  }
  return headers;
}

// Node 子进程需要通过 NODE_OPTIONS 继承 preload；这里会做去重，避免多次包装
// 后把同一个 --import 重复追加进去。
function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendPreload(nodeOptions, preloadUrl) {
  const importPattern = new RegExp(
    `(?:^|\\s)--import(?:=|\\s+)${escapedRegExp(preloadUrl)}(?=\\s|$)`,
    "g",
  );
  const retained = (nodeOptions ?? "").replace(importPattern, " ").trim().replace(/\s+/g, " ");
  return [retained, `--import ${preloadUrl}`].filter(Boolean).join(" ");
}

export function createChildEnvironment(source, proxyOrigin, preloadUrl, project = undefined) {
  const environment = {
    ...source,
    NODE_OPTIONS: appendPreload(source.NODE_OPTIONS, preloadUrl),
    OPENCODE_REMOTE_PROXY_URL: proxyOrigin,
  };
  if (project !== undefined) {
    environment[PROJECT_ENV] = project;
  }
  return environment;
}

export function createSessionConfig(existingContent, pluginPath) {
  if (!isAbsolute(pluginPath)) {
    return { error: "session plugin path must be absolute", ok: false };
  }
  let config = {};
  if (existingContent !== undefined) {
    try {
      config = JSON.parse(existingContent);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { error: CONFIG_ERROR, ok: false };
      }
      throw error;
    }
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { error: CONFIG_ERROR, ok: false };
  }
  const plugins = config.plugin ?? [];
  if (!Array.isArray(plugins) || !plugins.every((entry) => typeof entry === "string")) {
    return { error: CONFIG_ERROR, ok: false };
  }
  const plugin = plugins.includes(pluginPath) ? [...plugins] : [...plugins, pluginPath];
  return { content: JSON.stringify({ ...config, plugin }), ok: true };
}

// OpenCode 主进程依靠会话级 OPENCODE_CONFIG_CONTENT 载入 plugin，而不是写入用户
// 的 opencode.json。这个 helper 只构造子进程环境，不触碰父进程或磁盘配置。
export function createOpenCodeEnvironment(source, proxyOrigin, pluginPath) {
  const sessionConfig = createSessionConfig(source.OPENCODE_CONFIG_CONTENT, pluginPath);
  if (!sessionConfig.ok) {
    return sessionConfig;
  }
  return {
    env: {
      ...source,
      OPENCODE_CONFIG_CONTENT: sessionConfig.content,
      OPENCODE_REMOTE_PROXY_URL: proxyOrigin,
    },
    ok: true,
  };
}

// fetch 是 OpenCode/Bun 路径里最关键的一层；能在这里拦下来的请求就不需要依赖
// 更重的系统级代理或 provider 配置重写。
function routedFetch(originalFetch, state) {
  return function remoteProxyFetch(input, init) {
    const request = new Request(input, init);
    const route = createRoute(new URL(request.url), state.proxyOrigin);
    if (route === undefined) {
      return Reflect.apply(originalFetch, globalThis, [input, init]);
    }
    const headers = createRoutedHeaders(request.headers, route, state.project);
    const routedRequest = new Request(route.url, request);
    return Reflect.apply(originalFetch, globalThis, [new Request(routedRequest, { headers })]);
  };
}

// Node 的 request 重载比较多，这里统一把 string / URL / options 归一成一个
// 可解析的目标 URL，后面才能可靠决定“直连还是转发”。
function requestTarget(first, defaultProtocol) {
  if (typeof first === "string" || first instanceof URL) {
    const value = first instanceof URL ? first.href : first;
    return URL.canParse(value) ? new URL(value) : undefined;
  }
  if (first === null || typeof first !== "object") {
    return undefined;
  }
  const hasAuthorityOptions = first.hostname !== undefined || first.host !== undefined;
  if (!hasAuthorityOptions && typeof first.href === "string" && URL.canParse(first.href)) {
    return new URL(first.href);
  }
  const protocol = first.protocol ?? defaultProtocol;
  const hasHostname = typeof first.hostname === "string";
  const authority = hasHostname ? first.hostname : first.host;
  if (typeof authority !== "string") {
    return undefined;
  }
  const colonCount = authority.split(":").length - 1;
  const isBracketed = authority.startsWith("[");
  const bracketedHostname = !isBracketed && colonCount > 1 ? `[${authority}]` : authority;
  const hostIncludesPort = isBracketed
    ? authority.slice(authority.indexOf("]") + 1).startsWith(":")
    : colonCount === 1;
  const useSeparatePort = first.port !== undefined && (hasHostname || !hostIncludesPort);
  const port = useSeparatePort ? `:${first.port}` : "";
  const path = first.path ?? first.pathname ?? "/";
  const base = `${protocol}//${bracketedHostname}${port}`;
  return URL.canParse(path, base) ? new URL(path, base) : undefined;
}

function requestParts(args, defaultProtocol) {
  const first = args[0];
  const hasUrl = typeof first === "string" || first instanceof URL;
  const candidateOptions = hasUrl ? args[1] : first;
  const suppliedOptions = candidateOptions !== null && typeof candidateOptions === "object"
    ? candidateOptions
    : {};
  const options = hasUrl
    ? { ...urlToHttpOptions(new URL(first)), ...suppliedOptions }
    : suppliedOptions;
  return {
    callback: args.findLast((value) => typeof value === "function"),
    options,
    target: requestTarget(options, defaultProtocol),
  };
}

function proxyRequestOptions(parts, route, project = undefined) {
  const options = {
    ...parts.options,
    headers: createRoutedNodeHeaders(parts.options.headers, route, project),
    hostname: route.url.hostname.replace(/^\[|\]$/g, ""),
    path: `${route.url.pathname}${route.url.search}`,
    port: route.url.port === "" ? undefined : route.url.port,
    protocol: route.url.protocol,
  };
  delete options.agent;
  delete options.auth;
  delete options.createConnection;
  delete options.host;
  delete options.href;
  delete options.lookup;
  delete options.servername;
  delete options.socketPath;
  return options;
}

function routedRequest(config) {
  return function remoteProxyRequest(...args) {
    const parts = requestParts(args, config.defaultProtocol);
    const route = parts.target === undefined
      ? undefined
      : createRoute(parts.target, config.state.proxyOrigin);
    if (route === undefined) {
      const original = config.defaultProtocol === "https:"
        ? config.originalHttpsRequest
        : config.originalHttpRequest;
      return Reflect.apply(original, this, args);
    }
    const request = route.url.protocol === "https:"
      ? config.originalHttpsRequest
      : config.originalHttpRequest;
    const nextOptions = proxyRequestOptions(parts, route, config.state.project);
    const nextArgs = parts.callback === undefined ? [nextOptions] : [nextOptions, parts.callback];
    return Reflect.apply(request, this, nextArgs);
  };
}

function routedGet(request) {
  return function remoteProxyGet(...args) {
    const result = Reflect.apply(request, this, args);
    result.end();
    return result;
  };
}

// HTTP/2 这里不做静默透传：凡是会直连外部上游的情况，都明确抛错，保证用户不
// 会误以为流量已经经过代理。
function guardedHttp2Connect(originalConnect, state) {
  return function remoteProxyHttp2Connect(authority, ...args) {
    const value = authority instanceof URL ? authority.href : authority;
    if (typeof value === "string" && URL.canParse(value)) {
      const target = new URL(value);
      if (createRoute(target, state.proxyOrigin) !== undefined) {
        throw new Error(
          `Direct external http2.connect to ${target.origin} is blocked by opencode-remote-proxy`,
        );
      }
    }
    return Reflect.apply(originalConnect, this, [authority, ...args]);
  };
}

function installHttpHooks(state) {
  globalThis.fetch = routedFetch(state.originalFetch, state);
  http.request = routedRequest({
    defaultProtocol: "http:",
    originalHttpRequest: state.originalHttpRequest,
    originalHttpsRequest: state.originalHttpsRequest,
    state,
  });
  https.request = routedRequest({
    defaultProtocol: "https:",
    originalHttpRequest: state.originalHttpRequest,
    originalHttpsRequest: state.originalHttpsRequest,
    state,
  });
  http.get = routedGet(http.request);
  https.get = routedGet(https.request);
  http2.connect = guardedHttp2Connect(state.originalHttp2Connect, state);
}

// OpenCode 可能再拉起 Node 子进程；这些子进程不会自动继承 Bun 进程内的 hook，
// 所以必须把 preload 和远端代理地址显式塞进它们的环境。
function childOptions(options, state) {
  const source = options?.env ?? process.env;
  return {
    ...options,
    env: createChildEnvironment(source, state.proxyOrigin, state.preloadUrl, state.project),
  };
}

function injectOptions(args, optionIndex, state) {
  const injected = [...args];
  const current = injected[optionIndex];
  if (typeof current === "function") {
    injected.splice(optionIndex, 0, childOptions(undefined, state));
  } else {
    injected[optionIndex] = childOptions(current, state);
  }
  return injected;
}

function wrapWithOptions(original, optionIndexForArgs, state) {
  return function remoteProxyChildProcess(...args) {
    return Reflect.apply(
      original,
      this,
      injectOptions(args, optionIndexForArgs(args), state),
    );
  };
}

function argsOrOptionsIndex(args) {
  return Array.isArray(args[1]) ? 2 : 1;
}

function optionsIndex() {
  return 1;
}

function installChildProcessHooks(state) {
  childProcess.spawn = wrapWithOptions(state.originalChildSpawn, argsOrOptionsIndex, state);
  childProcess.spawnSync = wrapWithOptions(
    state.originalChildSpawnSync,
    argsOrOptionsIndex,
    state,
  );
  childProcess.exec = wrapWithOptions(state.originalChildExec, optionsIndex, state);
  childProcess.execSync = wrapWithOptions(state.originalChildExecSync, optionsIndex, state);
  childProcess.execFile = wrapWithOptions(state.originalChildExecFile, argsOrOptionsIndex, state);
  childProcess.execFileSync = wrapWithOptions(
    state.originalChildExecFileSync,
    argsOrOptionsIndex,
    state,
  );
  childProcess.fork = wrapWithOptions(state.originalChildFork, argsOrOptionsIndex, state);
}

function currentState() {
  return globalThis[TRANSPORT_STATE];
}

function restore(state) {
  globalThis.fetch = state.originalFetch;
  http.request = state.originalHttpRequest;
  http.get = state.originalHttpGet;
  https.request = state.originalHttpsRequest;
  https.get = state.originalHttpsGet;
  http2.connect = state.originalHttp2Connect;
  childProcess.spawn = state.originalChildSpawn;
  childProcess.spawnSync = state.originalChildSpawnSync;
  childProcess.exec = state.originalChildExec;
  childProcess.execSync = state.originalChildExecSync;
  childProcess.execFile = state.originalChildExecFile;
  childProcess.execFileSync = state.originalChildExecFileSync;
  childProcess.fork = state.originalChildFork;
  delete globalThis[TRANSPORT_STATE];
  syncBuiltinESMExports();
}

export function installTransportHook(options) {
  const existing = currentState();
  if (existing !== undefined) {
    existing.references += 1;
    return () => uninstallTransportHook();
  }
  const state = {
    originalChildExec: childProcess.exec,
    originalChildExecSync: childProcess.execSync,
    originalChildExecFile: childProcess.execFile,
    originalChildExecFileSync: childProcess.execFileSync,
    originalChildFork: childProcess.fork,
    originalChildSpawn: childProcess.spawn,
    originalChildSpawnSync: childProcess.spawnSync,
    originalFetch: globalThis.fetch,
    originalHttp2Connect: http2.connect,
    originalHttpGet: http.get,
    originalHttpRequest: http.request,
    originalHttpsGet: https.get,
    originalHttpsRequest: https.request,
    preloadUrl: options.preloadUrl,
    project: options.project,
    proxyOrigin: options.proxyOrigin,
    references: 1,
  };
  globalThis[TRANSPORT_STATE] = state;
  installHttpHooks(state);
  installChildProcessHooks(state);
  syncBuiltinESMExports();
  return () => uninstallTransportHook();
}

export function uninstallTransportHook() {
  const state = currentState();
  if (state === undefined) {
    return;
  }
  state.references -= 1;
  if (state.references === 0) {
    restore(state);
  }
}
