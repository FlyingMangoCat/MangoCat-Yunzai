import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import vm from "node:vm";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(repoRoot, "lib/panel/plugins.js");
const tempParent = path.join(repoRoot, "temp");
const AUDITED_HASH = "a".repeat(40);
const LOCAL_HASH = "b".repeat(40);
const ok = (stdout = "", stderr = "") => ({ stdout, stderr });
const fail = (message, stderr = message) => ({
  error: new Error(message),
  stdout: "",
  stderr,
});
let suiteRoot;

before(() => {
  fs.mkdirSync(tempParent, { recursive: true });
  suiteRoot = fs.mkdtempSync(
    path.join(tempParent, "panel-plugins-regression-"),
  );
});

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(suiteRoot, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function inside(root, target) {
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);
  assert.ok(
    rel === "" ||
      (rel !== ".." &&
        !rel.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(rel)),
    `fixture path escaped temp: ${target}`,
  );
  return full;
}

function mockFs(root) {
  return {
    statSync: (target) => fs.statSync(inside(root, target)),
    readFileSync: (target, ...args) =>
      fs.readFileSync(inside(root, target), ...args),
    existsSync: (target) => fs.existsSync(inside(root, target)),
    mkdirSync: (target, ...args) => fs.mkdirSync(inside(root, target), ...args),
    appendFileSync: (target, ...args) =>
      fs.appendFileSync(inside(root, target), ...args),
    readdirSync: (target, ...args) =>
      fs.readdirSync(inside(root, target), ...args),
    renameSync: (from, to) =>
      fs.renameSync(inside(root, from), inside(root, to)),
    realpathSync: (target) => fs.realpathSync(inside(root, target)),
  };
}

function mockPath(root) {
  return {
    ...path,
    resolve: (...parts) => {
      const base = parts.length && path.isAbsolute(parts[0]) ? "" : root;
      return inside(root, path.resolve(base, ...parts));
    },
  };
}

