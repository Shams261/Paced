import type { Calendar } from "./contracts.js";

// Injected at the boundary: the engine never reads the system clock or timezone.
export const intlCalendar: Calendar = {
  local(instant, timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const field = (name: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === name)?.value ?? "";
    return {
      day: `${field("year")}-${field("month")}-${field("day")}`,
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
        field("weekday"),
      ),
      minute: Number(field("hour")) * 60 + Number(field("minute")),
    };
  },
};
