import assert from "node:assert/strict";
import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { createServer, get as httpGet } from "node:http";
import { connect as http2Connect } from "node:http2";
import { get as httpsGet } from "node:https";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLauncherArguments } from "./opencode-remote-proxy.mjs";
import {
  createChildEnvironment,
  createOpenCodeEnvironment,
  createRoute,
  createSessionConfig,
  installTransportHook,
  parseProxyOrigin,
} from "./transport.mjs";

const launcherPath = fileURLToPath(new URL("./opencode-remote-proxy.mjs", import.meta.url));
const pluginUrl = new URL("./opencode-plugin.mjs", import.meta.url).href;
const preloadUrl = new URL("./node-preload.mjs", import.meta.url).href;
const examplePluginPath = "/opt/opencode-remote-proxy/plugin/opencode-remote-proxy-plugin.mjs";

test("launcher rejects a proxy URL that is not an absolute HTTP origin", () => {
  const result = spawnSync(process.execPath, [
    launcherPath,
    "--proxy",
    "localhost:8787",
    "--",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /absolute http\(s\) origin/);
});

test("parseLauncherArguments allows omitting the OpenCode argument delimiter", () => {
  const result = parseLauncherArguments(["--proxy", "http://proxy.example"]);

  assert.deepEqual(result, {
    command: "opencode",
    ok: true,
    openCodeArgs: [],
    proxyOrigin: "http://proxy.example",
  });
});

test("parseLauncherArguments still rejects unknown launcher arguments without the delimiter", () => {
  const result = parseLauncherArguments(["--proxy", "http://proxy.example", "serve"]);

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown launcher argument: serve/);
});

test("launcher preserves child arguments, limits environment changes, and leaves its parent unchanged", () => {
  const script = [
    "const result = {",
    "  args: process.argv.slice(1),",
    "  proxy: process.env.OPENCODE_REMOTE_PROXY_URL,",
    "  nodeOptions: process.env.NODE_OPTIONS,",
    "  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),",
    "  parentOnly: process.env.PARENT_ONLY",
    "};",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const env = {
    ...process.env,
    NODE_OPTIONS: "--trace-warnings",
    PARENT_ONLY: "preserved",
  };
  delete env.OPENCODE_CONFIG_CONTENT;

  const result = spawnSync(process.execPath, [
    launcherPath,
    "--proxy",
    "http://proxy.example:8787/",
    "--opencode",
    process.execPath,
    "--",
    "--eval",
    script,
    "first",
    "--second=value",
  ], { encoding: "utf8", env });

  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.deepEqual(child.args, ["first", "--second=value"]);
  assert.equal(child.proxy, "http://proxy.example:8787");
  assert.equal(child.nodeOptions, "--trace-warnings");
  assert.deepEqual(Object.keys(child.config), ["plugin"]);
  assert.equal(child.config.plugin.length, 1);
  assert.equal(child.config.plugin[0].startsWith("/"), true);
  assert.match(child.config.plugin[0], /opencode-plugin\.mjs$/);
  assert.equal(child.parentOnly, "preserved");
  assert.equal(process.env.OPENCODE_REMOTE_PROXY_URL, undefined);
});

test("launcher propagates the OpenCode exit status", () => {
  const result = spawnSync(process.execPath, [
    launcherPath,
    "--proxy",
    "http://proxy.example:8787",
    "--opencode",
    process.execPath,
    "--",
    "--eval",
    "process.exit(7)",
  ]);

  assert.equal(result.status, 7);
});

test("launcher rejects malformed existing session config without starting OpenCode", () => {
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: "{broken" };
  const result = spawnSync(process.execPath, [
    launcherPath,
    "--proxy",
    "http://proxy.example:8787",
    "--opencode",
    process.execPath,
    "--",
    "--eval",
    "process.exit(99)",
  ], { encoding: "utf8", env });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENCODE_CONFIG_CONTENT must be a valid JSON object/);
});

