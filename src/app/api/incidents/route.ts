import { NextResponse } from 'next/server';
import { getIncidents } from '../../../dashboard/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const incidents = await getIncidents();
    return NextResponse.json(incidents);
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
