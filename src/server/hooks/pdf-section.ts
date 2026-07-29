import { buildDayIndex, coveredDayCount, resolveAll, uncoveredRanges } from '../../shared/drift';
import { countsForSegment } from '../../shared/filter';
import { PDF_MAX_ROWS } from '../../shared/limits';
import { dateRangeLabel, dayRangeLabel, plural, rangesToText, safeLabel } from '../../shared/format';
import { listSegments } from '../repo';
import { ensureSchema } from '../schema';
import type { PdfSection, PluginContext } from '../../shared/host-types';
import type { SegmentCounts, SegmentView } from '../../shared/types';

/**
 * One section summarising the legs. Returns an empty array when the trip has no
 * segments — a plugin should not put an empty table into somebody's PDF export.
 *
 * Host caps: 5 sections, 20 paragraphs of 2000 chars, 8 headers, 50 rows. Our
 * own 40-segment limit keeps the table under the row cap by construction.
 */
export function buildSections(
  views: readonly SegmentView[],
  dayCount: number,
  counts: ReadonlyMap<number, SegmentCounts>,
): PdfSection[] {
  if (views.length === 0) return [];

  const covered = coveredDayCount(views, dayCount);
  const gaps = uncoveredRanges(views, dayCount);
  const drifted = views.filter((v) => v.status !== 'ok');

  const paragraphs: string[] = [
    `This trip is split into ${plural(views.length, 'leg', 'legs')}, covering ${covered} of ${plural(dayCount, 'day', 'days')}.`,
  ];
  if (gaps.length > 0) {
    paragraphs.push(`Days not in any leg: ${rangesToText(gaps)}.`);
  }
  if (drifted.length > 0) {
    paragraphs.push(
      `${plural(drifted.length, 'leg', 'legs')} no longer fit the trip's current length and are shown shortened or omitted.`,
    );
  }

  const rows = views.slice(0, PDF_MAX_ROWS).map((view) => {
    const c = counts.get(view.id) ?? { places: 0, stays: 0, bookings: 0 };
    const days =
      view.effStart === null || view.effEnd === null
        ? 'not in this trip'
        : dayRangeLabel(view.effStart, view.effEnd).replace('Day ', '');

    return [
      safeLabel(view.name, view.index),
      days,
      dateRangeLabel(view.startDate, view.endDate) ?? '-',
      String(c.places),
      String(c.stays),
      String(c.bookings),
    ];
  });

  return [
    {
      title: 'Trip segments',
      paragraphs,
      table: {
        headers: ['Leg', 'Days', 'Dates', 'Places', 'Stays', 'Bookings'],
        rows,
      },
    },
  ];
}

export async function getSections(tripId: number, ctx: PluginContext): Promise<PdfSection[]> {
  try {
    await ensureSchema(ctx);

    const rows = await listSegments(ctx, tripId);
    if (rows.length === 0) return [];

    const [days, reservations, accommodations] = await Promise.all([
      ctx.trips.getDays(tripId),
      ctx.trips.getReservations(tripId),
      ctx.trips.getAccommodations(tripId),
    ]);

    const idx = buildDayIndex(days);
    const views = resolveAll(rows, idx);
    const counts = new Map(views.map((v) => [v.id, countsForSegment(v, days, reservations, accommodations, idx)]));

    return buildSections(views, idx.count, counts);
  } catch (err) {
    ctx.log.warn('pdfSectionProvider failed', {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