function makePlugin(root, name, { git = true, head = AUDITED_HASH } = {}) {
  const dir = path.join(root, "plugins", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), "export default {}\n");
  if (git) {
    const gitDir = path.join(dir, ".git");
    fs.mkdirSync(path.join(gitDir, "refs/heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(gitDir, "refs/heads/main"), `${head}\n`);
  }
  return dir;
}

function ledgerEntry(name, overrides = {}) {
  return {
    dir: name,
    name,
    tier: "official",
    hash: AUDITED_HASH,
    downloads: [`https://git.example.com/owner/${name}`],
    homepage: `https://git.example.com/owner/${name}`,
    ...overrides,
  };
}

async function loadPanel(
  t,
  root,
  { items = [], install = {}, confirm = true, handler, probe } = {},
) {
  const gitCalls = [];
  const syncCalls = [];
  const confirmations = [];
  const probes = [];
  const ledgerCalls = [];
  const unexpected = [];

  function execute(file, args, options, callback) {
    args = Array.from(args);
    gitCalls.push({ file, args, options });
    const result = handler ? handler(file, args, options) : null;
    if (!result) {
      unexpected.push([file, ...args]);
      callback(new Error(`Unexpected git command: ${args.join(" ")}`), "", "");
      return;
    }
    callback(result.error || null, result.stdout || "", result.stderr || "");
  }

  execute[promisify.custom] = (file, args, options) =>
    new Promise((resolve, reject) => {
      execute(file, args, options, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  function executeSync(file, args, options) {
    syncCalls.push({ file, args, options });
    throw new Error(`Unexpected synchronous git command: ${args.join(" ")}`);
  }

  const findEntry = (entries, name) =>
    entries.find(
      (entry) => String(entry.dir).toLowerCase() === String(name).toLowerCase(),
    ) ||
    entries.find(
      (entry) =>
        String(entry.name).toLowerCase() === String(name).toLowerCase(),
    ) ||
    null;

  const mocks = {
    "node:fs": { default: mockFs(root) },
    "node:path": { default: mockPath(root) },
    yaml: {
      default: {
        parse: () => {
          throw new Error("Unexpected YAML parsing");
        },
      },
    },
    "node:child_process": { execFile: execute, execFileSync: executeSync },
    "node:util": { promisify },
    "./ledger.js": {
      getLedger: async () => {
        ledgerCalls.push(true);
        return { items };
      },
      findEntry,
      installConf: () => ({
        allow: true,
        domains: ["git.example.com"],
        ...install,
      }),
    },
    "../tools/gitSource.js": {
      ensureRemoteUsable: async (options) => {
        probes.push({
          ...options,
          candidates: Array.from(options.candidates || []),
        });
        if (probe) return probe(options);
        return { url: "https://git.example.com/owner/demo", switched: false };
      },
    },
    "../security/sensitiveOps.js": {
      requestConfirm: async (action, source) => {
        confirmations.push({ action, source });
        return confirm;
      },
    },
  };

  const sandbox = {
    console,
    URL,
    TextDecoder,
    Buffer,
    global: { logger: { mark() {}, error() {} } },
  };
  const context = vm.createContext(sandbox);
  const cache = new Map();
  function mockModule(specifier) {
    if (cache.has(specifier)) return cache.get(specifier);
    assert.ok(
      Object.hasOwn(mocks, specifier),
      `Unexpected import: ${specifier}`,
    );
    const exports = mocks[specifier];
    const module = new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
          this.setExport(name, value);
      },
      { context, identifier: `mock:${specifier}` },
    );
    cache.set(specifier, module);
    return module;
  }

  const identifier = pathToFileURL(sourcePath).href;
  const module = new vm.SourceTextModule(fs.readFileSync(sourcePath, "utf8"), {
    context,
    identifier,
    initializeImportMeta(meta) {
      meta.url = identifier;
    },
  });
  await module.link(mockModule);
  await module.evaluate();
  t.after(() =>
    assert.deepEqual(
      unexpected,
      [],
      "unexpected git commands reached the mock",
    ),
  );

  const normalize = (value) => structuredClone(value);
  const api = Object.fromEntries(
    Object.entries(module.namespace).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args) => {
            const result = value(...args);
            return result && typeof result.then === "function"
              ? result.then(normalize)
              : normalize(result);
          }
        : value,
    ]),
  );
  return { api, gitCalls, syncCalls, confirmations, probes, ledgerCalls };
}

const req = {
  headers: { "x-forwarded-for": "203.0.113.9" },
  socket: { remoteAddress: "127.0.0.1" },
};
const cloneArgs = (url) => ["clone", "--depth", "1", url];
const pullCalls = (h) =>
  h.gitCalls.filter((call) => call.args.includes("pull"));

test("install URL validation allows exact and subdomain whitelist hosts over HTTP(S)", (t) => {
  const root = fixture(t);
  return loadPanel(t, root).then((h) => {
    assert.equal(
      h.api.verifyUrl("https://git.example.com/owner/demo.git"),
      "git.example.com",
    );
    assert.equal(
      h.api.verifyUrl("http://mirror.git.example.com/owner/demo"),
      "mirror.git.example.com",
    );
    assert.throws(
      () => h.api.verifyUrl("git@git.example.com:owner/demo.git"),
      /格式不正确/,
    );
    assert.throws(
      () => h.api.verifyUrl("file:///tmp/demo"),
      /只允许 http\/https/,
    );
    assert.throws(
      () => h.api.verifyUrl("https://git.example.com.evil.test/owner/demo"),
      /白名单/,
    );
    assert.throws(
      () => h.api.verifyUrl("https://notgit.example.com/owner/demo"),
      /白名单/,
    );
  });
});

