import { NextResponse } from 'next/server';
import { getIncidents } from '../../../dashboard/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const incidents = await getIncidents();
    return NextResponse.json(incidents);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
