"use strict";
// The plugin test kit (F-25), linked into a test build as the module the
// test file imports from `<api>/testing`. It runs inside the mod worker:
// everything a hook reaches on `$` is a mock here, nothing crosses to the
// runtime. Plain JavaScript, CommonJS, no forbidden identifiers.

const cases = [];
const groups = [];
// Assertions still settling when their test returns (an un-awaited async
// `toThrow`); the case fails if one of them rejects.
let pending = [];

function test(name, fn) {
  if (typeof name !== "string" || typeof fn !== "function") throw new TypeError("test(name, fn)");
  cases.push({ name: groups.concat(name).join(" > "), fn });
}

function describe(name, fn) {
  if (typeof name !== "string" || typeof fn !== "function") throw new TypeError("describe(name, fn)");
  groups.push(name);
  try {
    fn();
  } finally {
    groups.pop();
  }
}

// ── expect ──

function show(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 200 ? text.slice(0, 199) + "…" : text;
  } catch (_) {
    return String(value);
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function partialMatch(actual, wanted) {
  if (typeof wanted !== "object" || wanted === null) return Object.is(actual, wanted);
  if (typeof actual !== "object" || actual === null) return false;
  return Object.keys(wanted).every((k) => partialMatch(actual[k], wanted[k]));
}

function expect(actual) {
  const make = (negate) => {
    const check = (ok, message) => {
      if (ok === negate) throw new Error((negate ? "expected not: " : "expected: ") + message);
    };
    const m = {
      toBe: (want) => check(Object.is(actual, want), show(actual) + " to be " + show(want)),
      toEqual: (want) => check(deepEqual(actual, want), show(actual) + " to equal " + show(want)),
      toMatchObject: (want) => check(partialMatch(actual, want), show(actual) + " to match " + show(want)),
      toContain: (want) =>
        check(
          (typeof actual === "string" || Array.isArray(actual)) && actual.includes(want),
          show(actual) + " to contain " + show(want),
        ),
      toMatch: (re) => check(typeof actual === "string" && new RegExp(re).test(actual), show(actual) + " to match " + String(re)),
      toHaveLength: (n) => check(actual != null && actual.length === n, show(actual) + " to have length " + n),
      toBeTruthy: () => check(!!actual, show(actual) + " to be truthy"),
      toBeFalsy: () => check(!actual, show(actual) + " to be falsy"),
      toBeUndefined: () => check(actual === undefined, show(actual) + " to be undefined"),
      toBeDefined: () => check(actual !== undefined, show(actual) + " to be defined"),
      // Synchronous for a function that returns no promise; a promise
      // (awaited by the case even when the test does not) otherwise.
      toThrow: (pattern) => {
        const verdict = (threw, thrown) => {
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          const ok = threw && (pattern === undefined || new RegExp(pattern).test(message));
          check(ok, "a throw" + (pattern === undefined ? "" : " matching " + String(pattern)) + (threw ? ", got " + show(message) : ", nothing was thrown"));
        };
        let run;
        try {
          run = typeof actual === "function" ? actual() : actual;
        } catch (error) {
          return verdict(true, error);
        }
        if (!run || typeof run.then !== "function") return verdict(false, undefined);
        const settled = Promise.resolve(run).then(
          () => verdict(false, undefined),
          (error) => verdict(true, error),
        );
        pending.push(settled);
        return settled;
      },
    };
    return m;
  };
  const positive = make(false);
  positive.not = make(true);
  return positive;
}

// ── mocks ──

function fn(impl) {
  const calls = [];
  const spy = function (...args) {
    calls.push(args);
    return impl ? impl.apply(this, args) : undefined;
  };
  spy.calls = calls;
  return spy;
}

const mock = { fn };

// ── the plugin under test ──

function selects(pattern, event) {
  if (pattern === "*") return !event.startsWith("telemetry.");
  if (pattern.endsWith(".*")) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

function loadPlugin(register, setup) {
  if (typeof register !== "function") throw new TypeError("loadPlugin(register): register is the hooks module's register function");
  const config = setup || {};
  const name = typeof config.name === "string" ? config.name : "plugin-under-test";
  const hooks = [];
  const testHooks = [];
  const recorded = [];
  const stubs = new Map();
  const store = new Map(Object.entries(config.store || {}));
  // `$.state`: per address, the value and its version (compare-and-set).
  const state = new Map(Object.entries(config.state || {}).map(([k, value]) => [k, { value, version: 1 }]));
  const env = Object.assign({}, config.env || {});
  let now = typeof config.now === "number" ? config.now : 0;
  const timers = [];
  const handlers = new Map();
  let handleCount = 0;
  // The handles of the view drawing now, so a redraw drops only its own.
  let drawing;

  const later = (ms, fire) => {
    const timer = { at: now + Math.max(0, Number(ms) || 0), fire, live: true };
    timers.push(timer);
    return timer;
  };

  const stateKey = (ref) => (ref && typeof ref === "object" ? ref.plugin + "/" + ref.key + (ref.id ? "/" + ref.id : "") : String(ref));

  const keep = (fns) => {
    const handle = "k" + ++handleCount;
    handlers.set(handle, fns);
    if (drawing) drawing.add(handle);
    return handle;
  };

  const elements = () => {
    const kids = (children) => (children === undefined ? [] : [].concat(children).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    const rest = (props) => {
      const out = Object.assign({}, props || {});
      delete out.children;
      return out;
    };
    const styled = (type) => (props) => ({ type, props: rest(props), children: kids(props && props.children) });
    return Object.freeze({
      Box: styled("Box"),
      Text: styled("Text"),
      Link: styled("Link"),
      Button: (props) => {
        const r = rest(props);
        if (typeof r.onPress !== "function") throw new TypeError("Button: onPress is not a function");
        const children = kids(props && props.children);
        const label = typeof r.label === "string" ? r.label : children.length === 1 && typeof children[0] === "string" ? children[0] : undefined;
        if (label === undefined && children.length === 0) throw new TypeError("Button: a label, or children, is required");
        const press = { plugin: name, handle: keep({ default: r.onPress }) };
        delete r.onPress;
        return { type: "Button", props: Object.assign(r, { key: typeof r.key === "string" ? r.key : label, label }), press, children };
      },
      Input: (props) => {
        const r = rest(props);
        if (typeof r.onSubmit !== "function") throw new TypeError("Input: onSubmit is not a function");
        const fns = { submit: r.onSubmit };
        if (typeof r.onInput === "function") fns.change = r.onInput;
        delete r.onSubmit;
        delete r.onInput;
        return { type: "Input", props: r, press: { plugin: name, handle: keep(fns) } };
      },
      Select: (props) => {
        const r = rest(props);
        if (typeof r.onSelect !== "function") throw new TypeError("Select: onSelect is not a function");
        const press = { plugin: name, handle: keep({ default: r.onSelect }) };
        delete r.onSelect;
        return { type: "Select", props: r, press };
      },
      Svg: (props) => ({ type: "Svg", props: rest(props) }),
      Code: (props) => ({ type: "Code", props: rest(props) }),
      Markdown: (props) => {
        const r = rest(props);
        if (typeof r.onLinkPress !== "function") return { type: "Markdown", props: r };
        const press = { plugin: name, handle: keep({ default: r.onLinkPress }) };
        delete r.onLinkPress;
        return { type: "Markdown", props: r, press };
      },
    });
  };

  // The served nouns: each call recorded, a stub answering first.
  const served = {
    clock: {
      now: () => now,
      sleep: (ms) => new Promise((resolve) => later(ms, resolve)),
    },
    store: {
      get: (key) => (store.has(key) ? store.get(key) : undefined),
      set: (key, value) => {
        store.set(key, value);
      },
      delete: (key) => store.delete(key),
      keys: () => Array.from(store.keys()),
    },
    state: {
      get: (ref) => {
        const held = state.get(stateKey(ref));
        return held ? { value: held.value, version: held.version } : { value: undefined, version: 0 };
      },
      set: (ref, value, options) => {
        const current = state.has(stateKey(ref)) ? state.get(stateKey(ref)).version : 0;
        const ifVersion = options && typeof options.ifVersion === "number" ? options.ifVersion : undefined;
        if (ifVersion !== undefined && ifVersion !== current) return { isSet: false, version: current };
        state.set(stateKey(ref), { value, version: current + 1 });
        return { isSet: true, version: current + 1 };
      },
    },
    env: { get: (key) => env[key] },
    session: {
      id: () => "test-session",
      messages: () => (config.messages || []).slice(),
    },
    ui: {
      notify: (args) => {
        const delay = args && typeof args.delayMs === "number" ? args.delayMs : 0;
        if (delay > 0) later(delay, () => recorded.push({ noun: "ui", method: "notify.fired", args: [args] }));
        return { isSent: false, reason: "no-surface" };
      },
    },
  };

  const call = (noun, method, args) => {
    recorded.push({ noun, method, args });
    const stub = stubs.get(noun + "." + method);
    if (stub) return Promise.resolve().then(() => stub.apply(undefined, args));
    const table = served[noun];
    if (table && typeof table[method] === "function") return Promise.resolve().then(() => table[method].apply(undefined, args));
    return Promise.resolve(undefined);
  };

  const clockTimer = (which) => (ms, callback) => {
    if (typeof callback !== "function") throw new TypeError("$.clock." + which + "(ms, fn)");
    recorded.push({ noun: "clock", method: which, args: [ms] });
    let timer;
    let cancelled = false;
    const arm = () => {
      timer = later(ms, () => {
        callback();
        if (which === "every" && !cancelled) arm();
      });
    };
    arm();
    return {
      cancel: () => {
        cancelled = true;
        timer.live = false;
      },
    };
  };

  const dollar = () => {
    let resolved;
    const ui = new Proxy(
      {
        resolve: (e) => {
          if (!e || e.surface !== "desktop") throw new TypeError("$.ui.resolve(e): e is not this surface's ui.render argument");
          resolved = resolved || elements();
          return resolved;
        },
      },
      {
        get: (target, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          if (method in target) return target[method];
          return (...args) => call("ui", method, args);
        },
      },
    );
    const clock = new Proxy(
      { after: clockTimer("after"), every: clockTimer("every") },
      {
        get: (target, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          if (method in target) return target[method];
          return (...args) => call("clock", method, args);
        },
      },
    );
    const plugin = Object.freeze({ name, root: "", locale: config.locale || "en", options: config.options || {} });
    return new Proxy(
      {},
      {
        get: (_, noun) => {
          if (typeof noun !== "string" || noun === "then") return undefined;
          if (noun === "ui") return ui;
          if (noun === "clock") return clock;
          if (noun === "plugin") return plugin;
          return new Proxy(
            {},
            {
              get: (__, method) => {
                if (typeof method !== "string" || method === "then") return undefined;
                return (...args) => call(noun, method, args);
              },
            },
          );
        },
      },
    );
  };

  const on = (list) => (pattern, second, third) => {
    const hasMatcher = third !== undefined;
    const hook = hasMatcher ? third : second;
    if (typeof pattern !== "string") throw new TypeError("on(pattern, hook): the pattern is not a string");
    if (typeof hook !== "function") throw new TypeError("on(\"" + pattern + "\"): the hook is not a function");
    list.push({ pattern, matcher: hasMatcher ? second : undefined, hook });
    return { catch: (handler) => (list[list.length - 1].catchHandler = handler) };
  };

  register(on(hooks), config.options || {});

  // The chain: the plugin's hooks, then the test's own, then `below`.
  const fire = (event, e, below) => {
    const core = typeof below === "function" ? below : (x) => x;
    const chain = hooks.concat(testHooks).filter((h) => selects(h.pattern, event) && (h.matcher === undefined || partialMatch(e, h.matcher)));
    const run = (index, value) => {
      if (index >= chain.length) return Promise.resolve().then(() => core(value));
      const link = chain[index];
      const next = (changed) => run(index + 1, changed === undefined ? value : changed);
      return Promise.resolve()
        .then(() => link.hook(dollar(), value, next))
        .catch((error) => {
          if (!link.catchHandler) throw error;
          return link.catchHandler(dollar(), value, next, error);
        });
    };
    return run(0, e);
  };

  const advance = async (ms) => {
    const until = now + Math.max(0, Number(ms) || 0);
    for (;;) {
      await Promise.resolve();
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      timers.splice(timers.indexOf(due), 1);
      await due.fire();
    }
    now = until;
  };

  const mount = async (surface, component, props) => {
    if (surface !== "desktop") {
      throw new Error("mount(\"" + surface + "\"): not supported: Velloc draws the desktop surface only");
    }
    const view = { tree: undefined };
    let requestCount = 0;
    const own = new Set();
    const draw = async () => {
      for (const handle of own) handlers.delete(handle);
      own.clear();
      const outer = drawing;
      drawing = own;
      try {
        const out = await fire("ui.render", { surface: "desktop", component, requestId: "r" + ++requestCount, props: props || {} }, () => ({ type: "engine", ref: component }));
        view.tree = out;
        return out;
      } finally {
        drawing = outer;
      }
    };
    const textOf = (node) =>
      typeof node === "string" || typeof node === "number"
        ? String(node)
        : node && typeof node === "object"
          ? [node.props && typeof node.props.label === "string" && !(node.children || []).length ? node.props.label : ""]
              .concat((node.children || []).map(textOf))
              .join("")
          : "";
    const all = (node, out) => {
      if (node && typeof node === "object") {
        out.push(node);
        (node.children || []).forEach((child) => all(child, out));
      }
      return out;
    };
    const findAll = (query) =>
      all(view.tree, []).filter((node) => {
        if (typeof query === "string") return node.press ? textOf(node) === query || (node.props && node.props.key === query) : false;
        if (query && typeof query === "object") {
          if (query.type !== undefined && node.type !== query.type) return false;
          if (query.key !== undefined && !(node.props && node.props.key === query.key)) return false;
          if (query.role !== undefined && !(node.props && node.props.role === query.role)) return false;
          if (query.text !== undefined && !textOf(node).includes(query.text)) return false;
          return true;
        }
        return false;
      });
    const find = (query) => {
      const found = findAll(query);
      if (found.length === 0) throw new Error("find(" + show(query) + "): nothing in the drawing matches");
      return found[0];
    };
    const act = async (query, which, args) => {
      const node = find(query);
      if (!node.press) throw new Error("find(" + show(query) + "): the element takes no input");
      const fns = handlers.get(node.press.handle);
      const handler = fns && fns[which];
      if (!handler) throw new Error("the element has no " + which + " handler");
      await handler.apply(undefined, args);
      await Promise.resolve();
      return draw();
    };
    view.find = find;
    view.findAll = findAll;
    view.text = () => textOf(view.tree);
    view.redraw = draw;
    view.press = (query) => act(query, "default", [{}]);
    view.select = (query, value) => act(query, "default", [value, {}]);
    view.input = (query, value) => act(query, "change", [value, {}]);
    view.submit = (query, value) => act(query, "submit", [value, {}]);
    await draw();
    return view;
  };

  return {
    name,
    fire,
    on: on(testHooks),
    calls: (which) => (which === undefined ? recorded.slice() : recorded.filter((c) => c.noun + "." + c.method === which)),
    stub: (which, answer) => {
      stubs.set(which, typeof answer === "function" ? answer : () => answer);
    },
    store,
    stateOf: (ref) => {
      const held = state.get(stateKey(ref));
      return held ? held.value : undefined;
    },
    env,
    clock: { now: () => now, advance },
    mount,
  };
}

// ── the run ──

// The module is named by its `sourceURL` in a mod worker, by its `data:` URL elsewhere.
const FRAME = /(?:data:text\/javascript;base64,[A-Za-z0-9+/=]*|velloc-mod-module\.js):(\d+):(\d+)/g;

function framesOf(error) {
  const stack = error && typeof error.stack === "string" ? error.stack : "";
  const out = [];
  for (const m of stack.matchAll(FRAME)) {
    out.push({ line: Number(m[1]), column: Number(m[2]) });
    if (out.length >= 8) break;
  }
  return out;
}

// One case's time limit: a hung case fails alone, and the cases after it
// still run while the file's budget lasts.
function within(ms, run) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the test ran past " + ms + " ms")), ms);
  });
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

async function runAll(e) {
  const caseMs = e && typeof e.caseMs === "number" ? e.caseMs : 10000;
  const deadline = Date.now() + (e && typeof e.fileMs === "number" ? e.fileMs : 50000);
  const results = [];
  for (const c of cases) {
    const left = deadline - Date.now();
    if (left <= 0) {
      results.push({ name: c.name, ok: false, message: "not run: the file ran out of time", frames: [] });
      continue;
    }
    pending = [];
    try {
      await within(Math.min(caseMs, left), (async () => {
        await c.fn();
        await Promise.all(pending);
      })());
      results.push({ name: c.name, ok: true });
    } catch (error) {
      results.push({
        name: c.name,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        frames: framesOf(error),
      });
    }
  }
  return { tests: results };
}

exports.test = test;
exports.it = test;
exports.describe = describe;
exports.expect = expect;
exports.mock = mock;
exports.loadPlugin = loadPlugin;
// The runner's door: the test build's own register.
exports.__register = (on) => {
  on("test.run", ($, e) => runAll(e));
};