test("launcher forwards termination signals to OpenCode", async () => {
  const childScript = [
    "process.once('SIGTERM', () => process.exit(23));",
    "process.stdout.write('READY\\n');",
    "setTimeout(() => process.exit(91), 1500);",
  ].join("\n");
  const launcher = spawn(process.execPath, [
    launcherPath,
    "--proxy",
    "http://proxy.example:8787",
    "--opencode",
    process.execPath,
    "--",
    "--eval",
    childScript,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => launcher.stdout.once("data", resolve));

  launcher.kill("SIGTERM");
  const result = await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(result, { code: 23, signal: null });
});

test("OpenCode plugin installs transport and returns an empty contribution", () => {
  const script = [
    `const plugin = (await import(${JSON.stringify(pluginUrl)})).default;`,
    "const contribution = await plugin({});",
    "process.stdout.write(JSON.stringify({",
    "  keys: Object.keys(contribution),",
    "  transportInstalled: globalThis.fetch.name === 'remoteProxyFetch'",
    "}));",
  ].join("\n");
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    OPENCODE_REMOTE_PROXY_URL: "https://proxy.example",
  };

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { keys: [], transportInstalled: true });
});

test("OpenCode plugin rejects a missing proxy environment", () => {
  const script = `const plugin = (await import(${JSON.stringify(pluginUrl)})).default; await plugin({});`;
  const env = { ...process.env, NODE_OPTIONS: "" };
  delete env.OPENCODE_REMOTE_PROXY_URL;

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENCODE_REMOTE_PROXY_URL proxy must be an absolute http\(s\) origin/);
});

test("parseProxyOrigin normalizes an absolute HTTP origin", () => {
  assert.deepEqual(parseProxyOrigin("HTTP://Proxy.Example:80/"), {
    ok: true,
    origin: "http://proxy.example",
  });
});

for (const value of [
  "proxy.example:8787",
  "http:proxy.example",
  "ftp://proxy.example",
  "http://@proxy.example",
  "http://user:secret@proxy.example",
  "http://proxy.example/path",
  "http://proxy.example?",
  "http://proxy.example/?query=yes",
  "http://proxy.example#",
  "http://proxy.example/#fragment",
]) {
  test(`parseProxyOrigin rejects ${value}`, () => {
    const result = parseProxyOrigin(value);

    assert.equal(result.ok, false);
    assert.match(result.error, /absolute http\(s\) origin/);
  });
}

test("createRoute normalizes chat completions and preserves its query", () => {
  const route = createRoute(
    new URL("https://api.example/models/chat/completions?stream=true"),
    "http://proxy.internal:8787",
  );

  assert.deepEqual(route, {
    url: new URL("http://proxy.internal:8787/v1/chat/completions?stream=true"),
    baseUrl: "https://api.example",
    originalPath: "/models/chat/completions",
  });
});

test("createRoute normalizes responses paths", () => {
  const route = createRoute(
    new URL("https://api.example/provider/responses"),
    "https://proxy.internal",
  );

  assert.equal(route.url.href, "https://proxy.internal/v1/responses");
  assert.equal(route.originalPath, "/provider/responses");
});

test("createRoute leaves an ordinary external path intact", () => {
  const route = createRoute(
    new URL("https://api.example/v1/models?limit=2"),
    "http://proxy.internal:8787",
  );

  assert.equal(route.url.href, "http://proxy.internal:8787/v1/models?limit=2");
  assert.equal(route.originalPath, undefined);
});

for (const target of [
  "http://localhost:8080/v1/models",
  "http://sub.localhost:8080/v1/models",
  "http://127.42.0.1/v1/models",
  "http://[::1]:8080/v1/models",
  "http://proxy.internal:8787/v1/models",
]) {
  test(`createRoute bypasses ${target}`, () => {
    assert.equal(
      createRoute(new URL(target), "http://proxy.internal:8787"),
      undefined,
    );
  });
}

