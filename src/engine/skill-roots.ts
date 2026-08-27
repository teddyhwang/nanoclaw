/**
 * External skill roots and context-fragment providers.
 *
 * Hosts that ship skill trees outside NanoClaw's built-in container payload
 * register them here. Container setup mounts/discovers those skills, while the
 * flat project-document composer inlines each selected `instructions.md` plus
 * async context fragments through the same registry.
 */
import type { AgentGroup } from '../types.js';

export interface ExtraSkillRoot {
  /** Absolute host path containing skill folders (each with optional `instructions.md`). */
  hostPath: string;
  /** Container path the host mounts this directory at, RO. */
  containerPath: string;
  /**
   * When provided, only skills for which the filter returns true are
   * activated. `group` is the target agent group at compose/sync time;
   * pass `null` if the caller doesn't have a group (e.g. unit tests).
   * Filters that only need the skill name can ignore `group`.
   */
  skillFilter?: (skillName: string, group: AgentGroup | null) => boolean;
}

export type ContextFragmentProvider = (group: AgentGroup) => Promise<{ name: string; content: string }[]>;

const skillRoots: ExtraSkillRoot[] = [];
const fragmentProviders: ContextFragmentProvider[] = [];

export function addSkillRoot(root: ExtraSkillRoot): () => void {
  skillRoots.push(root);
  return () => {
    const i = skillRoots.indexOf(root);
    if (i >= 0) skillRoots.splice(i, 1);
  };
}

export function getExtraSkillRoots(): ReadonlyArray<ExtraSkillRoot> {
  return skillRoots;
}

export function addContextFragmentProvider(fn: ContextFragmentProvider): () => void {
  fragmentProviders.push(fn);
  return () => {
    const i = fragmentProviders.indexOf(fn);
    if (i >= 0) fragmentProviders.splice(i, 1);
  };
}

export async function getContextFragments(group: AgentGroup): Promise<{ name: string; content: string }[]> {
  const out: { name: string; content: string }[] = [];
  for (const fn of fragmentProviders) {
    out.push(...(await fn(group)));
  }
  return out;
}

/** Test-only. */
export function _resetSkillRootsForTests(): void {
  skillRoots.length = 0;
  fragmentProviders.length = 0;
}