test("install rejects a non-whitelisted URL before confirmation or git execution", async (t) => {
  const h = await loadPanel(t, fixture(t));
  await assert.rejects(
    h.api.installPlugin({
      url: "https://evil.example/owner/demo",
      ack: true,
      req,
    }),
    /仓库域名不在白名单内：evil\.example/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.ledgerCalls, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("install respects the disabled installation switch", async (t) => {
  const h = await loadPanel(t, fixture(t), { install: { allow: false } });
  await assert.rejects(
    h.api.installPlugin({
      url: "https://git.example.com/owner/demo",
      ack: true,
      req,
    }),
    /面板已关闭插件安装/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
});

test("install refuses an existing plugin directory before confirmation or clone", async (t) => {
  const root = fixture(t);
  makePlugin(root, "demo", { git: false });
  const h = await loadPanel(t, root, { items: [ledgerEntry("demo")] });
  await assert.rejects(
    h.api.installPlugin({
      url: "https://git.example.com/owner/demo.git",
      ack: true,
      req,
    }),
    /插件目录已存在：plugins\/demo/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.ledgerCalls, []);
});

test("install requires explicit risk ack for an unlisted plugin", async (t) => {
  const h = await loadPanel(t, fixture(t));
  await assert.rejects(
    h.api.installPlugin({ url: "https://git.example.com/owner/demo", req }),
    /该插件未收录.*需风险确认/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("install requires master confirmation even for a listed plugin", async (t) => {
  const h = await loadPanel(t, fixture(t), {
    items: [ledgerEntry("demo")],
    confirm: false,
  });
  await assert.rejects(
    h.api.installPlugin({ url: "https://git.example.com/owner/demo", req }),
    /未获得主人私聊确认/,
  );
  assert.deepEqual(h.confirmations, [
    {
      action: "安装插件 https://git.example.com/owner/demo",
      source: "203.0.113.9（面板 HTTP 请求）",
    },
  ]);
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("approved listed install clones once with argv and writes a success audit", async (t) => {
  const root = fixture(t);
  const url = "https://git.example.com/owner/demo.git";
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler(file, args, _options) {
      assert.equal(file, "git");
      assert.deepEqual(args, [
        ...cloneArgs(url),
        path.join(root, "plugins/demo"),
      ]);
      fs.mkdirSync(args[4], { recursive: true });
      fs.writeFileSync(path.join(args[4], "index.js"), "export default {}\n");
      return ok("Cloning into 'demo'...\n", "done\n");
    },
  });
  const result = await h.api.installPlugin({ url, req });
  assert.equal(result.dir, "demo");
  assert.equal(result.tier, "official");
  assert.equal(result.needRestart, true);
  assert.equal(result.output, "Cloning into 'demo'...\ndone");
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
  assert.equal(h.gitCalls.length, 1);
  assert.equal(h.gitCalls[0].options.windowsHide, true);
  assert.equal(h.confirmations.length, 1);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.ok(Number.isFinite(Date.parse(audit[0].t)));
  assert.deepEqual(Object.keys(audit[0]).sort(), [
    "action",
    "ip",
    "result",
    "t",
    "target",
  ]);
  assert.equal(audit[0].action, "install");
  assert.equal(audit[0].target, url);
  assert.equal(audit[0].result, "成功: plugins/demo");
  assert.equal(audit[0].ip, "203.0.113.9");
  assert.equal(fs.existsSync(path.join(root, "plugins/demo/index.js")), true);
});

test("approved unlisted install proceeds only with ack and records unknown tier", async (t) => {
  const root = fixture(t);
  const url = "https://git.example.com/owner/demo";
  const h = await loadPanel(t, root, {
    handler(file, args) {
      assert.equal(file, "git");
      assert.deepEqual(args, [
        ...cloneArgs(url),
        path.join(root, "plugins/demo"),
      ]);
      return ok("cloned");
    },
  });
  const result = await h.api.installPlugin({ url, ack: true, req });
  assert.equal(result.tier, "unknown");
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.gitCalls.length, 1);
  assert.equal(h.api.readAudit()[0].result, "成功: plugins/demo");
});

test("clone failure is audited with stderr and does not report success", async (t) => {
  const h = await loadPanel(t, fixture(t), {
    items: [ledgerEntry("demo")],
    handler: () => fail("clone exited 128", "fatal: repository not found"),
  });
  await assert.rejects(
    h.api.installPlugin({ url: "https://git.example.com/owner/demo", req }),
    /克隆失败：fatal: repository not found/,
  );
  assert.equal(h.gitCalls.length, 1);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "install");
  assert.equal(audit[0].target, "https://git.example.com/owner/demo");
  assert.match(audit[0].result, /^失败: clone exited 128/);
  assert.equal(audit[0].ip, "203.0.113.9");
});

test("update rejects a missing plugin before git, confirmation, or audit", async (t) => {
  const h = await loadPanel(t, fixture(t), { items: [ledgerEntry("demo")] });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", ack: true, req }),
    /插件不存在/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("update rejects a non-git plugin directory", async (t) => {
  const root = fixture(t);
  makePlugin(root, "demo", { git: false });
  const h = await loadPanel(t, root, { items: [ledgerEntry("demo")] });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", ack: true, req }),
    /不是 git 仓库/,
  );
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("update preflight blocks unresolved conflicts before confirmation, probe, or pull", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadUpdateConflictFixture(t, root, dir);
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", ack: true, req }),
    /存在 2 个未解决的合并冲突文件/,
  );
  assert.deepEqual(
    h.gitCalls.map((call) => call.args),
    [["-C", dir, "status", "--porcelain"]],
  );
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.api.readAudit(), []);
});

async function loadUpdateConflictFixture(t, root, dir) {
  return loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler(file, args) {
      assert.equal(file, "git");
      assert.deepEqual(args, ["-C", dir, "status", "--porcelain"]);
      return ok("UU conflict.js\nAA both-added.js\n");
    },
  });
}

test("update requires risk ack for an unlisted plugin", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadPanel(t, root, {
    handler(file, args) {
      assert.equal(file, "git");
      assert.deepEqual(args, ["-C", dir, "status", "--porcelain"]);
      return ok("");
    },
  });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", req }),
    /该插件未收录.*需风险确认/,
  );
  assert.equal(h.gitCalls.length, 1);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("update blocks a hash beyond the ledger record without ack", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo", { head: LOCAL_HASH });
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler(file, args) {
      assert.equal(file, "git");
      assert.deepEqual(args, ["-C", dir, "status", "--porcelain"]);
      return ok("");
    },
  });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", req }),
    new RegExp(
      `当前版本 ${LOCAL_HASH.slice(0, 7)} 已超出台账记录 ${AUDITED_HASH}`,
    ),
  );
  assert.equal(h.gitCalls.length, 1);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("update refuses to probe or pull when master confirmation is denied", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    confirm: false,
    handler(file, args) {
      assert.equal(file, "git");
      assert.deepEqual(args, ["-C", dir, "status", "--porcelain"]);
      return ok("");
    },
  });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", req }),
    /未获得主人私聊确认/,
  );
  assert.deepEqual(h.confirmations, [
    { action: "更新插件 demo", source: "203.0.113.9（面板 HTTP 请求）" },
  ]);
  assert.deepEqual(h.probes, []);
  assert.deepEqual(pullCalls(h), []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("update probe failure is audited and never reaches pull", async (t) => {
  const root = fixture(t);
  makePlugin(root, "demo");
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler: () => ok(""),
    probe: async () => {
      throw new Error("all candidate remotes unreachable");
    },
  });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", req }),
    /更新失败：all candidate remotes unreachable/,
  );
  assert.equal(h.probes.length, 1);
  assert.deepEqual(pullCalls(h), []);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "update");
  assert.equal(audit[0].target, "demo");
  assert.equal(audit[0].result, "失败: all candidate remotes unreachable");
});

