import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'download');

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fileName = searchParams.get('file');
  if (!fileName) return NextResponse.json({ error: 'File name is required' }, { status: 400 });
  const sanitized = path.basename(fileName).replace(/\.\./g, '');
  if (!sanitized.endsWith('.docx')) return NextResponse.json({ error: 'Only .docx files' }, { status: 400 });
  const filePath = path.join(DOWNLOAD_DIR, sanitized);
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  const buf = fs.readFileSync(filePath);
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${sanitized}"`,
      'Content-Length': buf.length.toString(),
    },
  });
}