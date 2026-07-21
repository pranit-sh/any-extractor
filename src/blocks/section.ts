import type { Block, Section, SectionKind } from '../types';

/**
 * Construct a {@link Section}. `blocks` is the single source of truth;
 * markdown is derived on demand via `toMarkdown` (or the lazy
 * `result.markdown` getter), never stored on the section itself.
 */
export function makeSection(
  kind: SectionKind,
  blocks: Block[],
  extra: { label?: string; index?: number } = {},
): Section {
  const section: Section = { kind, blocks };
  if (extra.label !== undefined) section.label = extra.label;
  if (extra.index !== undefined) section.index = extra.index;
  return section;
}
