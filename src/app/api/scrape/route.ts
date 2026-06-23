import { NextRequest, NextResponse } from 'next/server';
import { scrapeTopic } from '@/lib/scraper';
import { generateDocxBuffer } from '@/lib/docx-generator';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, topic } = body;

    if (!url || !topic) {
      return NextResponse.json({ error: 'url and topic are required' }, { status: 400 });
    }

    const events: any[] = [];

    const { pages, crossRefs } = await scrapeTopic(
      url,
      topic,
      999,
      999999,
      (event) => { events.push(event); },
    );

    if (pages.length === 0) {
      return NextResponse.json({ error: 'No pages scraped', events, crossRefs: crossRefs.length });
    }

    const { buffer, fileName } = await generateDocxBuffer(pages, topic, crossRefs);

    // Return the docx directly as a downloadable response
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': buffer.length.toString(),
        // Custom header with stats for the frontend
        'X-Scrape-Stats': JSON.stringify({
          pagesScraped: pages.length,
          pagesReferenced: crossRefs.length,
          imagesDownloaded: pages.reduce((s, p) => s + p.images.length, 0),
          formulasExtracted: pages.reduce((s, p) => s + p.formulas.length, 0),
          fileName,
        }),
      },
    });
  } catch (err: any) {
    console.error('Scrape error:', err);
    return NextResponse.json({ error: err.message, stack: err.stack?.substring(0, 500) }, { status: 500 });
  }
}