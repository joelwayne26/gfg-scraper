import * as fs from 'fs';
import * as path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { scrapeTopic, loadRegistryFromDB } from '@/lib/scraper';
import { generateDocx } from '@/lib/docx-generator';

export const maxDuration = 300; // Vercel pro allows up to 300s

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, topic, depth = 1, maxPages = 10 } = body;

    if (!url || !topic) {
      return NextResponse.json({ error: 'url and topic are required' }, { status: 400 });
    }

    // Load existing page registry for cross-referencing
    try {
      const { db } = await import('@/lib/db');
      await loadRegistryFromDB(db);
    } catch { /* DB not available on Vercel - cross-referencing will be session-only */ }

    const events: any[] = [];

    const { pages, crossRefs } = await scrapeTopic(
      url,
      topic,
      depth,
      maxPages,
      (event) => { events.push(event); },
    );

    if (pages.length === 0) {
      return NextResponse.json({ error: 'No pages scraped', events, crossRefs: crossRefs.length });
    }

    const downloadDir = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'download');
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const fileName = await generateDocx(pages, topic, crossRefs);

    return NextResponse.json({
      success: true,
      fileName,
      downloadUrl: `/api/download?file=${encodeURIComponent(fileName)}`,
      stats: {
        pagesScraped: pages.length,
        pagesReferenced: crossRefs.length,
        imagesDownloaded: pages.reduce((s, p) => s + p.images.length, 0),
        formulasExtracted: pages.reduce((s, p) => s + p.formulas.length, 0),
        events: events.length,
      },
      events,
      crossRefs,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}