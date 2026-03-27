/**
 * Minimal type stubs for the OpenClaw Plugin SDK.
 * These types are resolved at runtime inside the OpenClaw container.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  interface PluginLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  interface ToolResultContent {
    type: string;
    text: string;
  }

  interface AgentToolResult {
    content: ToolResultContent[];
    details?: unknown;
  }

  interface AgentTool {
    name: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>): Promise<AgentToolResult>;
  }

  interface OpenClawPluginApi {
    id: string;
    name: string;
    pluginConfig: unknown;
    logger: PluginLogger;
    registerTool(tool: AgentTool, opts?: { optional?: boolean }): void;
    on(event: "before_prompt_build", handler: () => {
      appendSystemContext?: string;
      prependSystemContext?: string;
    } | void): void;
  }

  interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    register: (api: OpenClawPluginApi) => void;
  }

  export function definePluginEntry(options: DefinePluginEntryOptions): unknown;
}