test("matching listed hash updates with ff-only pull, candidate probe, and success audit", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const entry = ledgerEntry("demo", {
    downloads: [
      "https://git.example.com/owner/demo",
      "https://mirror.git.example.com/owner/demo",
    ],
  });
  const h = await loadPanel(t, root, {
    items: [entry],
    handler(file, args) {
      assert.equal(file, "git");
      if (args.includes("status")) return ok("");
      assert.deepEqual(args, ["-C", dir, "pull", "--ff-only"]);
      return ok("From git.example.com:owner/demo\n", "Updating abc..def\n");
    },
  });
  const result = await h.api.updatePlugin({ name: "demo", req });
  assert.equal(result.dir, "demo");
  assert.equal(result.needRestart, true);
  assert.equal(
    result.output,
    "From git.example.com:owner/demo\nUpdating abc..def",
  );
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].dir, dir);
  assert.deepEqual(h.probes[0].candidates, [
    ...entry.downloads,
    entry.homepage,
  ]);
  assert.equal(pullCalls(h).length, 1);
  assert.equal(pullCalls(h)[0].options.windowsHide, true);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.ok(Number.isFinite(Date.parse(audit[0].t)));
  assert.deepEqual(Object.keys(audit[0]).sort(), [
    "action",
    "ip",
    "result",
    "t",
    "target",
  ]);
  assert.equal(audit[0].action, "update");
  assert.equal(audit[0].target, "demo");
  assert.equal(audit[0].result, "成功");
  assert.equal(audit[0].ip, "203.0.113.9");
});

