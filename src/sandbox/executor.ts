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

/**
 * isolated-vm based executor. Preferred for security.
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
      // Set up log capture
      await jail.set(
        '__pushLog',
        new ivm.Callback((msg: string) => {
          logs.push(msg);
        })
      );

      // Set up tool call bridge — each function is callable from inside the isolate
      const fnNames = Object.keys(fns);
      await jail.set(
        '__callTool',
        new ivm.Callback(
          async (name: string, argsJson: string): Promise<string> => {
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
          }
        )
      );

      // Build the bootstrap script that sets up the sandbox environment
      const bootstrap = `
        const console = {
          log: (...args) => __pushLog(args.map(String).join(' ')),
          warn: (...args) => __pushLog('[warn] ' + args.map(String).join(' ')),
          error: (...args) => __pushLog('[error] ' + args.map(String).join(' ')),
        };

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

        // For search tool — spec is injected separately
        // (spec.jira and spec.confluence will be set if this is a search execution)
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

      const resultJson = await script.run(context, { timeout: 30000 }) as string;
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
 */
export class SearchExecutor implements Executor {
  private inner: Executor;
  private specData: { jira: unknown; confluence: unknown };

  constructor(
    inner: Executor,
    specData: { jira: unknown; confluence: unknown }
  ) {
    this.inner = inner;
    this.specData = specData;
  }

  async execute(
    code: string,
    _fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    // For search, we don't need tool functions — just spec access.
    // We pass spec access via a synthetic tool function.
    const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      '__getSpec': async () => this.specData,
    };

    // Wrap the code to inject spec before execution
    const wrappedCode = `async () => {
      const spec = await __callTool('__getSpec', '{}').then(r => JSON.parse(r).result);
      return await (${normalizeCode(code)})();
    }`;

    // For the NodeVM executor, we need a different approach
    if (this.inner instanceof NodeVMExecutor) {
      return this.executeWithNodeVM(code);
    }

    return this.inner.execute(wrappedCode, fns);
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
      '[atlassian-codemode] isolated-vm not available, falling back to Node VM (NOT SECURE for production)'
    );
    return new NodeVMExecutor();
  }
}
