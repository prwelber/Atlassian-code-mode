/**
 * Sandbox executor using isolated-vm (V8 isolates).
 *
 * Provides real V8 isolate-level separation with no access to the host
 * process, filesystem, or environment variables. This mirrors Cloudflare's
 * approach of using V8 isolates via Workers, adapted for Node.js.
 *
 * Falls back to a Node vm-based executor if isolated-vm is not available
 * (e.g. in environments where native modules can't be compiled).
 */

import type { Executor, ExecuteResult } from '../types.js';
import { normalizeCode } from '../utils/normalize-code.js';
import {
  SANDBOX_HELPERS_SOURCE,
  select as selectHelper,
  limitFields as limitFieldsHelper,
  estimateSize as estimateSizeHelper,
} from '../utils/response-helpers.js';

/**
 * isolated-vm based executor. Preferred for security.
 *
 * Key pattern: async tool calls cross the isolate boundary via
 * `Reference.applySyncPromise()`. ivm.Callback can only return
 * synchronous values — Promises cannot be cloned across isolates.
 * applySyncPromise blocks the isolate's thread while the host
 * resolves the promise, which is safe because each execution gets
 * its own disposable isolate.
 */
export class IsolatedVMExecutor implements Executor {
  private ivm: typeof import('isolated-vm') | null = null;

  async init(): Promise<void> {
    try {
      this.ivm = await import('isolated-vm');
    } catch {
      throw new Error(
        'isolated-vm not available. Install it with: npm install isolated-vm'
      );
    }
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    if (!this.ivm) await this.init();
    const ivm = this.ivm!;

    const isolate = new ivm.Isolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    const jail = context.global;
    const logs: string[] = [];

    try {
      // Set up log capture — synchronous callback is fine here
      await jail.set(
        '__pushLog',
        new ivm.Callback((msg: string) => {
          logs.push(msg);
        })
      );

      // Set up async tool call bridge using Reference + applySyncPromise.
      // This is the correct pattern for isolated-vm: the Reference is
      // callable from inside the isolate, and applySyncPromise blocks
      // the isolate thread while the host resolves the async function.
      const callToolFn = async (name: string, argsJson: string): Promise<string> => {
        const fn = fns[name];
        if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
        try {
          const args = argsJson ? JSON.parse(argsJson) : {};
          const result = await fn(args);
          return JSON.stringify({ result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: msg });
        }
      };

      await jail.set('__callToolRef', new ivm.Reference(callToolFn));

      // Bootstrap: set up console, the async __callTool bridge, and the
      // atlassian proxy object
      const bootstrap = `
        const console = {
          log: (...args) => __pushLog(args.map(String).join(' ')),
          warn: (...args) => __pushLog('[warn] ' + args.map(String).join(' ')),
          error: (...args) => __pushLog('[error] ' + args.map(String).join(' ')),
        };

        // Response-size helpers: select(), limitFields(), estimateSize()
        ${SANDBOX_HELPERS_SOURCE}

        // Bridge: call host function via Reference.applySyncPromise
        // This blocks the isolate thread while the host resolves the promise.
        function __callTool(name, argsJson) {
          return __callToolRef.applySyncPromise(undefined, [name, argsJson]);
        }

        // Build the atlassian proxy that routes calls to the host
        function buildProxy(prefix) {
          return new Proxy({}, {
            get: (_, methodName) => async (...args) => {
              const fullName = prefix + '.' + String(methodName);
              const resJson = await __callTool(fullName, JSON.stringify(args.length === 1 ? args[0] : args));
              const data = JSON.parse(resJson);
              if (data.error) throw new Error(data.error);
              return data.result;
            }
          });
        }

        const atlassian = {
          jira: buildProxy('jira'),
          confluence: buildProxy('confluence'),
        };
      `;

      await context.eval(bootstrap);

      // Normalize the LLM's code
      const normalized = normalizeCode(code);

      // Execute the code
      const script = await isolate.compileScript(
        `(async () => {
          try {
            const __fn = (${normalized});
            const result = await __fn();
            return JSON.stringify({ result });
          } catch (err) {
            return JSON.stringify({ error: err.message || String(err) });
          }
        })()`
      );

      const resultJson = (await script.run(context, {
        timeout: 30000,
        promise: true,
      })) as string;
      const parsed = JSON.parse(resultJson);

      if (parsed.error) {
        return { result: undefined, error: parsed.error, logs };
      }

      return { result: parsed.result, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: undefined, error: msg, logs };
    } finally {
      isolate.dispose();
    }
  }
}

/**
 * Node VM-based executor. Fallback for environments without isolated-vm.
 * WARNING: Node's vm module is NOT a security mechanism. Use only for development.
 */
export class NodeVMExecutor implements Executor {
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const { createContext, runInNewContext } = await import('node:vm');
    const logs: string[] = [];

    // Build the atlassian proxy
    function buildProxy(prefix: string) {
      return new Proxy(
        {},
        {
          get: (_target, methodName) => {
            return async (...args: unknown[]) => {
              const fullName = `${prefix}.${String(methodName)}`;
              const fn = fns[fullName];
              if (!fn) throw new Error(`Method "${fullName}" not found`);
              return fn(args.length === 1 ? args[0] : args);
            };
          },
        }
      );
    }

