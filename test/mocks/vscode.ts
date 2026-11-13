type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "CancellationError";
  }
}

export class LanguageModelError extends Error {
  readonly code: string;

  constructor(message = "", code = "Unknown") {
    super(message);
    this.name = "LanguageModelError";
    this.code = code;
  }

  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }

  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }

  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
} as const;

export const l10n = {
  t(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) =>
      String(args[Number(index)] ?? ""),
    );
  },
};

export const state = {
  vendor: "",
  provider: undefined as unknown,
  providers: new Map<string, unknown>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  output: [] as string[],
  outputShown: false,
  configuration: new Map<string, unknown>(),
  executed: [] as Array<{ command: string; args: unknown[] }>,
  commandHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  inputQueue: [] as Array<string | undefined>,
  messages: {
    info: [] as string[],
    error: [] as string[],
    warning: [] as string[],
  },
};

const outputChannel = {
  appendLine(line: string): void {
    state.output.push(line);
  },
  show(): void {
    state.outputShown = true;
  },
  dispose(): void {
    // no-op
  },
};

export const window = {
  createOutputChannel(): typeof outputChannel {
    return outputChannel;
  },
  async showInputBox(): Promise<string | undefined> {
    return state.inputQueue.shift();
  },
  async showInformationMessage(message: string): Promise<void> {
    state.messages.info.push(message);
  },
  async showErrorMessage(message: string): Promise<void> {
    state.messages.error.push(message);
  },
  async showWarningMessage(message: string): Promise<undefined> {
    state.messages.warning.push(message);
    return undefined;
  },
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const value = state.configuration.get(`${section}.${key}`);
        return (value as T | undefined) ?? defaultValue;
      },
      async update(key: string, value: unknown): Promise<void> {
        state.configuration.set(`${section}.${key}`, value);
      },
    };
  },
  onDidChangeConfiguration(
    _listener: (event: {
      affectsConfiguration(section: string): boolean;
    }) => void,
  ) {
    return { dispose: () => undefined };
  },
};

export const commands = {
  registerCommand(
    id: string,
    callback: (...args: unknown[]) => unknown,
  ) {
    state.commands.set(id, callback);
    return { dispose: () => state.commands.delete(id) };
  },
  async executeCommand(
    command: string,
    ...args: unknown[]
  ): Promise<unknown> {
    state.executed.push({ command, args });
    const handler = state.commandHandlers.get(command);
    return handler ? handler(...args) : undefined;
  },
};

export const lm = {
  registerLanguageModelChatProvider(
    vendor: string,
    provider: unknown,
  ) {
    state.vendor = vendor;
    state.provider = provider;
    state.providers.set(vendor, provider);
    return {
      dispose: () => {
        state.providers.delete(vendor);
      },
    };
  },
};
