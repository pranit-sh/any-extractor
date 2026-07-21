/**
 * MCP server for `any-extractor`.
 *
 * Exposes the core `extract()` pipeline over the Model Context Protocol
 * (stdio transport) so any MCP-capable client — Claude Desktop, Cursor,
 * VS Code, Continue, etc. — can turn a document into agent-ready
 * markdown / structured blocks with a single tool call.
 *
 * Tools:
 *   - `extract_document`            → compact markdown + metadata
 *   - `extract_document_structured` → full typed sections + blocks
 *   - `extract_section`             → one section by index (paging)
 *
 * The server runs over stdio and inherits the ambient authority of the
 * process that spawned it. That means every input source — HTTP(S)
 * URLs, local `path`s, and inline base64 `data` — is accepted with no
 * extra gating. Operators who need to sandbox filesystem access should
 * do it at the process level (containers, seccomp, launcher config).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AnyExtractor } from '../extractors/any-extractor';
import { toMarkdown, toText } from '../blocks';
import type { ExtractResult, Section } from '../types';
import { UnsupportedFileTypeError } from '../types';
import { isValidUrl } from '../util';

const DEFAULT_MAX_CHARS = 50_000;
const HARD_MAX_CHARS = 500_000;

const inputSchema = z
  .object({
    url: z
      .string()
      .describe('HTTP(S) or `file://` URL to fetch. Preferred over `path` when remote.')
      .optional(),
    path: z.string().describe('Local filesystem path.').optional(),
    data: z
      .string()
      .describe('Base64-encoded file bytes. Use for uploads or piped content.')
      .optional(),
    mimeHint: z
      .string()
      .describe('Optional MIME hint (currently informational only — detection is content-based).')
      .optional(),
  })
  .refine((v) => Boolean(v.url || v.path || v.data), {
    message: 'Provide exactly one of `url`, `path`, or `data`.',
  });

type ExtractInput = z.infer<typeof inputSchema>;

let extractorSingleton: AnyExtractor | undefined;
const getExtractor = (): AnyExtractor => {
  if (!extractorSingleton) extractorSingleton = new AnyExtractor();
  return extractorSingleton;
};

/**
 * Resolve tool input to a Buffer or a URL/path string the extractor can
 * open. Base64 wins if provided; then URL; then local path.
 */
async function resolveInput(input: ExtractInput): Promise<string | Buffer> {
  if (input.data) {
    try {
      return Buffer.from(input.data, 'base64');
    } catch {
      throw new Error('`data` is not valid base64.');
    }
  }
  if (input.url) {
    if (!isValidUrl(input.url)) throw new Error(`Not a valid URL: ${input.url}`);
    return input.url;
  }
  if (input.path) return input.path;
  throw new Error('Provide one of `url`, `path`, or `data`.');
}

