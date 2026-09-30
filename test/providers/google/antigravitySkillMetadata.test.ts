import path from 'path';

import { describe, expect, it } from 'vitest';
import {
  buildAntigravitySkillMetadata,
  extractSkillFromPath,
  getAntigravitySkillMetadataFields,
  getAntigravitySkillRootPrefixes,
} from '../../../src/providers/google/antigravitySkillMetadata';

describe('antigravitySkillMetadata', () => {
  describe('getAntigravitySkillRootPrefixes', () => {
    it('includes .agents/skills and .gemini/skills for workingDir, custom skillsPaths, and homeDir', () => {
      const workingDir = path.resolve('/workspace/project');
      const prefixes = getAntigravitySkillRootPrefixes({
        workingDir,
        skillsPaths: ['./skills-v1', '/opt/shared-skills/'],
        homeDir: '/home/user/',
      });

      const normalizedWorkingDir = workingDir.replace(/\\/g, '/');
      expect(prefixes).toContain(`${normalizedWorkingDir}/.agents/skills`);
      expect(prefixes).toContain(`${normalizedWorkingDir}/.gemini/skills`);
      expect(prefixes).toContain(`${normalizedWorkingDir}/skills-v1`);
      expect(prefixes).toContain('/opt/shared-skills');
      expect(prefixes).toContain('/home/user/.gemini/antigravity/skills');
    });

    it('normalizes backslashes and deduplicates prefixes', () => {
      const prefixes = getAntigravitySkillRootPrefixes({
        skillsPaths: ['/custom/skills/', '/custom\\skills\\\\'],
      });
      expect(prefixes).toEqual(['/custom/skills']);
    });
  });

  describe('extractSkillFromPath', () => {
    it('extracts skills from .agents/skills and .gemini/skills paths', () => {
      expect(
        extractSkillFromPath('/workspace/.agents/skills/bigquery-cost-check/SKILL.md'),
      ).toEqual({
        name: 'bigquery-cost-check',
        path: '/workspace/.agents/skills/bigquery-cost-check/SKILL.md',
      });

      expect(extractSkillFromPath('/workspace/.gemini/skills/sql-review/SKILL.md')).toEqual({
        name: 'sql-review',
        path: '/workspace/.gemini/skills/sql-review/SKILL.md',
      });
    });

    it('extracts skills from custom skills_paths directories', () => {
      const prefixes = ['/workspace/skills-v1', '/workspace/direct-skill/my-single-skill'];

      expect(
        extractSkillFromPath('/workspace/skills-v1/bigquery-cost-check/SKILL.md', prefixes),
      ).toEqual({
        name: 'bigquery-cost-check',
        path: '/workspace/skills-v1/bigquery-cost-check/SKILL.md',
      });

      expect(
        extractSkillFromPath('/workspace/direct-skill/my-single-skill/SKILL.md', prefixes),
      ).toEqual({
        name: 'my-single-skill',
        path: '/workspace/direct-skill/my-single-skill/SKILL.md',
      });
    });

    it('ignores non-SKILL.md files and paths outside configured prefixes', () => {
      expect(
        extractSkillFromPath('/workspace/README.md', ['/workspace/skills-v1']),
      ).toBeUndefined();
      expect(
        extractSkillFromPath('/unrelated/dir/some-skill/SKILL.md', ['/workspace/skills-v1']),
      ).toBeUndefined();
    });
  });

  describe('buildAntigravitySkillMetadata', () => {
    it('detects view_file reading .agents/skills/<skill>/SKILL.md', () => {
      const metadata = buildAntigravitySkillMetadata([
        {
          id: 'call-1',
          name: 'view_file',
          args: {
            AbsolutePath: '/workspace/.agents/skills/bigquery-cost-check/SKILL.md',
          },
          status: 'DONE',
        },
      ]);

      expect(metadata).toEqual({
        skillCalls: [
          {
            name: 'bigquery-cost-check',
            path: '/workspace/.agents/skills/bigquery-cost-check/SKILL.md',
            source: 'tool',
          },
        ],
        attemptedSkillCalls: [
          {
            name: 'bigquery-cost-check',
            path: '/workspace/.agents/skills/bigquery-cost-check/SKILL.md',
            source: 'tool',
          },
        ],
      });
    });

    it('detects view_file reading .gemini/skills/<skill>/SKILL.md', () => {
      const metadata = buildAntigravitySkillMetadata([
        {
          id: 'call-2',
          name: 'view_file',
          args: {
            AbsolutePath: '/workspace/.gemini/skills/sql-review/SKILL.md',
          },
          status: 'DONE',
        },
      ]);

      expect(metadata?.skillCalls).toEqual([
        {
          name: 'sql-review',
          path: '/workspace/.gemini/skills/sql-review/SKILL.md',
          source: 'tool',
        },
      ]);
    });

    it('detects view_file reading a custom skills_paths directory', () => {
      const prefixes = ['/workspace/examples/skills-v1'];
      const metadata = buildAntigravitySkillMetadata(
        [
          {
            id: 'call-3',
            name: 'view_file',
            args: {
              AbsolutePath: '/workspace/examples/skills-v1/bigquery-cost-check/SKILL.md',
            },
            status: 'DONE',
          },
        ],
        prefixes,
      );

      expect(metadata?.skillCalls).toEqual([
        {
          name: 'bigquery-cost-check',
          path: '/workspace/examples/skills-v1/bigquery-cost-check/SKILL.md',
          source: 'tool',
        },
      ]);
    });

    it('detects run_command reading cat .agents/skills/my-skill/SKILL.md with heuristic source', () => {
      const metadata = buildAntigravitySkillMetadata([
        {
          id: 'call-4',
          name: 'run_command',
          args: {
            CommandLine: 'cat .agents/skills/my-skill/SKILL.md',
          },
          status: 'DONE',
        },
      ]);

      expect(metadata?.skillCalls).toEqual([
        {
          name: 'my-skill',
          path: '.agents/skills/my-skill/SKILL.md',
          source: 'heuristic',
        },
      ]);
    });

    it('populates attemptedSkillCalls but NOT skillCalls when view_file fails', () => {
      const metadata = buildAntigravitySkillMetadata([
        {
          id: 'call-5',
          name: 'view_file',
          args: {
            AbsolutePath: '/workspace/.agents/skills/missing-skill/SKILL.md',
          },
          status: 'ERROR',
          isError: true,
        },
      ]);

      expect(metadata).toBeDefined();
      expect(metadata?.skillCalls).toEqual([]);
      expect(metadata?.attemptedSkillCalls).toEqual([
        {
          name: 'missing-skill',
          path: '/workspace/.agents/skills/missing-skill/SKILL.md',
          source: 'tool',
          is_error: true,
        },
      ]);

      const fields = getAntigravitySkillMetadataFields(metadata);
      expect(fields.skillCalls).toBeUndefined();
      expect(fields.attemptedSkillCalls).toHaveLength(1);
    });
  });
});
