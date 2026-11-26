import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(repoRoot, "plugins/other/update.js");
const tempParent = path.join(repoRoot, "temp");
const ok = (stdout = "", stderr = "") => ({ error: null, stdout, stderr });
const fail = (message, stderr = message) => ({
  error: new Error(message),
  stdout: "",
  stderr,
});
let suiteRoot;

before(() => {
  fs.mkdirSync(tempParent, { recursive: true });
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "update-regression-"));
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
    existsSync: (target) => fs.existsSync(inside(root, target)),
    readFileSync: (target, ...args) =>
      fs.readFileSync(inside(root, target), ...args),
  };
}

function defaultExec(command) {
  if (command.endsWith(" status --porcelain")) return ok();
  if (command.includes(" stash push ")) return ok();
  if (command.endsWith(" stash list -n 1")) return ok();
  if (command.endsWith(" stash pop")) return ok();
  if (command.endsWith(" rev-parse --abbrev-ref HEAD")) return ok("main\n");
  if (command.endsWith(" fetch origin")) return ok();
  if (command.includes(" log origin/")) return ok();
  if (command.includes(" pull --ff-only")) return ok("Already up to date.\n");
  if (command.includes(" reset --hard ")) return ok();
  if (command.endsWith(" remote get-url origin"))
    return ok("https://old.example/repo\n");
  return null;
}

function defaultExecSync(command) {
  if (command.includes("rev-parse --short HEAD")) return "abc1234\n";
  if (command.includes("git log -1") || command.includes("git log  -1"))
    return "11-26 15:00\n";
  if (command.includes("git log  -20"))
    return "def5678||[11-26] new\nabc1234||[11-25] old\n";
  return null;
}

async function loadUpdate(
  t,
  root,
  { handler, syncHandler, probe, ledgerItems = [] } = {},
) {
  const calls = [];
  const syncCalls = [];
  const probes = [];
  const unexpected = [];
  const logs = { debug: [], mark: [], error: [] };
  const logger = Object.fromEntries(
    Object.keys(logs).map((level) => [
      level,
      (message) => logs[level].push(String(message)),
    ]),
  );

  function execute(command, options, callback) {
    calls.push({ command, options });
    const result =
      (handler && handler(command, options)) || defaultExec(command);
    if (!result) {
      unexpected.push(command);
      callback(new Error(`Unexpected git command: ${command}`), "", "");
      return;
    }
    callback(result.error || null, result.stdout || "", result.stderr || "");
  }

  function executeSync(command, options) {
    syncCalls.push({ command, options });
    const result = syncHandler
      ? syncHandler(command, options)
      : defaultExecSync(command);
    if (result == null) {
      unexpected.push(command);
      throw new Error(`Unexpected synchronous git command: ${command}`);
    }
    return result;
  }

  class Plugin {
    constructor(options) {
      Object.assign(this, options);
      this.replies = [];
    }
    async reply(message) {
      this.replies.push(message);
    }
  }

  const mocks = {
    "../../lib/plugins/plugin.js": { default: Plugin },
    module: {
      createRequire: () => (id) => {
        assert.equal(id, "child_process");
        return { exec: execute, execSync: executeSync };
      },
    },
    lodash: { default: { trim: (value) => String(value ?? "").trim() } },
    "node:fs": { default: mockFs(root) },
    "./restart.js": { Restart: class Restart {} },
    "../../lib/common/common.js": { default: { sleep: async () => {} } },
    "../../lib/tools/gitSource.js": {
      ensureRemoteUsable: async (options) => {
        probes.push({
          ...options,
          candidates: Array.from(options.candidates || []),
        });
        if (probe) return probe(options, probes.length);
        return { url: "https://old.example/repo", switched: false };
      },
      candidatesFromLedger: (items, key) => {
        const entry = items.find(
          (item) =>
            String(item.dir).toLowerCase() === String(key).toLowerCase() ||
            String(item.name).toLowerCase() === String(key).toLowerCase(),
        );
        return entry
          ? [...(entry.downloads || []), entry.homepage].filter(Boolean)
          : [];
      },
    },
  };

  const sandbox = {
    console,
    URL,
    TextDecoder,
    Buffer,
    process: { env: {} },
    logger,
    global: { logger },
    setTimeout,
    clearTimeout,
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

  return {
    calls,
    syncCalls,
    probes,
    logs,
    createUpdate({ msg = "#更新", typeName = "MangoCat-Yunzai" } = {}) {
      const instance = new module.namespace.update();
      instance.e = { msg, logFnc: "regression" };
      instance.typeName = typeName;
      return instance;
    },
    pullCalls: () =>
      calls.filter((call) => call.command.includes("pull --ff-only")),
  };
}

test("preCommit skips a directory without .git", async (t) => {
  const h = await loadUpdate(t, fixture(t));
  assert.equal(await h.createUpdate().preCommit(), false);
  assert.deepEqual(h.calls, []);
});

test("preCommit does not stash a clean worktree", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root);
  assert.equal(await h.createUpdate().preCommit(), false);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['git -C "." status --porcelain'],
  );
});

