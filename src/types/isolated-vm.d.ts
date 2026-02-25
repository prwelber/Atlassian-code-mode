/**
 * Ambient module declaration for isolated-vm.
 *
 * isolated-vm is an optional dependency — it may not be installed in all
 * environments (e.g. where native modules can't compile). This declaration
 * lets TypeScript compile without requiring the package to be present.
 */
declare module 'isolated-vm' {
  export class Isolate {
    constructor(options?: { memoryLimit?: number });
    createContext(): Promise<Context>;
    compileScript(code: string): Promise<Script>;
    dispose(): void;
  }

  export class Context {
    global: Reference;
    eval(code: string): Promise<void>;
  }

  export class Script {
    run(context: Context, options?: { timeout?: number; promise?: boolean }): Promise<unknown>;
  }

  export class Reference {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(fn: (...args: any[]) => any);
    set(key: string, value: unknown): Promise<void>;
    applySyncPromise(receiver: unknown, args: unknown[]): unknown;
  }

  export class Callback {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(fn: (...args: any[]) => any);
  }
}
