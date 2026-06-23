import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const { db } = await import('@/lib/db');
    const topics = await db.topic.findMany({
      orderBy: { updatedAt: 'desc' },
      select: { name: true, pageCount: true, depth: true, startUrl: true, updatedAt: true, fileName: true },
    });
    const pages = await db.scrapedPage.findMany({
      select: { url: true, title: true, topic: true },
    });
    return NextResponse.json({ topics, totalPages: pages.length });
  } catch {
    return NextResponse.json({ topics: [], totalPages: 0 });
  }
}