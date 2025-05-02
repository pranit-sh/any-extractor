import { fetch } from 'undici';
import { ExtractedXmlItem } from '../types';
import * as cheerio from 'cheerio';
import { Element, Text } from 'domhandler';

export class ConfluenceCrawler {
  private baseUrl: string;
  private email: string;
  private apiKey: string;
  private apiEndpoint: string;

  constructor(baseUrl: string, email: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.email = email;
    this.apiKey = apiKey;

    this.apiEndpoint = this.baseUrl.includes('atlassian.net')
      ? `${this.baseUrl}/wiki/rest/api`
      : `${this.baseUrl}/rest/api`;
  }

  public async extractPageContent(pageId: string): Promise<ExtractedXmlItem[]> {
    const xmlContent = await this.fetchPageContent(pageId);
    return this.extractOrderedContentFromXml(xmlContent, pageId);
  }

  private async fetchPageContent(pageId: string): Promise<string> {
    const url = `${this.apiEndpoint}/content/${pageId}?expand=body.storage`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Request failed: ${response.status} ${response.statusText}. Response body: ${errorText}`,
      );
    }

    const data = (await response.json()) as { body: { [key: string]: { value: string } } };
    return data.body.storage.value;
  }

  private extractOrderedContentFromXml(xml: string, pageId: string): ExtractedXmlItem[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const node = $('ac\\:layout').first();
    const orderedContent = this.parseNodeContents(node, $, pageId);
    return orderedContent;
  }

  private parseNodeContents(
    node: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
    pageId: string,
    ignoreTags: string[] = [],
  ): ExtractedXmlItem[] {
    let result: ExtractedXmlItem[] = [];
    const contents = node.contents();
    contents.each((_, ele) => {
      switch (ele.type) {
        case 'text':
          result.push(this.parseTextNode(ele));
          break;
        case 'tag':
          const tagResult = this.parseTagNode(ele, $, pageId, ignoreTags);
          result = result.concat(tagResult);
          break;
        default:
          break;
      }
    });
    return result;
  }

  private parseTextNode(ele: Text): ExtractedXmlItem {
    const text = ele.data.trim();
    return { type: 'text', content: text };
  }

  private parseTagNode(
    ele: Element,
    $: cheerio.CheerioAPI,
    pageId: string,
    ignoreTags: string[],
  ): ExtractedXmlItem[] {
    let result: ExtractedXmlItem[] = [];
    const tagName = ele.tagName;
    if (ignoreTags.includes(tagName)) {
      return result;
    }
    switch (tagName) {
      case 'ac:structured-macro':
        result = result.concat(this.parseStructuredMacro(ele, $, pageId));
        break;
      case 'ac:adf-extension':
        result = result.concat(this.parseAdfExtension(ele, $));
        break;
      case 'ac:task-list':
        result = result.concat(this.parseTaskList(ele, $, pageId));
        break;
      case 'ac:image':
        result = result.concat(this.parseImage(ele, $, pageId));
        break;
      case 'table':
        result = result.concat(this.parseTable(ele, $));
        break;
      case 'a':
        result = result.concat(this.parseLink(ele, $, pageId));
        break;
      default:
        result = result.concat(this.parseNodeContents($(ele), $, pageId));
        break;
    }
    return result;
  }

  private parseStructuredMacro(
    ele: Element,
    $: cheerio.CheerioAPI,
    pageId: string,
  ): ExtractedXmlItem[] {
    const macroName = ele.attribs['ac:name'];
    const result: ExtractedXmlItem[] = [];
    switch (macroName) {
      case 'code':
        result.push(this.parseCodeMacro(ele, $));
        break;
      case 'info':
        result.push(this.parseInfoMacro(ele, $, pageId));
        break;
      case 'warning':
        result.push(this.parseWarningMacro(ele, $, pageId));
        break;
      case 'note':
        result.push(this.parseNoteMacro(ele, $, pageId));
        break;
      case 'tip':
        result.push(this.parseTipMacro(ele, $, pageId));
        break;
      case 'panel':
        result.push(this.parsePanelMacro(ele, $, pageId));
        break;
      case 'expand':
        result.push(this.parseExpandMacro(ele, $, pageId));
        break;
      case 'status':
        result.push(this.parseStatusMacro(ele, $, pageId));
        break;
      case 'view-file':
        result.push(this.parseViewFileMacro(ele, $, pageId));
        break;
    }
    return result;
  }

  private parseLink(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem[] {
    const href = $(ele).attr('href');
    const text = this.parseNodeContents($(ele), $, pageId);
    return [{ type: 'link', content: `${text.map((t) => t.content).join('')} (${href})` }];
  }

  private parseTaskList(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem[] {
    const result: ExtractedXmlItem[] = [];
    const tasks = $(ele).find('ac\\:task');
    tasks.each((_, task) => {
      const taskStatus = $(task).find('ac\\:task-status').text().trim();
      const taskBody = this.parseNodeContents($(task).find('ac\\:task-body'), $, pageId);
      result.push({
        type: 'task',
        content: `${taskBody.map((t) => t.content).join('')} [Status: ${taskStatus}]`,
      });
    });
    return result;
  }

  private parseImage(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem[] {
    const attachment = $(ele).find('ri\\:attachment');
    const filename = attachment.attr('ri:filename')?.trim();
    if (!filename) {
      return [];
    }

    const imageUrl = this.baseUrl.includes('atlassian.net')
      ? `${this.baseUrl}/wiki/download/attachments/${pageId}/${encodeURIComponent(filename)}`
      : `${this.baseUrl}/download/attachments/${pageId}/${encodeURIComponent(filename)}`;

    return [{ type: 'image', content: imageUrl }];
  }

  private parseTable(ele: Element, $: cheerio.CheerioAPI): ExtractedXmlItem[] {
    const result: ExtractedXmlItem[] = [];
    const rows = $(ele).find('tr');
    const tableData: string[] = [];
    rows.each((_, row) => {
      const cells = $(row).find('th, td');
      const rowData: string[] = [];
      cells.each((_, cell) => {
        rowData.push($(cell).text().trim());
      });
      tableData.push(rowData.join(' | '));
    });
    result.push({ type: 'table', content: tableData.join('\n') });
    return result;
  }

  private parseCodeMacro(ele: Element, $: cheerio.CheerioAPI): ExtractedXmlItem {
    const code = $(ele).find('ac\\:plain-text-body').text().trim();
    return { type: 'code', content: code };
  }

  private parseInfoMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const info = this.parseNodeContents($(ele), $, pageId);
    return { type: 'info', content: info.map((t) => t.content).join('') };
  }

  private parseWarningMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const warning = this.parseNodeContents($(ele), $, pageId);
    return { type: 'warning', content: warning.map((t) => t.content).join('') };
  }

  private parseNoteMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const note = this.parseNodeContents($(ele), $, pageId);
    return { type: 'note', content: note.map((t) => t.content).join('') };
  }

  private parseTipMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const tip = this.parseNodeContents($(ele), $, pageId);
    return { type: 'tip', content: tip.map((t) => t.content).join('') };
  }

  private parsePanelMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const panel = this.parseNodeContents($(ele), $, pageId, ['ac:parameter']);
    return { type: 'panel', content: panel.map((t) => t.content).join('') };
  }

  private parseExpandMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const expand = this.parseNodeContents($(ele), $, pageId);
    return { type: 'expand', content: expand.map((t) => t.content).join('') };
  }

  private parseStatusMacro(ele: Element, $: cheerio.CheerioAPI, pageId: string): ExtractedXmlItem {
    const status = this.parseNodeContents($(ele), $, pageId);
    return { type: 'status', content: status.map((t) => t.content).join('') };
  }

  private parseAdfExtension(ele: Element, $: cheerio.CheerioAPI): ExtractedXmlItem[] {
    const adfNode = $(ele).find('ac\\:adf-node');
    const content = adfNode.find('ac\\:adf-content').text().trim();
    return [{ type: 'adf-extension', content }];
  }

  private parseViewFileMacro(
    ele: Element,
    $: cheerio.CheerioAPI,
    pageId: string,
  ): ExtractedXmlItem {
    const attachment = $(ele).find('ac\\:parameter[ac\\:name="name"] ri\\:attachment');
    const filename = attachment.attr('ri:filename')?.trim();

    if (!filename) {
      return { type: 'view-file', content: '' };
    }

    const fileUrl = this.baseUrl.includes('atlassian.net')
      ? `${this.baseUrl}/wiki/download/attachments/${pageId}/${encodeURIComponent(filename)}`
      : `${this.baseUrl}/download/attachments/${pageId}/${encodeURIComponent(filename)}`;

    return { type: 'view-file', content: fileUrl };
  }
}
