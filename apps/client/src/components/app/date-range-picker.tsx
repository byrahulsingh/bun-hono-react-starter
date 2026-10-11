import {
  format,
  isSameDay,
  isSameYear,
  parse,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'

import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useIsMobile } from '#/hooks/use-mobile'

/** Calendar days as `YYYY-MM-DD`, in the viewer's time zone (URL-friendly). */
export interface DayRange {
  from?: string
  to?: string
}

const DAY = 'yyyy-MM-dd'
const toDate = (day: string | undefined) =>
  day ? parse(day, DAY, new Date()) : undefined
const toDay = (date: Date) => format(date, DAY)

function label({ from, to }: DayRange): string {
  const start = toDate(from)
  const end = toDate(to) ?? start
  if (!start || !end) return 'Any time'
  if (isSameDay(start, end)) return format(start, 'd MMM yyyy')
  return isSameYear(start, end)
    ? `${format(start, 'd MMM')} – ${format(end, 'd MMM yyyy')}`
    : `${format(start, 'd MMM yyyy')} – ${format(end, 'd MMM yyyy')}`
}

function presets(today: Date): { label: string; range: DateRange }[] {
  const lastMonth = subMonths(today, 1)
  return [
    { label: 'Today', range: { from: today, to: today } },
    {
      label: 'Yesterday',
      range: { from: subDays(today, 1), to: subDays(today, 1) },
    },
    { label: 'Last 7 days', range: { from: subDays(today, 6), to: today } },
    { label: 'Last 30 days', range: { from: subDays(today, 29), to: today } },
    { label: 'This month', range: { from: startOfMonth(today), to: today } },
    {
      label: 'Last month',
      range: {
        from: startOfMonth(lastMonth),
        to: subDays(startOfMonth(today), 1),
      },
    },
  ]
}

/**
 * A button that shows the chosen days ("1 Oct – 7 Oct 2026", or "Any time")
 * and opens a calendar. Presets apply at once; a picked range applies with
 * Apply. Days after today cannot be picked: nothing has happened there yet.
 */
export function DateRangePicker({
  id,
  value,
  onChange,
}: {
  id?: string
  value: DayRange
  onChange: (range: DayRange) => void
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>()
  const today = new Date()

  function apply(range: DateRange | undefined) {
    onChange(
      range?.from
        ? { from: toDay(range.from), to: toDay(range.to ?? range.from) }
        : {},
    )
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Each opening starts from what is applied, not a leftover draft.
        if (next) setDraft({ from: toDate(value.from), to: toDate(value.to) })
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            className="w-full justify-start font-normal data-[empty=true]:text-muted-foreground"
            data-empty={!value.from}
          />
        }
      >
        <CalendarIcon aria-hidden="true" />
        <span className="truncate">{label(value)}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-wrap gap-1 border-b p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0">
            {presets(today).map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => apply(preset.range)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-col">
            <Calendar
              mode="range"
              selected={draft}
              onSelect={setDraft}
              // After a full range, the next click starts a new one.
              resetOnSelect
              numberOfMonths={isMobile ? 1 : 2}
              defaultMonth={
                isMobile
                  ? (draft?.from ?? today)
                  : startOfMonth(subMonths(draft?.to ?? today, 1))
              }
              disabled={{ after: today }}
              endMonth={today}
            />
            <div className="flex items-center gap-2 border-t p-2">
              <p className="mr-auto text-xs text-muted-foreground">
                {draft?.from
                  ? label({
                      from: toDay(draft.from),
                      to: draft.to ? toDay(draft.to) : undefined,
                    })
                  : 'Pick a day, or a first and last day'}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => apply(undefined)}
              >
                Clear
              </Button>
              <Button
                size="sm"
                disabled={!draft?.from}
                onClick={() => apply(draft)}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