test("preCommit stashes dirty tracked and untracked files with prompting disabled", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" status --porcelain"))
        return ok(" M local.txt\n?? untracked.txt\n");
      if (command.includes(" stash push "))
        return ok("Saved working directory and index state\n");
      return null;
    },
  });
  assert.equal(await h.createUpdate().preCommit(), true);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      'git -C "." status --porcelain',
      'git -C "." stash push -u -m "更新前暂存"',
    ],
  );
  assert.equal(h.calls[1].options.windowsHide, true);
  assert.equal(h.calls[1].options.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(h.logs.mark.some((message) => message.includes("已暂存本地改动")));
});

test("preCommit reports stash failure and does not claim a stash was made", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" status --porcelain")) return ok(" M local.txt\n");
      if (command.includes(" stash push ")) return fail("stash is locked");
      return null;
    },
  });
  assert.equal(await h.createUpdate().preCommit(), false);
  assert.equal(
    h.calls.filter((call) => call.command.includes("stash push")).length,
    1,
  );
  assert.ok(
    h.logs.debug.some((message) => message.includes("stash is locked")),
  );
});

test("preCommit aborts when git status fails", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, { handler: () => fail("status failed") });
  assert.equal(await h.createUpdate().preCommit(), false);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['git -C "." status --porcelain'],
  );
});

test("preCommit targets an independent plugin repository", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/demo/.git"), { recursive: true });
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" status --porcelain")) return ok(" M plugin.js\n");
      if (command.includes(" stash push ")) return ok();
      return null;
    },
  });
  assert.equal(await h.createUpdate().preCommit("demo"), true);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      'git -C "./plugins/demo" status --porcelain',
      'git -C "./plugins/demo" stash push -u -m "更新前暂存"',
    ],
  );
});

test("postRestore skips a directory without .git", async (t) => {
  const h = await loadUpdate(t, fixture(t));
  await h.createUpdate().postRestore();
  assert.deepEqual(h.calls, []);
});

test("postRestore pops only a matching stack-top stash", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const stash = ["stash@{0}: WIP on main: 更新前暂存"];
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" stash list -n 1")) return ok(`${stash[0]}\n`);
      if (command.endsWith(" stash pop")) {
        stash.shift();
        return ok("Restored local changes\n");
      }
      return null;
    },
  });
  await h.createUpdate().postRestore();
  assert.deepEqual(stash, []);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['git -C "." stash list -n 1', 'git -C "." stash pop'],
  );
});

test("postRestore leaves a user stash untouched even when an older stash has the marker", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/demo/.git"), { recursive: true });
  const stash = [
    "stash@{0}: WIP on main: user changes",
    "stash@{1}: WIP on main: 更新前暂存",
  ];
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" stash list -n 1")) return ok(`${stash[0]}\n`);
      return null;
    },
  });
  await h.createUpdate().postRestore("demo");
  assert.deepEqual(stash, [
    "stash@{0}: WIP on main: user changes",
    "stash@{1}: WIP on main: 更新前暂存",
  ]);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['git -C "./plugins/demo" stash list -n 1'],
  );
});