test("createChildEnvironment appends one preload and does not mutate input", () => {
  const source = {
    KEEP: "yes",
    NODE_OPTIONS: `--trace-warnings --import ${preloadUrl} --import=${preloadUrl}`,
  };
  const snapshot = { ...source };

  const result = createChildEnvironment(
    source,
    "https://proxy.internal",
    preloadUrl,
    "workspace-alpha",
  );

  assert.deepEqual(source, snapshot);
  assert.equal(result.KEEP, "yes");
  assert.equal(result.OPENCODE_REMOTE_PROXY_URL, "https://proxy.internal");
  assert.equal(result.OPENCODE_REMOTE_PROXY_PROJECT, "workspace-alpha");
  assert.equal(result.NODE_OPTIONS, `--trace-warnings --import ${preloadUrl}`);
});

test("createSessionConfig creates a config with exactly the plugin key", () => {
  const result = createSessionConfig(undefined, examplePluginPath);

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.content), { plugin: [examplePluginPath] });
});

test("createSessionConfig preserves existing keys and plugins without mutation", () => {
  const existing = {
    model: "existing-model",
    plugin: ["existing-plugin"],
    theme: "existing-theme",
  };
  const content = JSON.stringify(existing);

  const result = createSessionConfig(content, examplePluginPath);

  assert.equal(result.ok, true);
  assert.deepEqual(existing, {
    model: "existing-model",
    plugin: ["existing-plugin"],
    theme: "existing-theme",
  });
  assert.deepEqual(JSON.parse(result.content), {
    model: "existing-model",
    plugin: ["existing-plugin", examplePluginPath],
    theme: "existing-theme",
  });
});

test("createOpenCodeEnvironment leaves NODE_OPTIONS unchanged", () => {
  const source = { NODE_OPTIONS: "--trace-warnings", PARENT_ONLY: "kept" };
  const snapshot = { ...source };

  const result = createOpenCodeEnvironment(
    source,
    "https://proxy.internal",
    examplePluginPath,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(source, snapshot);
  assert.equal(result.env.NODE_OPTIONS, "--trace-warnings");
  assert.equal(result.env.OPENCODE_REMOTE_PROXY_URL, "https://proxy.internal");
});

test("createSessionConfig rejects malformed existing JSON", () => {
  assert.deepEqual(createSessionConfig("{broken", examplePluginPath), {
    error: "OPENCODE_CONFIG_CONTENT must be a valid JSON object with a plugin array",
    ok: false,
  });
});

function startCaptureServer() {
  const captures = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      captures.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"captured":true}');
    });
  });
  return { captures, server };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("fetch routes an external request through the capture proxy", async () => {
  const capture = startCaptureServer();
  const proxyOrigin = await listen(capture.server);
  const uninstall = installTransportHook({
    preloadUrl,
    project: "workspace-alpha",
    proxyOrigin,
  });

  const response = await fetch("https://api.example/provider/chat/completions?stream=true", {
    body: '{"model":"test"}',
    headers: { "content-type": "application/json", host: "api.example" },
    method: "POST",
  });
  const payload = await response.json();

  assert.deepEqual(payload, { captured: true });
  assert.equal(capture.captures.length, 1);
  assert.equal(capture.captures[0].url, "/v1/chat/completions?stream=true");
  assert.equal(capture.captures[0].method, "POST");
  assert.equal(capture.captures[0].body, '{"model":"test"}');
  assert.equal(capture.captures[0].headers["x-headroom-base-url"], "https://api.example");
  assert.equal(capture.captures[0].headers["x-headroom-project"], "workspace-alpha");
  assert.equal(
    capture.captures[0].headers["x-headroom-original-path"],
    "/provider/chat/completions",
  );
  assert.match(capture.captures[0].headers.host, /^127\.0\.0\.1:/);
  uninstall();
  await close(capture.server);
});

