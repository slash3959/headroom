#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createOpenCodeEnvironment,
  parseProxyOrigin,
} from "./transport.mjs";

// OpenCode 主进程通过会话级 plugin 加载拦截逻辑，因此这里需要把根目录插件
// 文件转成绝对路径并写入子进程环境，而不是去改用户磁盘上的配置文件。
const PLUGIN_PATH = fileURLToPath(new URL("./opencode-plugin.mjs", import.meta.url));

export function parseLauncherArguments(argv) {
  const delimiter = argv.indexOf("--");
  const launcherArgs = delimiter === -1 ? argv : argv.slice(0, delimiter);
  const openCodeArgs = delimiter === -1 ? [] : argv.slice(delimiter + 1);
  let command = "opencode";
  let commandWasSupplied = false;
  let proxyValue;
  for (let index = 0; index < launcherArgs.length; index += 1) {
    const argument = launcherArgs[index];
    if (argument !== "--proxy" && argument !== "--opencode") {
      return { error: `unknown launcher argument: ${argument}`, ok: false };
    }
    const value = launcherArgs[index + 1];
    if (value === undefined || value === "--proxy" || value === "--opencode") {
      return { error: `${argument} requires a value`, ok: false };
    }
    if (argument === "--proxy") {
      if (proxyValue !== undefined) {
        return { error: "--proxy may be supplied only once", ok: false };
      }
      proxyValue = value;
    } else {
      if (commandWasSupplied) {
        return { error: "--opencode may be supplied only once", ok: false };
      }
      command = value;
      commandWasSupplied = true;
    }
    index += 1;
  }
  if (proxyValue === undefined) {
    return { error: "--proxy is required", ok: false };
  }
  const proxy = parseProxyOrigin(proxyValue);
  if (!proxy.ok) {
    return proxy;
  }
  return { command, ok: true, openCodeArgs, proxyOrigin: proxy.origin };
}

export function runOpenCode(parsed) {
  const environment = createOpenCodeEnvironment(process.env, parsed.proxyOrigin, PLUGIN_PATH);
  if (!environment.ok) {
    process.stderr.write(`opencode-remote-proxy: ${environment.error}\n`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    // 这里只改 OpenCode 子进程环境：注入远端代理地址和会话级 plugin，父进程
    // 自己的环境保持不变。
    const child = spawn(parsed.command, parsed.openCodeArgs, {
      env: environment.env,
      shell: false,
      stdio: "inherit",
    });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forwarders = new Map(
      signals.map((signal) => [signal, () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      }]),
    );
    for (const [signal, forward] of forwarders) {
      process.on(signal, forward);
    }
    const cleanupSignals = () => {
      for (const [signal, forward] of forwarders) {
        process.off(signal, forward);
      }
    };
    child.once("error", (error) => {
      cleanupSignals();
      process.stderr.write(`failed to launch ${parsed.command}: ${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      cleanupSignals();
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (isMain) {
  const parsed = parseLauncherArguments(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`opencode-remote-proxy: ${parsed.error}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = await runOpenCode(parsed);
  }
}
