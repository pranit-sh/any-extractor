import type { Block, Section, SectionKind } from '../types';

/**
 * Construct a {@link Section} with empty derived fields. The extractor
 * populates `markdown` and `tree` after parsing, so parsers don't need to
 * import the renderer or the tree helper.
 */
export function makeSection(
  kind: SectionKind,
  blocks: Block[],
  extra: { label?: string; index?: number; sectionPath?: string[] } = {},
): Section {
  const section: Section = { kind, blocks, markdown: '', tree: [] };
  if (extra.label !== undefined) section.label = extra.label;
  if (extra.index !== undefined) section.index = extra.index;
  if (extra.sectionPath && extra.sectionPath.length) section.sectionPath = [...extra.sectionPath];
  return section;
}