test("hash mismatch with explicit ack can update and records success", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo", { head: LOCAL_HASH });
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler(file, args) {
      assert.equal(file, "git");
      if (args.includes("status")) return ok("");
      assert.deepEqual(args, ["-C", dir, "pull", "--ff-only"]);
      return ok("Already up to date.\n");
    },
  });
  const result = await h.api.updatePlugin({ name: "demo", ack: true, req });
  assert.equal(result.output, "Already up to date.");
  assert.equal(h.confirmations.length, 1);
  assert.equal(pullCalls(h).length, 1);
  assert.equal(h.api.readAudit()[0].result, "成功");
});

test("failed pull is audited with git stderr and returns no success", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadPanel(t, root, {
    items: [ledgerEntry("demo")],
    handler(file, args) {
      assert.equal(file, "git");
      if (args.includes("status")) return ok("");
      assert.deepEqual(args, ["-C", dir, "pull", "--ff-only"]);
      return fail(
        "pull exited 1",
        "fatal: Not possible to fast-forward, aborting.",
      );
    },
  });
  await assert.rejects(
    h.api.updatePlugin({ name: "demo", req }),
    /更新失败：fatal: Not possible to fast-forward, aborting\./,
  );
  assert.equal(pullCalls(h).length, 1);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "update");
  assert.equal(audit[0].target, "demo");
  assert.equal(audit[0].result, "失败: pull exited 1");
  assert.equal(audit[0].ip, "203.0.113.9");
});

test("uninstall moves the plugin directory and preserves its files", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadPanel(t, root);
  const result = await h.api.uninstallPlugin({ name: "demo", req });
  assert.equal(result.dir, "demo");
  assert.equal(result.needRestart, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(
    path.dirname(result.movedTo),
    path.join(root, "data/panel_removed"),
  );
  assert.match(path.basename(result.movedTo), /^demo-\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    fs.readFileSync(path.join(result.movedTo, "index.js"), "utf8"),
    "export default {}\n",
  );
  assert.deepEqual(h.confirmations, [
    { action: "卸载插件 demo", source: "203.0.113.9（面板 HTTP 请求）" },
  ]);
  assert.deepEqual(h.gitCalls, []);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "uninstall");
  assert.equal(audit[0].target, "demo");
  assert.equal(audit[0].result, `已移动到 ${result.movedTo}`);
});

test("uninstall denial leaves the plugin in place and writes no move audit", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  const h = await loadPanel(t, root, { confirm: false });
  await assert.rejects(
    h.api.uninstallPlugin({ name: "demo", req }),
    /未获得主人私聊确认/,
  );
  assert.equal(fs.existsSync(path.join(dir, "index.js")), true);
  assert.equal(fs.existsSync(path.join(root, "data/panel_removed")), false);
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.gitCalls, []);
  assert.deepEqual(h.api.readAudit(), []);
});

test("uninstall move failure is audited and keeps the source directory", async (t) => {
  const root = fixture(t);
  const dir = makePlugin(root, "demo");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/panel_removed"), "not a directory");
  const h = await loadPanel(t, root);
  await assert.rejects(
    h.api.uninstallPlugin({ name: "demo", req }),
    /移动插件目录失败/,
  );
  assert.equal(fs.existsSync(path.join(dir, "index.js")), true);
  const audit = h.api.readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "uninstall");
  assert.match(audit[0].result, /^失败:/);
});
