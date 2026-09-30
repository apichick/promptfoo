import path from 'path';

import type { SkillCallEntry } from '../../types/index';

export interface AntigravityRawToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  status?: string;
  isError?: boolean;
}

export interface AntigravitySkillMetadata {
  attemptedSkillCalls: SkillCallEntry[];
  skillCalls: SkillCallEntry[];
}

export interface AntigravitySkillRootOptions {
  workingDir?: string;
  skillsPaths?: string[];
  homeDir?: string;
}

function normalizePosixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isValidSkillName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && /^[A-Za-z0-9._:-]+$/.test(name);
}

function resolveSkillRootCandidate(rawSkillPath: string, workingDir?: string): string | undefined {
  const trimmed = rawSkillPath.trim();
  if (!trimmed) {
    return undefined;
  }
  const isAbsolute = path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
  if (isAbsolute) {
    return trimmed;
  }
  return workingDir ? path.resolve(workingDir, trimmed) : path.resolve(trimmed);
}

export function getAntigravitySkillRootPrefixes(
  options: AntigravitySkillRootOptions = {},
): string[] {
  const prefixes = new Set<string>();
  const addPrefix = (candidate?: string) => {
    if (!candidate) {
      return;
    }
    const normalized = normalizePosixPath(candidate);
    if (normalized) {
      prefixes.add(normalized);
    }
  };

  if (options.workingDir) {
    const resolvedWorkingDir = normalizePosixPath(path.resolve(options.workingDir));
    addPrefix(path.posix.join(resolvedWorkingDir, '.agents', 'skills'));
    addPrefix(path.posix.join(resolvedWorkingDir, '.gemini', 'skills'));
  }

  for (const rawSkillPath of options.skillsPaths ?? []) {
    if (typeof rawSkillPath === 'string') {
      addPrefix(resolveSkillRootCandidate(rawSkillPath, options.workingDir));
    }
  }

  if (options.homeDir) {
    const normalizedHome = normalizePosixPath(options.homeDir);
    if (normalizedHome) {
      addPrefix(path.posix.join(normalizedHome, '.gemini', 'antigravity', 'skills'));
    }
  }

  return Array.from(prefixes);
}

function matchSkillUnderPrefix(
  normalizedPath: string,
  rawPrefix: string,
): { name: string; path: string } | undefined {
  const prefix = normalizePosixPath(rawPrefix);
  if (!prefix) {
    return undefined;
  }

  if (normalizedPath === `${prefix}/SKILL.md`) {
    const skillName = path.posix.basename(prefix);
    return isValidSkillName(skillName) ? { name: skillName, path: normalizedPath } : undefined;
  }

  if (!normalizedPath.startsWith(`${prefix}/`)) {
    return undefined;
  }

  const remainder = normalizedPath.slice(prefix.length + 1);
  const customMatch = remainder.match(/^(?:skills\/)?([^/\s]+)\/SKILL\.md$/);
  if (customMatch && isValidSkillName(customMatch[1])) {
    return {
      name: customMatch[1],
      path: normalizedPath,
    };
  }

  return undefined;
}

