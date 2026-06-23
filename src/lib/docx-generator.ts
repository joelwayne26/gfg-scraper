import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, ExternalHyperlink,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';
import { renderLatex, type ContentSection, type ScrapedPageData, type CrossRefEntry } from './scraper';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/home/z/my-project/download';
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

export async function generateDocx(
  pages: ScrapedPageData[],
  topic: string,
  crossRefs: CrossRefEntry[],
  fileName?: string,
): Promise<string> {
  const children: (Paragraph | Table)[] = [];

  // ── Cover Page ──
  children.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
  children.push(new Paragraph({
    children: [new TextRun({ text: topic, bold: true, size: 52, font: 'Calibri', color: '1a5632' })],
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Comprehensive Study Notes', size: 28, font: 'Calibri', color: '555555' })],
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Scraped from GeeksforGeeks', size: 22, font: 'Calibri', color: '888888' })],
    alignment: AlignmentType.CENTER, spacing: { after: 80 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 20, font: 'Calibri', color: '999999' })],
    alignment: AlignmentType.CENTER, spacing: { after: 80 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Pages: ${pages.length} | Images: ${pages.reduce((s, p) => s + p.images.length, 0)} | Cross-referenced: ${crossRefs.length}`, size: 20, font: 'Calibri', color: '999999', italics: true })],
    alignment: AlignmentType.CENTER, spacing: { after: 400 },
  }));

  // ── Cross-References Section ──
  if (crossRefs.length > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Cross-References (Already Scraped in Other Topics)', bold: true, size: 28, font: 'Calibri', color: '1a5632' })],
      heading: HeadingLevel.HEADING_1, spacing: { after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2d6a4f' } },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: `The following ${crossRefs.length} page(s) were already scraped under other topics and are referenced here instead of being duplicated.`, size: 22, font: 'Calibri', color: '555555' })],
      spacing: { after: 200 }, alignment: AlignmentType.JUSTIFIED,
    }));

    for (const xref of crossRefs) {
      const topicList = xref.topics.map(t => `"${t}"`).join(', ');
      children.push(new Paragraph({
        children: [
          new TextRun({ text: '\u2022  ', size: 22, font: 'Calibri' }),
          new TextRun({ text: xref.title, bold: true, size: 22, font: 'Calibri', color: '333333' }),
          new TextRun({ text: ` \u2014 covered in topic(s): ${topicList}`, size: 20, font: 'Calibri', color: '888888', italics: true }),
        ],
        spacing: { after: 100, line: 312 }, indent: { left: 540, hanging: 180 },
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: xref.url, size: 18, font: 'Calibri', color: 'aaaaaa' })],
        spacing: { after: 150 }, indent: { left: 540 },
      }));
    }

    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // ── Content Pages ──
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];

    children.push(new Paragraph({
      children: [new TextRun({ text: page.title, bold: true, size: 36, font: 'Calibri', color: '1a5632' })],
      heading: HeadingLevel.HEADING_1, spacing: { after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '2d6a4f' } },
    }));

    children.push(new Paragraph({
      children: [new ExternalHyperlink({ children: [new TextRun({ text: page.url, style: 'Hyperlink', size: 18, font: 'Calibri' })], link: page.url })],
      spacing: { after: 250 },
    }));

    for (const sec of page.sections) {
      switch (sec.type) {
        case 'heading': {
          const lvl = Math.min(sec.level || 2, 4) as 1 | 2 | 3 | 4;
          const hMap: Record<number, typeof HeadingLevel.HEADING_1> = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
          const sMap: Record<number, number> = { 1: 32, 2: 28, 3: 24, 4: 22 };
          children.push(new Paragraph({
            children: [new TextRun({ text: sec.content, bold: true, size: sMap[lvl] || 26, font: 'Calibri', color: lvl <= 2 ? '1a5632' : '333333' })],
            heading: hMap[lvl] || HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 },
          }));
          break;
        }

        case 'paragraph': {
          const clean = sec.content.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
          if (clean.length < 3) continue;
          children.push(new Paragraph({
            children: [new TextRun({ text: clean, size: 22, font: 'Calibri' })],
            spacing: { after: 150, line: 312 }, alignment: AlignmentType.JUSTIFIED,
          }));
          break;
        }

        case 'formula': {
          const rendered = renderLatex(sec.content);
          children.push(new Paragraph({
            children: [new TextRun({ text: rendered, italics: true, size: 22, font: 'Cambria Math', color: '1a1a2e' })],
            spacing: { before: 250, after: 250, line: 360 }, alignment: AlignmentType.CENTER,
            indent: { left: 720, right: 720 },
            border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' }, left: { style: BorderStyle.SINGLE, size: 6, color: '2d6a4f' } },
            shading: { type: ShadingType.CLEAR, fill: 'f0f7f4' },
          }));
          // Also store the raw LaTeX in a comment-like line below for reference
          if (rendered !== sec.content) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `LaTeX: ${sec.content}`, size: 16, font: 'Consolas', color: 'bbbbbb' })],
              spacing: { after: 200 }, alignment: AlignmentType.CENTER,
            }));
          }
          break;
        }

        case 'image': {
          if (sec.imageData && sec.imageData.length > 100) {
            try {
              const maxW = 520;
              let w = sec.imageWidth || 580, h = sec.imageHeight || 360;
              if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
              children.push(new Paragraph({
                children: [new ImageRun({ data: sec.imageData, transformation: { width: w, height: h }, type: 'png' })],
                spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER,
              }));
            } catch { children.push(new Paragraph({ children: [new TextRun({ text: `[Image: ${sec.content}]`, italics: true, size: 18, color: '999999', font: 'Calibri' })], spacing: { after: 100 }, alignment: AlignmentType.CENTER })); }
          }
          break;
        }

        case 'carousel': {
          children.push(new Paragraph({
            children: [new TextRun({ text: sec.content || 'Featured Images', bold: true, size: 22, font: 'Calibri', color: '555555' })],
            spacing: { before: 200, after: 100 }, alignment: AlignmentType.CENTER,
          }));
          if (sec.images) {
            for (let i = 0; i < sec.images.length; i++) {
              const img = sec.images[i];
              if (img.buffer.length > 100) {
                try {
                  const maxW = 520;
                  let w = img.width || 580, h = img.height || 360;
                  if (w > maxW) { const s = maxW / w; w = maxW; h = Math.round(h * s); }
                  children.push(new Paragraph({
                    children: [new ImageRun({ data: img.buffer, transformation: { width: w, height: h }, type: 'png' })],
                    spacing: { before: 150, after: 80 }, alignment: AlignmentType.CENTER,
                  }));
                  if (img.alt) children.push(new Paragraph({
                    children: [new TextRun({ text: `Figure ${i + 1}: ${img.alt}`, italics: true, size: 18, color: '888888', font: 'Calibri' })],
                    spacing: { after: 150 }, alignment: AlignmentType.CENTER,
                  }));
                } catch { /* skip */ }
              }
            }
          }
          break;
        }

        case 'code': {
          children.push(new Paragraph({
            children: [new TextRun({ text: 'Code', bold: true, size: 20, font: 'Calibri', color: '444444' })],
            spacing: { before: 150, after: 50 }, shading: { type: ShadingType.CLEAR, fill: 'e8e8e8' },
          }));
          for (const line of sec.content.split('\n')) {
            children.push(new Paragraph({
              children: [new TextRun({ text: line || ' ', size: 18, font: 'Consolas' })],
              spacing: { after: 0, line: 240 }, indent: { left: 360 }, shading: { type: ShadingType.CLEAR, fill: 'f5f5f5' },
            }));
          }
          children.push(new Paragraph({ children: [], spacing: { after: 150 } }));
          break;
        }

        case 'list': {
          if (sec.items) for (const item of sec.items) {
            const clean = item.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
            children.push(new Paragraph({
              children: [new TextRun({ text: '\u2022  ' + clean, size: 22, font: 'Calibri' })],
              spacing: { after: 80, line: 312 }, indent: { left: 540, hanging: 180 },
            }));
          }
          break;
        }

        case 'table': {
          if (sec.rows && sec.rows.length > 0) {
            const rows = sec.rows.map((row, ri) => new TableRow({
              tableHeader: ri === 0, cantSplit: true,
              children: row.map(cell => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0, size: 20, font: 'Calibri', color: ri === 0 ? 'ffffff' : '333333' })], spacing: { after: 60 } })],
                shading: ri === 0 ? { type: ShadingType.CLEAR, fill: '2d6a4f', color: 'auto' } : ri % 2 === 0 ? { type: ShadingType.CLEAR, fill: 'f0f7f4', color: 'auto' } : undefined,
                margins: { top: 40, bottom: 40, left: 100, right: 100 },
              })),
            }));
            children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
            children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
          }
          break;
        }

        case 'hr': {
          children.push(new Paragraph({ children: [], spacing: { before: 100, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'd0d0d0' } } }));
          break;
        }

        case 'xref': {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: '\u2139  Cross-Reference: ', bold: true, size: 20, font: 'Calibri', color: 'd97706' }),
              new TextRun({ text: sec.content, size: 20, font: 'Calibri', color: '92400e', italics: true }),
              ...(sec.refTopic ? [new TextRun({ text: ` (covered in "${sec.refTopic}")`, size: 18, font: 'Calibri', color: 'b45309' })] : []),
            ],
            spacing: { before: 150, after: 150 }, indent: { left: 360 },
            shading: { type: ShadingType.CLEAR, fill: 'fffbeb' },
            border: { left: { style: BorderStyle.SINGLE, size: 8, color: 'd97706' } },
          }));
          break;
        }
      }
    }

    if (pi < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const doc = new Document({
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });

  const outName = fileName || `GFG_${topic.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.docx`;
  const filePath = path.join(DOWNLOAD_DIR, outName);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  return outName;
}