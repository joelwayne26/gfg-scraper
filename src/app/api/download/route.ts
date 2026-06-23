import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOAD_DIR = '/home/z/my-project/download';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fileName = searchParams.get('file');

  if (!fileName) {
    return NextResponse.json({ error: 'File name is required' }, { status: 400 });
  }

  // Sanitize file name to prevent path traversal
  const sanitized = path.basename(fileName).replace(/\.\./g, '');
  if (!sanitized.endsWith('.docx')) {
    return NextResponse.json({ error: 'Only .docx files are allowed' }, { status: 400 });
  }

  const filePath = path.join(DOWNLOAD_DIR, sanitized);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const fileBuffer = fs.readFileSync(filePath);

  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${sanitized}"`,
      'Content-Length': fileBuffer.length.toString(),
    },
  });
}