test("postRestore does not pop when stash inspection fails", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler: () => fail("cannot read stash"),
  });
  await h.createUpdate().postRestore();
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['git -C "." stash list -n 1'],
  );
});

test("postRestore preserves the stash on pop conflict and never drops it", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const stash = ["stash@{0}: WIP on main: 更新前暂存"];
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" stash list -n 1")) return ok(`${stash[0]}\n`);
      if (command.endsWith(" stash pop"))
        return fail("CONFLICT: local changes overlap");
      return null;
    },
  });
  await h.createUpdate().postRestore();
  assert.deepEqual(stash, ["stash@{0}: WIP on main: 更新前暂存"]);
  assert.equal(
    h.calls.some((call) => call.command.includes("stash drop")),
    false,
  );
  assert.ok(h.logs.mark.some((message) => message.includes("已保留在 stash")));
});

test("autoCleanLocalCommits skips a directory without .git", async (t) => {
  const h = await loadUpdate(t, fixture(t));
  await h.createUpdate().autoCleanLocalCommits();
  assert.deepEqual(h.calls, []);
});

test("autoCleanLocalCommits resets only automatic commits onto the actual remote branch", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" rev-parse --abbrev-ref HEAD"))
        return ok("release/stable\n");
      if (command.includes(" log origin/"))
        return ok(
          "自动提交本地改动\nMerge branch 'main' of https://old.example/repo\nupdate README.md.\n",
        );
      return null;
    },
  });
  await h.createUpdate().autoCleanLocalCommits();
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      'git -C "." rev-parse --abbrev-ref HEAD',
      'git -C "." fetch origin',
      'git -C "." log origin/release/stable..HEAD --pretty=%s',
      'git -C "." reset --hard origin/release/stable',
    ],
  );
  assert.ok(h.logs.mark.some((message) => message.includes("已清理 3 个")));
});

test("autoCleanLocalCommits never resets when a user commit is mixed in", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/demo/.git"), { recursive: true });
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.includes(" log origin/"))
        return ok("自动提交本地改动\nfix: preserve my feature\n");
      return null;
    },
  });
  await h.createUpdate().autoCleanLocalCommits("demo");
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      'git -C "./plugins/demo" rev-parse --abbrev-ref HEAD',
      'git -C "./plugins/demo" fetch origin',
      'git -C "./plugins/demo" log origin/main..HEAD --pretty=%s',
    ],
  );
  assert.equal(
    h.calls.some((call) => call.command.includes("reset --hard")),
    false,
  );
});

test("autoCleanLocalCommits does not reset without local ahead commits", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root);
  await h.createUpdate().autoCleanLocalCommits();
  assert.equal(
    h.calls.some((call) => call.command.includes("reset --hard")),
    false,
  );
  assert.equal(
    h.calls.filter((call) => call.command.includes("log origin/")).length,
    1,
  );
});

test("autoCleanLocalCommits does not reset when commit inspection fails", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.includes(" log origin/")) return fail("log failed");
      return null;
    },
  });
  await h.createUpdate().autoCleanLocalCommits();
  assert.equal(
    h.calls.some((call) => call.command.includes("reset --hard")),
    false,
  );
});

test("runUpdate uses a plain ff-only pull for the main repository", async (t) => {
  const h = await loadUpdate(t, fixture(t));
  assert.equal(await h.createUpdate().runUpdate(), true);
  assert.deepEqual(
    h.pullCalls().map((call) => call.command),
    ["git pull --ff-only"],
  );
  assert.equal(
    h.calls.some((call) => /fetch|reset/.test(call.command)),
    false,
  );
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].dir, ".");
  assert.equal(h.syncCalls.length, 2);
});

test("runUpdate uses a plain ff-only pull for a plugin after cleanup checks", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/demo/.git"), { recursive: true });
  const h = await loadUpdate(t, root);
  assert.equal(
    await h
      .createUpdate({ msg: "#更新demo", typeName: "demo" })
      .runUpdate("demo"),
    true,
  );
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      'git -C "./plugins/demo" rev-parse --abbrev-ref HEAD',
      'git -C "./plugins/demo" fetch origin',
      'git -C "./plugins/demo" log origin/main..HEAD --pretty=%s',
      'git -C "./plugins/demo" status --porcelain',
      "git -C ./plugins/demo/ pull --ff-only",
    ],
  );
  assert.equal(h.probes[0].dir, "./plugins/demo");
});