export function extractSkillFromPath(
  filePath: string,
  skillRootPrefixes: readonly string[] = [],
): { name: string; path: string } | undefined {
  if (!filePath || typeof filePath !== 'string') {
    return undefined;
  }

  const normalizedPath = filePath.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return undefined;
  }

  const builtinMatch = normalizedPath.match(
    /(?:^|\/)\.(?:agents|gemini(?:\/antigravity)?)\/skills\/([^/\s]+)\/SKILL\.md$/,
  );
  if (builtinMatch && isValidSkillName(builtinMatch[1])) {
    return {
      name: builtinMatch[1],
      path: normalizedPath,
    };
  }

  for (const rawPrefix of skillRootPrefixes) {
    const matched = matchSkillUnderPrefix(normalizedPath, rawPrefix);
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

function extractCommandSkillCandidates(
  command: string,
  skillRootPrefixes: readonly string[],
): Array<{ name: string; path: string }> {
  const candidates: Array<{ name: string; path: string }> = [];
  const seenPaths = new Set<string>();

  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^[`"'([{<]+|[`"',;:)\]}>]+$/g, '').trim();
    if (!token) {
      continue;
    }
    const extracted = extractSkillFromPath(token, skillRootPrefixes);
    if (extracted && !seenPaths.has(extracted.path)) {
      seenPaths.add(extracted.path);
      candidates.push(extracted);
    }
  }

  return candidates;
}

function recordExtractedSkill(
  extracted: { name: string; path: string },
  source: 'tool' | 'heuristic',
  isFailed: boolean,
  skillCallsMap: Map<string, SkillCallEntry>,
  attemptedSkillCallsMap: Map<string, SkillCallEntry>,
): void {
  const entryKey = `${source}:${extracted.path}`;
  attemptedSkillCallsMap.set(entryKey, {
    name: extracted.name,
    path: extracted.path,
    source,
    ...(isFailed ? { is_error: true } : {}),
  });

  if (!isFailed) {
    skillCallsMap.set(entryKey, {
      name: extracted.name,
      path: extracted.path,
      source,
    });
  }
}

function extractToolCallSkills(
  call: AntigravityRawToolCall,
  skillRootPrefixes: readonly string[],
): { source: 'tool' | 'heuristic'; candidates: Array<{ name: string; path: string }> } | undefined {
  const args = call.args ?? {};

  if (call.name === 'view_file' || call.name === 'read_file') {
    const candidatePaths = [args.AbsolutePath, args.path, args.file_path, args.TargetFile].filter(
      (val): val is string => typeof val === 'string' && val.trim().length > 0,
    );
    const candidates = candidatePaths
      .map((p) => extractSkillFromPath(p, skillRootPrefixes))
      .filter((item): item is { name: string; path: string } => Boolean(item));
    return { source: 'tool', candidates };
  }

  if (call.name === 'run_command') {
    const command =
      typeof args.CommandLine === 'string'
        ? args.CommandLine
        : typeof args.command === 'string'
          ? args.command
          : undefined;
    if (!command) {
      return undefined;
    }
    return {
      source: 'heuristic',
      candidates: extractCommandSkillCandidates(command, skillRootPrefixes),
    };
  }

  return undefined;
}

export function buildAntigravitySkillMetadata(
  toolCalls: readonly AntigravityRawToolCall[] | undefined,
  skillRootPrefixes: readonly string[] = [],
): AntigravitySkillMetadata | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  const skillCallsMap = new Map<string, SkillCallEntry>();
  const attemptedSkillCallsMap = new Map<string, SkillCallEntry>();

  for (const call of toolCalls) {
    if (!call || typeof call.name !== 'string') {
      continue;
    }
    const isFailed = Boolean(call.isError) || call.status === 'ERROR';
    const extractedGroup = extractToolCallSkills(call, skillRootPrefixes);
    if (!extractedGroup) {
      continue;
    }

    for (const extracted of extractedGroup.candidates) {
      recordExtractedSkill(
        extracted,
        extractedGroup.source,
        isFailed,
        skillCallsMap,
        attemptedSkillCallsMap,
      );
    }
  }

  const skillCalls = Array.from(skillCallsMap.values());
  const attemptedSkillCalls = Array.from(attemptedSkillCallsMap.values());

  if (skillCalls.length === 0 && attemptedSkillCalls.length === 0) {
    return undefined;
  }

  return {
    attemptedSkillCalls,
    skillCalls,
  };
}

export function getAntigravitySkillMetadataFields(
  skillMetadata: AntigravitySkillMetadata | undefined,
): {
  attemptedSkillCalls?: SkillCallEntry[];
  skillCalls?: SkillCallEntry[];
} {
  if (!skillMetadata) {
    return {};
  }

  return {
    ...(skillMetadata.skillCalls.length > 0 ? { skillCalls: skillMetadata.skillCalls } : {}),
    ...(skillMetadata.attemptedSkillCalls.length > 0
      ? { attemptedSkillCalls: skillMetadata.attemptedSkillCalls }
      : {}),
  };
}
