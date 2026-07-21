import type { Block, Section, SectionKind } from '../types';

/**
 * Construct a {@link Section}. The extractor populates `markdown` after
 * parsing, so parsers don't need to import the renderer.
 */
export function makeSection(
  kind: SectionKind,
  blocks: Block[],
  extra: { label?: string; index?: number } = {},
): Section {
  const section: Section = { kind, blocks, markdown: '' };
  if (extra.label !== undefined) section.label = extra.label;
  if (extra.index !== undefined) section.index = extra.index;
  return section;
}
