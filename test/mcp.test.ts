import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server';

/**
 * Smoke tests for the MCP adapter. Uses the SDK's InMemoryTransport to
 * wire a real Client to a real Server — no stdio, no processes — so we
 * exercise the actual public MCP surface (tool discovery + calls).
 */

type TextContent = { type: 'text'; text: string };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: TextContent[]; isError?: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  return res as { content: TextContent[]; isError?: boolean };
}

describe('mcp server', () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer();
    client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('advertises the three extraction tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['extract_document', 'extract_document_structured', 'extract_section']);
  });

  it('extracts a local file by path', async () => {
    const res = await call(client, 'extract_document', { path: 'test/fixtures/sample.md' });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.metadata.mime).toMatch(/^text\//);
    expect(payload.markdown.length).toBeGreaterThan(0);
    expect(payload.sectionCount).toBeGreaterThan(0);
  });

  it('accepts base64 data', async () => {
    const data = Buffer.from('# Hello\n\nWorld').toString('base64');
    const res = await call(client, 'extract_document', { data });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.markdown).toContain('Hello');
  });

  it('returns a single section via extract_section', async () => {
    const res = await call(client, 'extract_section', {
      path: 'test/fixtures/sample.md',
      sectionIndex: 0,
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.section.index).toBe(0);
    expect(payload.markdown.length).toBeGreaterThan(0);
  });

  it('requires at least one input source', async () => {
    const res = await call(client, 'extract_document', {});
    expect(res.isError).toBe(true);
  });
});