    const sandbox = createContext({
      atlassian: {
        jira: buildProxy('jira'),
        confluence: buildProxy('confluence'),
      },
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) =>
          logs.push('[warn] ' + args.map(String).join(' ')),
        error: (...args: unknown[]) =>
          logs.push('[error] ' + args.map(String).join(' ')),
      },
      // Response-size helpers
      select: selectHelper,
      limitFields: limitFieldsHelper,
      estimateSize: estimateSizeHelper,
      JSON,
      Promise,
      Array,
      Object,
      Map,
      Set,
      Date,
      Math,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      setTimeout: undefined,
      setInterval: undefined,
      process: undefined,
      require: undefined,
    });

    try {
      const normalized = normalizeCode(code);
      const wrappedCode = `(async () => { return await (${normalized})(); })()`;
      const result = await runInNewContext(wrappedCode, sandbox, {
        timeout: 30000,
      });
      return { result, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: undefined, error: msg, logs };
    }
  }
}

/**
 * Search-specific executor that injects spec data into the sandbox context.
 * Uses its own isolate with the spec embedded directly — no network access needed.
 */
export class SearchExecutor {
  private specData: { jira: unknown; confluence: unknown };
  private ivm: typeof import('isolated-vm') | null = null;

  constructor(specData: { jira: unknown; confluence: unknown }) {
    this.specData = specData;
  }

  async execute(
    code: string,
    _fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    // Try isolated-vm first, fall back to Node VM
    if (!this.ivm) {
      try {
        this.ivm = await import('isolated-vm');
      } catch {
        return this.executeWithNodeVM(code);
      }
    }
    return this.executeWithIsolatedVM(code);
  }

  private async executeWithIsolatedVM(code: string): Promise<ExecuteResult> {
    const ivm = this.ivm!;
    const isolate = new ivm.Isolate({ memoryLimit: 256 });
    const context = await isolate.createContext();
    const jail = context.global;
    const logs: string[] = [];

    try {
      await jail.set(
        '__pushLog',
        new ivm.Callback((msg: string) => {
          logs.push(msg);
        })
      );

      // Inject spec data as a JSON string, parse inside the isolate.
      // This avoids the "cannot clone" issue with complex objects.
      const specJson = JSON.stringify(this.specData);
      await jail.set('__specJson', specJson);

      const bootstrap = `
        const spec = JSON.parse(__specJson);
        delete globalThis.__specJson;

        const console = {
          log: (...args) => __pushLog(args.map(String).join(' ')),
          warn: (...args) => __pushLog('[warn] ' + args.map(String).join(' ')),
          error: (...args) => __pushLog('[error] ' + args.map(String).join(' ')),
        };
      `;

      await context.eval(bootstrap);

      const normalized = normalizeCode(code);
      const script = await isolate.compileScript(
        `(async () => {
          try {
            const __fn = (${normalized});
            const result = await __fn();
            return JSON.stringify({ result });
          } catch (err) {
            return JSON.stringify({ error: err.message || String(err) });
          }
        })()`
      );

      const resultJson = (await script.run(context, {
        timeout: 30000,
        promise: true,
      })) as string;
      const parsed = JSON.parse(resultJson);

      if (parsed.error) {
        return { result: undefined, error: parsed.error, logs };
      }

      return { result: parsed.result, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: undefined, error: msg, logs };
    } finally {
      isolate.dispose();
    }
  }

  private async executeWithNodeVM(code: string): Promise<ExecuteResult> {
    const { createContext, runInNewContext } = await import('node:vm');
    const logs: string[] = [];

    const sandbox = createContext({
      spec: this.specData,
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) =>
          logs.push('[warn] ' + args.map(String).join(' ')),
        error: (...args: unknown[]) =>
          logs.push('[error] ' + args.map(String).join(' ')),
      },
      JSON,
      Promise,
      Array,
      Object,
      Map,
      Set,
      Date,
      Math,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
    });

    try {
      const normalized = normalizeCode(code);
      const wrappedCode = `(async () => { return await (${normalized})(); })()`;
      const result = await runInNewContext(wrappedCode, sandbox, {
        timeout: 30000,
      });
      return { result, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: undefined, error: msg, logs };
    }
  }
}

/**
 * Create the best available executor for the current environment.
 */
export async function createExecutor(): Promise<Executor> {
  try {
    const executor = new IsolatedVMExecutor();
    await executor.init();
    return executor;
  } catch {
    console.error(
      '[atlassian-codemode] WARNING: isolated-vm not available.\n' +
      '  Falling back to Node.js vm module — this is NOT a security sandbox.\n' +
      '  Sandboxed code can access the host process in this mode.\n' +
      '\n' +
      '  To fix, install isolated-vm:\n' +
      '    npm install isolated-vm\n' +
      '\n' +
      '  Common issues:\n' +
      '    - Missing C++ build tools: install build-essential (Linux), Xcode CLI (macOS), or windows-build-tools (Windows)\n' +
      '    - Incompatible Node.js: isolated-vm requires Node.js 18+ with matching ABI\n' +
      '    - Alpine Linux: apk add python3 make g++\n' +
      '\n' +
      '  For production use, isolated-vm is strongly recommended.'
    );
    return new NodeVMExecutor();
  }
}
