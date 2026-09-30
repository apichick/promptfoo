import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSkillUsed } from '../../../src/assertions/skill';
import { isCacheEnabled } from '../../../src/cache';
import { googleProviderFactories } from '../../../src/providers/families/google';
import {
  type AntigravityBridgePayload,
  AntigravitySDKProvider,
} from '../../../src/providers/google/antigravity-sdk';

import type { AssertionParams } from '../../../src/types/index';

vi.mock('../../../src/cache', () => ({
  isCacheEnabled: vi.fn(() => false),
  getCache: vi.fn(),
}));

describe('AntigravitySDKProvider', () => {
  const tempDirs: string[] = [];

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCacheEnabled).mockReturnValue(false);
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('provider registration via googleProviderFactories', () => {
    const factory = googleProviderFactories.find((f) => f.test('google:antigravity-sdk'))!;

    it('resolves google:antigravity-sdk with default model', async () => {
      const provider = await factory.create('google:antigravity-sdk', {}, {} as any);
      expect(provider).toBeInstanceOf(AntigravitySDKProvider);
      expect(provider.id()).toBe('google:antigravity-sdk');
    });

    it('resolves google:antigravity-sdk:<model> with explicit model', async () => {
      const provider = (await factory.create(
        'google:antigravity-sdk:gemini-2.5-pro',
        {},
        {} as any,
      )) as AntigravitySDKProvider;
      expect(provider).toBeInstanceOf(AntigravitySDKProvider);
      expect(provider.id()).toBe('google:antigravity-sdk:gemini-2.5-pro');
      expect(provider.modelName).toBe('gemini-2.5-pro');
    });

    it('resolves google:antigravity and google:antigravity:<model> aliases', async () => {
      const baseAlias = await factory.create('google:antigravity', {}, {} as any);
      expect(baseAlias).toBeInstanceOf(AntigravitySDKProvider);
      expect(baseAlias.id()).toBe('google:antigravity');

      const modelAlias = (await factory.create(
        'google:antigravity:gemini-2.5-flash',
        {},
        {} as any,
      )) as AntigravitySDKProvider;
      expect(modelAlias).toBeInstanceOf(AntigravitySDKProvider);
      expect(modelAlias.id()).toBe('google:antigravity:gemini-2.5-flash');
      expect(modelAlias.modelName).toBe('gemini-2.5-flash');
    });
  });

  describe('callApi', () => {
    it('uses read-only sandbox mode by default and creates/cleans up isolated app_data_dir', async () => {
      let capturedPayload: AntigravityBridgePayload | undefined;
      let appDataExistedDuringRun = false;
      let saveDirExistedDuringRun = false;

      const provider = new AntigravitySDKProvider('gemini-2.5-pro', {
        bridgeRunner: async (payload) => {
          capturedPayload = payload;
          if (payload.app_data_dir) {
            appDataExistedDuringRun = fs.existsSync(payload.app_data_dir);
          }
          if (payload.save_dir) {
            saveDirExistedDuringRun = fs.existsSync(payload.save_dir);
          }
          return {
            output: 'Completed read-only check.',
            text: 'Completed read-only check.',
            conversationId: 'conv-123',
            numSteps: 2,
            toolCalls: [],
            usage: {
              prompt_token_count: 120,
              candidates_token_count: 45,
              total_token_count: 165,
            },
          };
        },
      });

      const response = await provider.callApi('Inspect the workspace.');

      expect(response.error).toBeUndefined();
      expect(response.output).toBe('Completed read-only check.');
      expect(response.sessionId).toBe('conv-123');
      expect(response.tokenUsage).toEqual({
        prompt: 120,
        completion: 45,
        total: 165,
        numRequests: 1,
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.sandbox_mode).toBe('read-only');
      expect(capturedPayload?.model).toBe('gemini-2.5-pro');
      expect(appDataExistedDuringRun).toBe(true);
      expect(saveDirExistedDuringRun).toBe(true);

      // Ephemeral app_data_dir and save_dir should be removed after callApi finishes
      expect(fs.existsSync(capturedPayload!.app_data_dir!)).toBe(false);
      expect(fs.existsSync(capturedPayload!.save_dir!)).toBe(false);
    });

    it('auto-discovers .agents/skills in working_dir and populates metadata.skillCalls for skill-used assertions', async () => {
      const workspaceDir = makeTempDir('antigravity-workspace-');
      const skillDir = path.join(workspaceDir, '.agents', 'skills', 'bigquery-cost-check');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillFile, '---\nname: bigquery-cost-check\n---\nAlways use --dry_run.');

      let capturedPayload: AntigravityBridgePayload | undefined;

      const provider = new AntigravitySDKProvider('gemini-2.5-pro', {
        config: {
          working_dir: workspaceDir,
        },
        bridgeRunner: async (payload) => {
          capturedPayload = payload;
          return {
            output: 'Use bq query --dry_run before executing.',
            text: 'Use bq query --dry_run before executing.',
            conversationId: 'conv-skill-1',
            numSteps: 3,
            toolCalls: [
              {
                id: 'tc-1',
                name: 'view_file',
                args: {
                  AbsolutePath: skillFile,
                },
                status: 'DONE',
              },
            ],
            usage: {
              prompt_token_count: 200,
              candidates_token_count: 80,
              total_token_count: 280,
            },
          };
        },
      });

      const response = await provider.callApi('How do I check BigQuery query cost?');

      expect(capturedPayload?.skills_paths).toContain(path.join(workspaceDir, '.agents', 'skills'));
      expect(response.metadata?.skillCalls).toEqual([
        {
          name: 'bigquery-cost-check',
          path: skillFile.replace(/\\/g, '/'),
          source: 'tool',
        },
      ]);

      // Verify compatibility with Promptfoo's skill-used and not-skill-used assertions
      const skillUsedResult = handleSkillUsed({
        assertion: { type: 'skill-used', value: 'bigquery-cost-check' },
        providerResponse: response,
        inverse: false,
      } as unknown as AssertionParams);
      expect(skillUsedResult.pass).toBe(true);

      const notSkillUsedResult = handleSkillUsed({
        assertion: { type: 'not-skill-used', value: 'unrelated-skill' },
        providerResponse: response,
        inverse: true,
      } as unknown as AssertionParams);
      expect(notSkillUsedResult.pass).toBe(true);
    });

    it('forwards output_schema as response_schema and serializes structuredOutput', async () => {
      let capturedPayload: AntigravityBridgePayload | undefined;
      const schema = {
        type: 'object',
        required: ['summary', 'issues'],
        properties: {
          summary: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
        },
      };

      const provider = new AntigravitySDKProvider('gemini-2.5-pro', {
        config: {
          output_schema: schema,
        },
        bridgeRunner: async (payload) => {
          capturedPayload = payload;
          return {
            output: { summary: 'Found 1 issue', issues: ['missing-dry-run'] },
            structuredOutput: { summary: 'Found 1 issue', issues: ['missing-dry-run'] },
            text: '{"summary":"Found 1 issue","issues":["missing-dry-run"]}',
            conversationId: 'conv-structured',
            numSteps: 1,
            toolCalls: [],
          };
        },
      });

      const response = await provider.callApi('Review the SQL query.');

      expect(capturedPayload?.response_schema).toEqual(schema);
      expect(JSON.parse(response.output as string)).toEqual({
        summary: 'Found 1 issue',
        issues: ['missing-dry-run'],
      });
    });

    it('returns a clear error when google-antigravity is not installed', async () => {
      const provider = new AntigravitySDKProvider('gemini-2.5-pro', {
        bridgeRunner: async () => ({
          error:
            'google-antigravity package is not installed. Install it with: pip install google-antigravity',
          errorType: 'ImportError',
        }),
      });

      const response = await provider.callApi('Hello');

      expect(response.error).toContain('google-antigravity package is not installed');
    });
  });
});
