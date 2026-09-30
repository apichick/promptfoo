import { execFile } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import cliState from '../../cliState';
import { getEnvString, getProcessEnv } from '../../envars';
import { getDirectory } from '../../esm';
import logger from '../../logger';
import { getConfiguredPythonPath, validatePythonPath } from '../../python/pythonUtils';
import { renderVarsInObject } from '../../util/render';
import {
  createSecureTempDirectory,
  removeSecureTempDirectory,
  writeSecureTempFile,
} from '../../util/secureTempFiles';
import {
  cacheResponse,
  getCachedResponse,
  initializeAgenticCache,
  resolveAgenticWorkingDir,
} from '../agentic-utils';
import { assertIsolatedWorkingDir, clearRepositoryEnv } from '../agentWorkspace';
import {
  type AntigravityRawToolCall,
  buildAntigravitySkillMetadata,
  getAntigravitySkillMetadataFields,
  getAntigravitySkillRootPrefixes,
} from './antigravitySkillMetadata';

import type {
  ApiProvider,
  CallApiContextParams,
  CallApiOptionsParams,
  EnvOverrides,
  ProviderOptions,
  ProviderResponse,
  TokenUsage,
} from '../../types/index';

const execFileAsync = promisify(execFile);

export type AntigravitySandboxMode = 'read-only' | 'workspace-write' | 'full-access';

export interface AntigravityBridgePayload {
  prompt: string;
  model?: string | null;
  workspaces: string[];
  skills_paths: string[];
  sandbox_mode: AntigravitySandboxMode;
  enabled_tools?: string[] | null;
  disabled_tools?: string[] | null;
  response_schema?: Record<string, unknown> | null;
  system_instructions?: string | null;
  app_data_dir?: string | null;
  save_dir?: string | null;
  conversation_id?: string | null;
  session_continuation_mode?: string | null;
  api_key?: string | null;
  vertex?: boolean | null;
  project?: string | null;
  location?: string | null;
  env?: Record<string, string> | null;
}

export interface AntigravityBridgeUsage {
  prompt_token_count?: number;
  candidates_token_count?: number;
  total_token_count?: number;
}

export interface AntigravityBridgeResult {
  output?: unknown;
  text?: string;
  structuredOutput?: unknown;
  conversationId?: string | null;
  numSteps?: number;
  toolCalls?: AntigravityRawToolCall[];
  usage?: AntigravityBridgeUsage | null;
  error?: string;
  errorType?: string;
  details?: string;
}

export type AntigravityBridgeRunner = (
  payload: AntigravityBridgePayload,
  options?: { pythonExecutable?: string; abortSignal?: AbortSignal },
) => Promise<AntigravityBridgeResult>;

export interface AntigravitySDKConfig {
  basePath?: string;
  model?: string;
  working_dir?: string;
  copy_working_dir?: boolean | 'auto' | 'git' | 'copy';
  workspaces?: string[];
  skills_paths?: string[];
  sandbox_mode?: AntigravitySandboxMode;
  enabled_tools?: string[];
  disabled_tools?: string[];
  output_schema?: Record<string, unknown>;
  response_schema?: Record<string, unknown>;
  system_instructions?: string;
  isolate_app_data?: boolean;
  app_data_dir?: string;
  save_dir?: string;
  conversation_id?: string;
  session_continuation_mode?: string;
  apiKey?: string;
  api_key?: string;
  vertex?: boolean;
  project?: string;
  location?: string;
  pythonExecutable?: string;
  env?: Record<string, string>;
  mcp?: unknown;
  cache_mcp?: boolean;
  bridgeRunner?: AntigravityBridgeRunner;
}

