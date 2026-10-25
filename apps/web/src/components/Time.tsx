import { formatAgo, formatTime } from '../format';

/** A relative time ("3 minutes ago") with the exact time on hover. */
export function Ago({ date }: { date: Date }) {
  return <time dateTime={date.toISOString()} title={formatTime(date)}>{formatAgo(date)}</time>;
}
