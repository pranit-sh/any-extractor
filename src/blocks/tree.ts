import type { Block, HeadingBlock, SectionNode } from '../types';

/**
 * Fold a flat, in-order list of blocks into a heading-rooted tree.
 *
 * Every non-heading block becomes a leaf under the most recent heading of
 * shallower or equal level. Content that appears before any heading is
 * attached to a synthetic root node.
 *
 * The block order is preserved — you can always flatten the tree back to
 * the original list by concatenating `heading` (if any) with each node's
 * `blocks` and its children's flattenings.
 *
 * This is a pure helper — `Section.tree` on the extractor result is built
 * with exactly this function.
 */
export function buildTree(blocks: Block[]): SectionNode[] {
  const root: SectionNode = { level: 0, blocks: [], children: [] };
  const stack: SectionNode[] = [root];

  for (const block of blocks) {
    if (block.type === 'heading') {
      const h = block as HeadingBlock;
      // Pop until the top of the stack is a strictly shallower heading.
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      const node: SectionNode = {
        level: h.level,
        heading: h,
        title: h.text,
        blocks: [],
        children: [],
      };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      stack[stack.length - 1].blocks.push(block);
    }
  }

  // If there is no pre-heading content, return the top-level nodes directly.
  // Otherwise keep the synthetic root so callers don't lose that content.
  if (root.blocks.length === 0) return root.children;
  return [root];
}