test("forced main update fetches all and resets the actual branch before ff-only pull", async (t) => {
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git rev-parse --abbrev-ref HEAD")
        return ok("feature/topic\n");
      return null;
    },
  });
  const update = h.createUpdate({ msg: "#强制更新" });
  assert.equal(await update.runUpdate(), true);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      "git rev-parse --abbrev-ref HEAD",
      "git fetch --all && git reset --hard origin/feature/topic && git pull --ff-only",
    ],
  );
  assert.equal(
    h.calls.some((call) => call.command.includes("stash")),
    false,
  );
});

test("forced main update falls back to main only when branch detection fails", async (t) => {
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git rev-parse --abbrev-ref HEAD")
        return fail("detached HEAD");
      return null;
    },
  });
  assert.equal(await h.createUpdate({ msg: "#强制更新" }).runUpdate(), true);
  assert.deepEqual(
    h.pullCalls().map((call) => call.command),
    ["git fetch --all && git reset --hard origin/main && git pull --ff-only"],
  );
});

test("forced plugin update is ultimately overridden to ordinary ff-only pull", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/demo/.git"), { recursive: true });
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command === "git -C ./plugins/demo/ rev-parse --abbrev-ref HEAD")
        return ok("release\n");
      return null;
    },
  });
  assert.equal(
    await h
      .createUpdate({ msg: "#强制更新demo", typeName: "demo" })
      .runUpdate("demo"),
    true,
  );
  assert.deepEqual(
    h.calls.map((call) => call.command),
    [
      "git -C ./plugins/demo/ rev-parse --abbrev-ref HEAD",
      "git -C ./plugins/demo/ pull --ff-only",
    ],
  );
  assert.equal(
    h.calls.some((call) => /fetch|reset|stash/.test(call.command)),
    false,
  );
});

test("failed pull restores stashed local changes before returning failure", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" status --porcelain")) return ok(" M local.txt\n");
      if (command.includes(" stash push ")) return ok();
      if (command === "git pull --ff-only")
        return fail("simulated pull failure");
      if (command.endsWith(" stash list -n 1"))
        return ok("stash@{0}: WIP on main: 更新前暂存\n");
      if (command.endsWith(" stash pop")) return ok();
      return null;
    },
  });
  const update = h.createUpdate();
  assert.equal(await update.runUpdate(), false);
  const commands = h.calls.map((call) => call.command);
  assert.ok(
    commands.indexOf('git -C "." stash push -u -m "更新前暂存"') <
      commands.indexOf("git pull --ff-only"),
  );
  assert.ok(
    commands.indexOf("git pull --ff-only") <
      commands.indexOf('git -C "." stash pop'),
  );
  assert.equal(
    commands.filter((command) => command.endsWith("stash pop")).length,
    1,
  );
  assert.notEqual(update.isUp, true);
  assert.ok(update.replies.length > 0);
});

test("failed remote probe prevents cleanup, stash, commit lookup, and pull", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  const h = await loadUpdate(t, root, {
    probe: async () => {
      throw new Error("all remotes unreachable");
    },
  });
  const update = h.createUpdate();
  assert.equal(await update.runUpdate(), false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.syncCalls, []);
  assert.equal(h.probes.length, 1);
  assert.ok(
    update.replies.some((message) =>
      String(message).includes("all remotes unreachable"),
    ),
  );
});