const FALLBACK_BRIDGE_SCRIPT = `#!/usr/bin/env python3
from __future__ import annotations
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

def _write_output(output_path: str, data: dict[str, Any]) -> None:
    Path(output_path).write_text(json.dumps(data), encoding="utf-8")

def _resolve_tool(tool_name: str, builtin_tools_cls: Any) -> Any:
    try:
        return builtin_tools_cls(tool_name)
    except Exception:
        try:
            return getattr(builtin_tools_cls, tool_name.upper())
        except Exception:
            return tool_name

def _serialize_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if hasattr(value, "model_dump"):
        return _serialize_value(value.model_dump())
    if hasattr(value, "to_dict"):
        return _serialize_value(value.to_dict())
    if hasattr(value, "__dict__"):
        return _serialize_value(vars(value))
    return str(value)

async def _run_agent(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
        from google.antigravity.hooks import policy
        from google.antigravity.types import BuiltinTools
    except ImportError as exc:
        return {
            "error": "google-antigravity package is not installed. Install it with: pip install google-antigravity",
            "errorType": "ImportError",
            "details": str(exc),
        }

    env_overrides = payload.get("env")
    if isinstance(env_overrides, dict):
        for key, val in env_overrides.items():
            if val is not None:
                os.environ[str(key)] = str(val)

    prompt = str(payload.get("prompt") or "")
    sandbox_mode = payload.get("sandbox_mode") or "read-only"
    raw_enabled_tools = payload.get("enabled_tools")
    raw_disabled_tools = payload.get("disabled_tools")

    enabled_tools: Any = None
    disabled_tools: list[Any] = []
    policies: list[Any] = []

    if isinstance(raw_enabled_tools, list):
        enabled_tools = [_resolve_tool(str(t), BuiltinTools) for t in raw_enabled_tools]
    elif sandbox_mode == "read-only":
        enabled_tools = BuiltinTools.read_only()

    if isinstance(raw_disabled_tools, list):
        disabled_tools.extend(_resolve_tool(str(t), BuiltinTools) for t in raw_disabled_tools)

    if sandbox_mode == "workspace-write":
        run_cmd_tool = getattr(BuiltinTools, "RUN_COMMAND", "run_command")
        if run_cmd_tool not in disabled_tools:
            disabled_tools.append(run_cmd_tool)
    elif sandbox_mode == "full-access":
        policies.append(policy.allow_all())

    capabilities_kwargs: dict[str, Any] = {}
    if enabled_tools is not None:
        capabilities_kwargs["enabled_tools"] = enabled_tools
    if disabled_tools:
        capabilities_kwargs["disabled_tools"] = disabled_tools

    capabilities = CapabilitiesConfig(**capabilities_kwargs)

    config_kwargs: dict[str, Any] = {
        "capabilities": capabilities,
        "workspaces": [Path(w) for w in (payload.get("workspaces") or []) if w],
        "skills_paths": [Path(p) for p in (payload.get("skills_paths") or []) if p],
    }

    if policies:
        config_kwargs["policies"] = policies

    for optional_key in (
        "model",
        "response_schema",
        "system_instructions",
        "conversation_id",
        "session_continuation_mode",
        "api_key",
        "vertex",
        "project",
        "location",
    ):
        val = payload.get(optional_key)
        if val is not None:
            config_kwargs[optional_key] = val

    for path_key in ("app_data_dir", "save_dir"):
        val = payload.get(path_key)
        if val:
            config_kwargs[path_key] = Path(val)

    config = LocalAgentConfig(**config_kwargs)

    async with Agent(config=config) as agent:
        response = await agent.chat(prompt)
        text = await response.text()
        structured_output = agent.conversation.get_last_structured_output()
        history = list(agent.conversation.history or [])
        usage = agent.conversation.last_turn_usage
        conv_id = getattr(agent.conversation, "id", None)

    tool_calls: list[dict[str, Any]] = []
    for step in history:
        step_status_raw = getattr(step, "status", None)
        step_status = (
            getattr(step_status_raw, "name", None)
            or getattr(step_status_raw, "value", None)
            or (str(step_status_raw) if step_status_raw is not None else None)
        )
        step_is_error = bool(
            step_status and ("ERROR" in str(step_status).upper() or "FAIL" in str(step_status).upper())
        )
        raw_calls = getattr(step, "tool_calls", None) or []
        for call in raw_calls:
            call_id = getattr(call, "id", None)
            call_name = getattr(call, "name", None) or ""
            call_args = _serialize_value(getattr(call, "args", None) or {})
            tool_calls.append(
                {
                    "id": str(call_id) if call_id is not None else None,
                    "name": str(call_name),
                    "args": call_args if isinstance(call_args, dict) else {},
                    "status": str(step_status) if step_status is not None else None,
                    "isError": step_is_error,
                }
            )

    usage_dict: dict[str, int] | None = None
    if usage is not None:
        prompt_tokens = getattr(usage, "prompt_token_count", None)
        completion_tokens = getattr(usage, "candidates_token_count", None)
        total_tokens = getattr(usage, "total_token_count", None)
        usage_dict = {
            "prompt_token_count": int(prompt_tokens or 0),
            "candidates_token_count": int(completion_tokens or 0),
            "total_token_count": int(
                total_tokens
                if total_tokens is not None
                else (int(prompt_tokens or 0) + int(completion_tokens or 0))
            ),
        }

    serialized_structured = _serialize_value(structured_output)
    final_output = serialized_structured if serialized_structured is not None else text

    return {
        "output": final_output,
        "text": text,
        "structuredOutput": serialized_structured,
        "conversationId": str(conv_id) if conv_id is not None else None,
        "numSteps": len(history),
        "toolCalls": tool_calls,
        "usage": usage_dict,
    }

def main() -> int:
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    try:
        payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
        result = asyncio.run(_run_agent(payload))
        _write_output(output_path, result)
    except Exception as exc:
        _write_output(output_path, {"error": str(exc), "errorType": type(exc).__name__})
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

function resolveBridgeScriptPath(): string | undefined {
  const baseDir = getDirectory();
  const candidates = [
    path.join(baseDir, 'antigravity_bridge.py'),
    path.join(baseDir, 'providers', 'google', 'antigravity_bridge.py'),
    path.resolve(baseDir, '../src/providers/google/antigravity_bridge.py'),
    path.resolve(baseDir, '../../src/providers/google/antigravity_bridge.py'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function runDefaultAntigravityBridge(
  payload: AntigravityBridgePayload,
  options: { pythonExecutable?: string; abortSignal?: AbortSignal } = {},
): Promise<AntigravityBridgeResult> {
  const customPath = getConfiguredPythonPath(options.pythonExecutable);
  const pythonPath = await validatePythonPath(
    customPath || 'python',
    typeof customPath === 'string',
  );

  const tempDir = await createSecureTempDirectory('promptfoo-antigravity-bridge-');
  try {
    const inputPath = await writeSecureTempFile(tempDir, 'input.json', JSON.stringify(payload));
    const outputPath = await writeSecureTempFile(tempDir, 'output.json', '');

    let scriptPath = resolveBridgeScriptPath();
    if (!scriptPath) {
      scriptPath = await writeSecureTempFile(
        tempDir,
        'antigravity_bridge.py',
        FALLBACK_BRIDGE_SCRIPT,
      );
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...getProcessEnv(),
      ...(payload.env ?? {}),
    };

    await execFileAsync(pythonPath, [scriptPath, inputPath, outputPath], {
      env: childEnv,
      signal: options.abortSignal,
      maxBuffer: 32 * 1024 * 1024,
    });

    const rawOutput = await fsPromises.readFile(outputPath, 'utf-8');
    if (!rawOutput.trim()) {
      return {
        error: 'Antigravity Python bridge produced empty output',
      };
    }

    return JSON.parse(rawOutput) as AntigravityBridgeResult;
  } finally {
    await removeSecureTempDirectory(tempDir);
  }
}

function buildTokenUsage(usage: AntigravityBridgeUsage | null | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = usage.prompt_token_count ?? 0;
  const completionTokens = usage.candidates_token_count ?? 0;
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: usage.total_token_count ?? promptTokens + completionTokens,
    numRequests: 1,
  };
}

function formatBridgeOutput(result: AntigravityBridgeResult): string {
  const rawOutput =
    result.structuredOutput !== undefined && result.structuredOutput !== null
      ? result.structuredOutput
      : (result.output ?? result.text ?? '');
  return typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
}

function resolveBasePath(configBasePath?: string): string {
  if (configBasePath) {
    return path.resolve(configBasePath);
  }
  if (cliState.basePath) {
    return path.resolve(cliState.basePath);
  }
  return process.cwd();
}

function buildChildEnv(
  configEnv: Record<string, string> | undefined,
  inIsolatedWorkspace: boolean,
): Record<string, string> | null {
  const childEnv: Record<string, string> = {};
  if (configEnv) {
    for (const [k, v] of Object.entries(configEnv)) {
      if (v !== undefined) {
        childEnv[k] = String(v);
      }
    }
  }
  if (inIsolatedWorkspace) {
    clearRepositoryEnv(childEnv);
  }
  return Object.keys(childEnv).length > 0 ? childEnv : null;
}

export class AntigravitySDKProvider implements ApiProvider {
  modelName: string;
  config: AntigravitySDKConfig;
  env?: EnvOverrides;

  private providerId: string;
  private bridgeRunner?: AntigravityBridgeRunner;

  constructor(
    modelName: string = '',
    options: ProviderOptions & { bridgeRunner?: AntigravityBridgeRunner } = {},
  ) {
    const config = (options.config ?? {}) as AntigravitySDKConfig;
    this.modelName = modelName || config.model || '';
    this.config = config;
    this.env = options.env;
    this.bridgeRunner = options.bridgeRunner ?? config.bridgeRunner;
    this.providerId =
      options.id ||
      (this.modelName ? `google:antigravity-sdk:${this.modelName}` : 'google:antigravity-sdk');
  }

  id(): string {
    return this.providerId;
  }

  toString(): string {
    return `[Google Antigravity SDK Provider ${this.modelName || 'default'}]`;
  }

  getApiKey(config: AntigravitySDKConfig = this.config): string | undefined {
    const envRecord = this.env as Record<string, string | undefined> | undefined;
    return (
      config.apiKey ||
      config.api_key ||
      envRecord?.GEMINI_API_KEY ||
      envRecord?.GOOGLE_API_KEY ||
      getEnvString('GEMINI_API_KEY') ||
      getEnvString('GOOGLE_API_KEY') ||
      undefined
    );
  }

  private resolveSkillPaths(
    explicitSkillPaths: readonly string[] | undefined,
    workingDir: string,
    basePath: string,
  ): string[] {
    const resolved = new Set<string>();

    for (const rawPath of explicitSkillPaths ?? []) {
      if (!rawPath || typeof rawPath !== 'string') {
        continue;
      }
      const trimmed = rawPath.trim();
      if (!trimmed) {
        continue;
      }
      if (path.isAbsolute(trimmed)) {
        resolved.add(path.resolve(trimmed));
        continue;
      }
      const inWorkingDir = path.resolve(workingDir, trimmed);
      const inBasePath = path.resolve(basePath, trimmed);
      resolved.add(fs.existsSync(inWorkingDir) ? inWorkingDir : inBasePath);
    }

    const autoSkillDirs = [
      path.join(workingDir, '.agents', 'skills'),
      path.join(workingDir, '.gemini', 'skills'),
    ];
    for (const candidateDir of autoSkillDirs) {
      try {
        if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
          resolved.add(path.resolve(candidateDir));
        }
      } catch {
        // Ignore inaccessible skill directory candidates
      }
    }

    return Array.from(resolved);
  }

  private async prepareWorkingDirectory(
    config: AntigravitySDKConfig,
    basePath: string,
  ): Promise<
    | { workingDir: string; inIsolatedWorkspace: boolean; ephemeralWorkingDir?: string }
    | { error: string }
  > {
    if (!config.working_dir) {
      const ephemeralWorkingDir = await createSecureTempDirectory('promptfoo-antigravity-workdir-');
      return { workingDir: ephemeralWorkingDir, inIsolatedWorkspace: false, ephemeralWorkingDir };
    }

    const workingDir = resolveAgenticWorkingDir(config.working_dir, basePath)!;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(workingDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: `Working directory ${workingDir} does not exist or isn't accessible: ${msg}`,
      };
    }
    if (!stats.isDirectory()) {
      return {
        error: `Working directory ${workingDir} is not a directory`,
      };
    }

    const inIsolatedWorkspace = assertIsolatedWorkingDir({
      ...config,
      working_dir: workingDir,
    });
    return { workingDir, inIsolatedWorkspace };
  }

  private async prepareAppDataDirs(
    config: AntigravitySDKConfig,
    basePath: string,
    isolateAppData: boolean,
  ): Promise<{
    appDataDir?: string;
    saveDir?: string;
    ephemeralAppDataRoot?: string;
  }> {
    let appDataDir = config.app_data_dir
      ? resolveAgenticWorkingDir(config.app_data_dir, basePath)
      : undefined;
    let saveDir = config.save_dir ? resolveAgenticWorkingDir(config.save_dir, basePath) : undefined;
    let ephemeralAppDataRoot: string | undefined;

    if (isolateAppData && (!appDataDir || !saveDir)) {
      ephemeralAppDataRoot = await createSecureTempDirectory('promptfoo-antigravity-appdata-');
      if (!appDataDir) {
        appDataDir = path.join(ephemeralAppDataRoot, 'app_data');
        await fsPromises.mkdir(appDataDir, { recursive: true });
      }
      if (!saveDir) {
        saveDir = path.join(ephemeralAppDataRoot, 'save');
        await fsPromises.mkdir(saveDir, { recursive: true });
      }
    }

    return { appDataDir, saveDir, ephemeralAppDataRoot };
  }

  private buildProviderResponse(
    result: AntigravityBridgeResult,
    workingDir: string,
    resolvedSkillsPaths: string[],
    isolateAppData: boolean,
  ): ProviderResponse {
    const skillRootPrefixes = getAntigravitySkillRootPrefixes({
      workingDir,
      skillsPaths: resolvedSkillsPaths,
      homeDir: isolateAppData ? undefined : process.env.HOME || process.env.USERPROFILE,
    });
    const skillMetadata = buildAntigravitySkillMetadata(result.toolCalls, skillRootPrefixes);
    const tokenUsage = buildTokenUsage(result.usage);
    const output = formatBridgeOutput(result);

    return {
      output,
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(result.conversationId ? { sessionId: result.conversationId } : {}),
      metadata: {
        ...(result.conversationId ? { conversationId: result.conversationId } : {}),
        ...(typeof result.numSteps === 'number' ? { numSteps: result.numSteps } : {}),
        ...(Array.isArray(result.toolCalls) ? { toolCalls: result.toolCalls } : {}),
        ...getAntigravitySkillMetadataFields(skillMetadata),
      },
      raw: result,
    };
  }

  private buildCacheKeyData(
    prompt: string,
    config: AntigravitySDKConfig,
    effectiveModel: string | undefined,
    sandboxMode: AntigravitySandboxMode,
    responseSchema: Record<string, unknown> | undefined,
    resolvedSkillsPaths: string[],
    resolvedWorkspaces: string[],
    isolateAppData: boolean,
  ): Record<string, unknown> {
    // Never include API keys or secret tokens in the cache key
    return {
      prompt,
      model: effectiveModel ?? null,
      sandbox_mode: sandboxMode,
      enabled_tools: config.enabled_tools ? [...config.enabled_tools].sort() : null,
      disabled_tools: config.disabled_tools ? [...config.disabled_tools].sort() : null,
      response_schema: responseSchema ?? null,
      system_instructions: config.system_instructions ?? null,
      skills_paths: [...resolvedSkillsPaths].sort(),
      workspaces: config.working_dir ? [...resolvedWorkspaces].sort() : [],
      isolate_app_data: isolateAppData,
      vertex: config.vertex ?? null,
      project: config.project ?? null,
      location: config.location ?? null,
    };
  }

  private buildBridgePayload(params: {
    prompt: string;
    config: AntigravitySDKConfig;
    effectiveModel: string | undefined;
    sandboxMode: AntigravitySandboxMode;
    responseSchema: Record<string, unknown> | undefined;
    resolvedWorkspaces: string[];
    resolvedSkillsPaths: string[];
    appDataDir: string | undefined;
    saveDir: string | undefined;
    inIsolatedWorkspace: boolean;
  }): AntigravityBridgePayload {
    const { config } = params;
    return {
      prompt: params.prompt,
      model: params.effectiveModel ?? null,
      workspaces: params.resolvedWorkspaces,
      skills_paths: params.resolvedSkillsPaths,
      sandbox_mode: params.sandboxMode,
      enabled_tools: config.enabled_tools ?? null,
      disabled_tools: config.disabled_tools ?? null,
      response_schema: params.responseSchema ?? null,
      system_instructions: config.system_instructions ?? null,
      app_data_dir: params.appDataDir ?? null,
      save_dir: params.saveDir ?? null,
      conversation_id: config.conversation_id ?? null,
      session_continuation_mode: config.session_continuation_mode ?? null,
      api_key: this.getApiKey(config) ?? null,
      vertex: config.vertex ?? null,
      project: config.project ?? null,
      location: config.location ?? null,
      env: buildChildEnv(config.env, params.inIsolatedWorkspace),
    };
  }

  private async cleanupTempDirs(
    ephemeralAppDataRoot?: string,
    ephemeralWorkingDir?: string,
  ): Promise<void> {
    if (ephemeralAppDataRoot) {
      await removeSecureTempDirectory(ephemeralAppDataRoot).catch((err) => {
        logger.debug('[AntigravitySDK] Failed to remove ephemeral app data directory', {
          error: String(err),
        });
      });
    }
    if (ephemeralWorkingDir) {
      await removeSecureTempDirectory(ephemeralWorkingDir).catch((err) => {
        logger.debug('[AntigravitySDK] Failed to remove ephemeral working directory', {
          error: String(err),
        });
      });
    }
  }

  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    options?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    if (options?.abortSignal?.aborted) {
      return { error: 'Google Antigravity SDK call aborted before it started' };
    }

    const mergedConfig: AntigravitySDKConfig = {
      ...this.config,
      ...context?.prompt?.config,
    };
    delete (mergedConfig as Record<string, unknown>).provider;
    const activeBridgeRunner =
      mergedConfig.bridgeRunner ?? this.bridgeRunner ?? runDefaultAntigravityBridge;
    delete mergedConfig.bridgeRunner;

    const config = renderVarsInObject(mergedConfig, context?.vars) as AntigravitySDKConfig;
    const basePath = resolveBasePath(config.basePath);

    let ephemeralWorkingDir: string | undefined;
    let ephemeralAppDataRoot: string | undefined;

    try {
      const workDirResult = await this.prepareWorkingDirectory(config, basePath);
      if ('error' in workDirResult) {
        return { error: workDirResult.error };
      }

      const { workingDir, inIsolatedWorkspace } = workDirResult;
      ephemeralWorkingDir = workDirResult.ephemeralWorkingDir;

      const resolvedSkillsPaths = this.resolveSkillPaths(config.skills_paths, workingDir, basePath);
      const resolvedWorkspaces = Array.from(
        new Set([
          workingDir,
          ...(config.workspaces ?? []).map(
            (ws) => resolveAgenticWorkingDir(ws, basePath) ?? path.resolve(basePath, ws),
          ),
        ]),
      );

      const sandboxMode: AntigravitySandboxMode = config.sandbox_mode ?? 'read-only';
      const responseSchema = config.output_schema ?? config.response_schema;
      const effectiveModel = config.model || this.modelName || undefined;
      const isolateAppData = config.isolate_app_data !== false;

      const cacheKeyData = this.buildCacheKeyData(
        prompt,
        config,
        effectiveModel,
        sandboxMode,
        responseSchema,
        resolvedSkillsPaths,
        resolvedWorkspaces,
        isolateAppData,
      );

      const shouldBypassCache =
        inIsolatedWorkspace || Boolean(config.conversation_id) || Boolean(config.app_data_dir);

      const cacheResult = shouldBypassCache
        ? { shouldCache: false, shouldReadCache: false, shouldWriteCache: false }
        : await initializeAgenticCache(
            {
              cacheKeyPrefix: 'google:antigravity-sdk',
              workingDir: config.working_dir ? workingDir : undefined,
              bustCache: context?.bustCache,
              mcp: config.mcp,
              cacheMcp: config.cache_mcp,
            },
            cacheKeyData,
          );

      const cached = await getCachedResponse(cacheResult, prompt.slice(0, 50));
      if (cached) {
        return cached;
      }

      const appDataPrep = await this.prepareAppDataDirs(config, basePath, isolateAppData);
      ephemeralAppDataRoot = appDataPrep.ephemeralAppDataRoot;

      const payload = this.buildBridgePayload({
        prompt,
        config,
        effectiveModel,
        sandboxMode,
        responseSchema,
        resolvedWorkspaces,
        resolvedSkillsPaths,
        appDataDir: appDataPrep.appDataDir,
        saveDir: appDataPrep.saveDir,
        inIsolatedWorkspace,
      });

      const result = await activeBridgeRunner(payload, {
        pythonExecutable: config.pythonExecutable,
        abortSignal: options?.abortSignal,
      });

      if (result.error) {
        return { error: result.error };
      }

      const providerResponse = this.buildProviderResponse(
        result,
        workingDir,
        resolvedSkillsPaths,
        isolateAppData,
      );
      await cacheResponse(cacheResult, providerResponse, prompt.slice(0, 50));
      return providerResponse;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[AntigravitySDK] Error calling Google Antigravity SDK', { error: msg });
      return {
        error: `Error calling Google Antigravity SDK: ${msg}`,
      };
    } finally {
      await this.cleanupTempDirs(ephemeralAppDataRoot, ephemeralWorkingDir);
    }
  }
}