function clampChars(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/**
 * Serialize an ExtractResult for the compact tool response — markdown
 * plus lightweight metadata, no raw blocks. Truncates on the char budget.
 */
function summarizeResult(
  result: ExtractResult,
  maxChars: number,
): {
  markdown: string;
  text: string;
  markdownTruncated: boolean;
  textTruncated: boolean;
  metadata: ExtractResult['metadata'];
  sectionCount: number;
  sections: Array<{ index: number; kind: Section['kind']; label?: string; blockCount: number }>;
} {
  const md = clampChars(result.markdown, maxChars);
  const tx = clampChars(result.text, maxChars);
  return {
    markdown: md.text,
    text: tx.text,
    markdownTruncated: md.truncated,
    textTruncated: tx.truncated,
    metadata: result.metadata,
    sectionCount: result.sections.length,
    sections: result.sections.map((s, i) => ({
      index: i,
      kind: s.kind,
      label: s.label,
      blockCount: s.blocks.length,
    })),
  };
}

function jsonContent(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorContent(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const message =
    err instanceof UnsupportedFileTypeError
      ? `Unsupported file type: ${err.mime}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Build (but don't connect) the MCP server. Exposed for tests.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'any-extractor',
    version: '1.0.0',
  });

  server.registerTool(
    'extract_document',
    {
      title: 'Extract document (markdown)',
      description:
        'Turn any supported document (PDF, DOCX, XLSX, PPTX, ODF, HTML, MD, CSV, JSON, TXT) into agent-ready GFM markdown plus lightweight metadata. Use this first — it is the cheapest and covers most agent use-cases.',
      inputSchema: {
        url: inputSchema.shape.url,
        path: inputSchema.shape.path,
        data: inputSchema.shape.data,
        mimeHint: inputSchema.shape.mimeHint,
        maxChars: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_CHARS)
          .describe(
            `Truncate markdown/text output at this many chars. Default ${DEFAULT_MAX_CHARS}.`,
          )
          .optional(),
        includeText: z
          .boolean()
          .describe('Also include plain-text (no markdown syntax) rendering. Default false.')
          .optional(),
      },
    },
    async (args) => {
      try {
        const parsed = inputSchema.parse(args);
        const source = await resolveInput(parsed);
        const result = await getExtractor().extract(source);
        const summary = summarizeResult(result, args.maxChars ?? DEFAULT_MAX_CHARS);
        const payload: Record<string, unknown> = {
          markdown: summary.markdown,
          markdownTruncated: summary.markdownTruncated,
          metadata: summary.metadata,
          sectionCount: summary.sectionCount,
          sections: summary.sections,
        };
        if (args.includeText) {
          payload.text = summary.text;
          payload.textTruncated = summary.textTruncated;
        }
        return jsonContent(payload);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'extract_document_structured',
    {
      title: 'Extract document (structured)',
      description:
        'Return the full typed section/block tree for the document. Use when the agent needs to walk headings, tables, lists, or image captions individually rather than reading flat markdown. Heavier than `extract_document`.',
      inputSchema: {
        url: inputSchema.shape.url,
        path: inputSchema.shape.path,
        data: inputSchema.shape.data,
        mimeHint: inputSchema.shape.mimeHint,
        maxSections: z
          .number()
          .int()
          .positive()
          .max(1000)
          .describe('Cap the number of sections returned (from the start). Default: all.')
          .optional(),
      },
    },
    async (args) => {
      try {
        const parsed = inputSchema.parse(args);
        const source = await resolveInput(parsed);
        const result = await getExtractor().extract(source);
        const sections = args.maxSections
          ? result.sections.slice(0, args.maxSections)
          : result.sections;
        return jsonContent({
          metadata: result.metadata,
          sectionCount: result.sections.length,
          sectionsReturned: sections.length,
          sections,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'extract_section',
    {
      title: 'Extract one section',
      description:
        'Return a single section (page / slide / sheet / body) as markdown and plain text. Use for paging through a large document without blowing the context window.',
      inputSchema: {
        url: inputSchema.shape.url,
        path: inputSchema.shape.path,
        data: inputSchema.shape.data,
        mimeHint: inputSchema.shape.mimeHint,
        sectionIndex: z
          .number()
          .int()
          .min(0)
          .describe('0-based section index. Use `extract_document` first to see how many exist.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_CHARS)
          .describe(`Truncate the rendered output. Default ${DEFAULT_MAX_CHARS}.`)
          .optional(),
      },
    },
    async (args) => {
      try {
        const parsed = inputSchema.parse(args);
        const source = await resolveInput(parsed);
        const result = await getExtractor().extract(source);
        const section = result.sections[args.sectionIndex];
        if (!section) {
          throw new Error(
            `sectionIndex ${args.sectionIndex} out of range (0..${result.sections.length - 1}).`,
          );
        }
        const max = args.maxChars ?? DEFAULT_MAX_CHARS;
        const md = clampChars(toMarkdown(section), max);
        const tx = clampChars(toText(section), max);
        return jsonContent({
          metadata: result.metadata,
          section: {
            index: args.sectionIndex,
            kind: section.kind,
            label: section.label,
            blockCount: section.blocks.length,
          },
          markdown: md.text,
          markdownTruncated: md.truncated,
          text: tx.text,
          textTruncated: tx.truncated,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return server;
}

/**
 * Start the MCP server on stdio. Called by the `any-extractor-mcp` bin.
 */
export async function runStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