test("http.get routes external options without mutating headers", async () => {
  const capture = startCaptureServer();
  const proxyOrigin = await listen(capture.server);
  const uninstall = installTransportHook({
    preloadUrl,
    project: "workspace-alpha",
    proxyOrigin,
  });
  const headers = { host: "api.example", "x-request-id": "request-1" };
  const snapshot = { ...headers };

  const body = await new Promise((resolve, reject) => {
    const request = httpGet(
      { headers, host: "api.example:80", path: "/models?limit=1", protocol: "http:" },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.once("error", reject);
  });

  assert.equal(body, '{"captured":true}');
  assert.deepEqual(headers, snapshot);
  assert.equal(capture.captures[0].url, "/models?limit=1");
  assert.equal(capture.captures[0].headers["x-request-id"], "request-1");
  assert.equal(capture.captures[0].headers["x-headroom-base-url"], "http://api.example");
  assert.equal(capture.captures[0].headers["x-headroom-project"], "workspace-alpha");
  uninstall();
  await close(capture.server);
});

test("http.get honors URL option overrides and strips direct connection hooks", async (t) => {
  const capture = startCaptureServer();
  const proxyOrigin = await listen(capture.server);
  const uninstall = installTransportHook({ preloadUrl, proxyOrigin });
  t.after(async () => {
    uninstall();
    await close(capture.server);
  });
  const options = {
    createConnection() {
      throw new Error("createConnection bypass was retained");
    },
    headers: { "x-request-id": "request-override" },
    hostname: "override.example",
    lookup() {
      throw new Error("lookup bypass was retained");
    },
    path: "/overridden?value=2",
    port: 80,
  };
  const snapshot = { ...options };

  const body = await new Promise((resolve, reject) => {
    const request = httpGet(
      new URL("http://original.example/original?value=1"),
      options,
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.once("error", reject);
  });

  assert.equal(body, '{"captured":true}');
  assert.deepEqual(options, snapshot);
  assert.equal(capture.captures[0].url, "/overridden?value=2");
  assert.equal(capture.captures[0].headers["x-headroom-base-url"], "http://override.example");
});

for (const [host, expectedOrigin] of [
  ["api.example", "https://api.example:8443"],
  ["api.example:9443", "https://api.example:9443"],
  ["2001:db8::1", "https://[2001:db8::1]:8443"],
  ["[2001:db8::1]", "https://[2001:db8::1]:8443"],
  ["[2001:db8::1]:9443", "https://[2001:db8::1]:9443"],
]) {
  test(`https.get routes host ${host} with the correct port`, async (t) => {
    const capture = startCaptureServer();
    const proxyOrigin = await listen(capture.server);
    const uninstall = installTransportHook({ preloadUrl, proxyOrigin });
    t.after(async () => {
      uninstall();
      await close(capture.server);
    });

    const body = await new Promise((resolve, reject) => {
      const request = httpsGet({
        createConnection() {
          throw new Error("direct createConnection bypass was used");
        },
        host,
        lookup() {
          throw new Error("direct lookup bypass was used");
        },
        path: "/models?limit=1",
        port: 8443,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      request.once("error", reject);
    });

    assert.equal(body, '{"captured":true}');
    assert.equal(capture.captures[0].url, "/models?limit=1");
    assert.equal(capture.captures[0].headers["x-headroom-base-url"], expectedOrigin);
  });
}

test("external http2.connect fails before opening a bypass", () => {
  const originalFetch = globalThis.fetch;
  const uninstallFirst = installTransportHook({
    preloadUrl,
    proxyOrigin: "http://proxy.example:8787",
  });
  const uninstallSecond = installTransportHook({
    preloadUrl,
    proxyOrigin: "http://proxy.example:8787",
  });

  assert.throws(
    () => http2Connect("https://api.example"),
    /Direct external http2\.connect to https:\/\/api\.example is blocked/,
  );
  uninstallFirst();
  assert.notEqual(globalThis.fetch, originalFetch);
  uninstallSecond();
  assert.equal(globalThis.fetch, originalFetch);
});

test("spawned Node children inherit the preload without mutating spawn options", async () => {
  const capture = startCaptureServer();
  const proxyOrigin = await listen(capture.server);
  const uninstall = installTransportHook({
    preloadUrl,
    project: "workspace-alpha",
    proxyOrigin,
  });
  const options = {
    env: { ...process.env, CHILD_MARKER: "kept" },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const originalEnv = { ...options.env };
  const script = [
    'const response = await fetch("https://child.example/responses?mode=fast", { method: "POST" });',
    "process.stdout.write(JSON.stringify({ marker: process.env.CHILD_MARKER, project: process.env.OPENCODE_REMOTE_PROXY_PROJECT, status: response.status }));",
  ].join("\n");

  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], options);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(status, 0, Buffer.concat(stderr).toString("utf8"));
  assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), {
    marker: "kept",
    project: "workspace-alpha",
    status: 200,
  });
  assert.deepEqual(options.env, originalEnv);
  assert.equal(capture.captures[0].url, "/v1/responses?mode=fast");
  assert.equal(capture.captures[0].headers["x-headroom-base-url"], "https://child.example");
  assert.equal(capture.captures[0].headers["x-headroom-project"], "workspace-alpha");
  uninstall();
  await close(capture.server);
});

test("synchronous Node children inherit the preload without mutating options", () => {
  const uninstall = installTransportHook({
    preloadUrl,
    project: "workspace-alpha",
    proxyOrigin: "https://proxy.example",
  });
  const options = { encoding: "utf8", env: { ...process.env, SYNC_MARKER: "kept" } };
  const originalEnv = { ...options.env };
  const script = [
    "process.stdout.write(JSON.stringify({",
    "  marker: process.env.SYNC_MARKER,",
    "  nodeOptions: process.env.NODE_OPTIONS,",
    "  project: process.env.OPENCODE_REMOTE_PROXY_PROJECT,",
    "  proxy: process.env.OPENCODE_REMOTE_PROXY_URL",
    "}));",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--eval", script], options);
  const execFileOutput = execFileSync(process.execPath, ["--eval", script], options);

  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.marker, "kept");
  assert.equal(child.project, "workspace-alpha");
  assert.equal(child.proxy, "https://proxy.example");
  assert.match(child.nodeOptions, /--import file:.*node-preload\.mjs/);
  assert.deepEqual(JSON.parse(execFileOutput), child);
  assert.deepEqual(options.env, originalEnv);
  uninstall();
});

test("OpenCode plugin derives project metadata for routed requests", async () => {
  const capture = startCaptureServer();
  const proxyOrigin = await listen(capture.server);
  const script = [
    `const plugin = (await import(${JSON.stringify(pluginUrl)})).default;`,
    "await plugin({ directory: '/workspace/fallback', project: { id: 'workspace-alpha' } });",
    "const response = await fetch('https://api.example/provider/responses', { method: 'POST' });",
    "process.stdout.write(String(response.status));",
  ].join("\n");
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    OPENCODE_REMOTE_PROXY_URL: proxyOrigin,
  };

  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(status, 0, Buffer.concat(stderr).toString("utf8"));
  assert.equal(Buffer.concat(stdout).toString("utf8"), "200");
  assert.equal(capture.captures.length, 1);
  assert.equal(capture.captures[0].headers["x-headroom-project"], "workspace-alpha");
  await close(capture.server);
});

test("execFile preserves the callback-only options overload", async () => {
  const uninstall = installTransportHook({
    preloadUrl,
    proxyOrigin: "https://proxy.example",
  });
  const script = "process.stdout.write(process.env.OPENCODE_REMOTE_PROXY_URL ?? 'missing')";

  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--eval", script], (error, output) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(output);
    });
  });

  assert.equal(stdout, "https://proxy.example");
  uninstall();
});