test("current behavior: a failed pull after switching source leaves origin on the new mirror", async (t) => {
  let origin = "https://old.example/repo";
  let pulls = 0;
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git pull --ff-only") {
        pulls += 1;
        return pulls === 1
          ? fail("could not read Username: terminal prompts disabled")
          : fail("mirror pull failed");
      }
      if (command.endsWith(" remote get-url origin")) return ok(`${origin}\n`);
      return null;
    },
    probe(_options, count) {
      if (count === 2) origin = "https://mirror.example/repo";
      return { url: origin, switched: count === 2 };
    },
  });
  assert.equal(await h.createUpdate().runUpdate(), false);
  assert.equal(origin, "https://mirror.example/repo");
  assert.equal(h.probes.length, 2);
  assert.equal(h.pullCalls().length, 2);
  assert.equal(
    h.calls.filter((call) => call.command.includes("remote set-url")).length,
    0,
  );
});

test("non-credential pull failure does not switch source or retry", async (t) => {
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git pull --ff-only")
        return fail("remote hung up unexpectedly");
      return null;
    },
  });
  assert.equal(await h.createUpdate().runUpdate(), false);
  assert.equal(h.probes.length, 1);
  assert.deepEqual(
    h.pullCalls().map((call) => call.command),
    ["git pull --ff-only"],
  );
});

test("credential failure switches source and retries exactly once", async (t) => {
  let origin = "https://old.example/repo";
  const pulledOrigins = [];
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git pull --ff-only") {
        pulledOrigins.push(origin);
        return pulledOrigins.length === 1
          ? fail("could not read Username: terminal prompts disabled")
          : ok("Already up to date.\n");
      }
      return null;
    },
    probe(_options, count) {
      if (count === 2) origin = "https://mirror.example/repo";
      return { url: origin, switched: count === 2 };
    },
  });
  assert.equal(await h.createUpdate().runUpdate(), true);
  assert.equal(h.probes.length, 2);
  assert.deepEqual(pulledOrigins, [
    "https://old.example/repo",
    "https://mirror.example/repo",
  ]);
  assert.equal(h.pullCalls().length, 2);
});

test("credential retry after source switch still restores stashed changes on failure", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  let pulls = 0;
  const h = await loadUpdate(t, root, {
    handler(command) {
      if (command.endsWith(" status --porcelain")) return ok(" M local.txt\n");
      if (command.includes(" stash push ")) return ok();
      if (command === "git pull --ff-only") {
        pulls += 1;
        return pulls === 1
          ? fail("could not read Username: terminal prompts disabled")
          : fail("mirror pull failed");
      }
      if (command.endsWith(" stash list -n 1"))
        return ok("stash@{0}: WIP on main: 更新前暂存\n");
      if (command.endsWith(" stash pop")) return ok();
      return null;
    },
    probe: async (_options, count) => ({
      url: `https://mirror-${count}.example/repo`,
      switched: count === 2,
    }),
  });
  assert.equal(await h.createUpdate().runUpdate(), false);
  assert.equal(pulls, 2);
  assert.equal(
    h.calls.filter((call) => call.command.endsWith("stash pop")).length,
    1,
  );
  const commands = h.calls.map((call) => call.command);
  assert.ok(
    commands.indexOf("git pull --ff-only") <
      commands.lastIndexOf("git pull --ff-only"),
  );
  assert.ok(
    commands.lastIndexOf("git pull --ff-only") <
      commands.indexOf('git -C "." stash pop'),
  );
});

test("a second credential failure is not retried a third time", async (t) => {
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git pull --ff-only")
        return fail("could not read Username: terminal prompts disabled");
      return null;
    },
    probe: async (_options, count) => ({
      url: `https://mirror-${count}.example/repo`,
      switched: true,
    }),
  });
  assert.equal(await h.createUpdate().runUpdate(), false);
  assert.equal(h.probes.length, 2);
  assert.equal(h.pullCalls().length, 2);
});

test("credential failure does not retry when the replacement source also fails probing", async (t) => {
  const h = await loadUpdate(t, fixture(t), {
    handler(command) {
      if (command === "git pull --ff-only")
        return fail("could not read Username: terminal prompts disabled");
      return null;
    },
    probe(_options, count) {
      if (count === 2) throw new Error("replacement unreachable");
      return { url: "https://old.example/repo", switched: false };
    },
  });
  assert.equal(await h.createUpdate().runUpdate(), false);
  assert.equal(h.probes.length, 2);
  assert.equal(h.pullCalls().length, 1);
});
