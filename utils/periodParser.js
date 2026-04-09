/**
 * utils/periodParser.js
 * Parse user input like "last 3 days", "last week", "last month" into date ranges.
 *
 * Helps users get custom reports without complex date entry.
 */

'use strict';

/**
 * Parse a period string and return { startDate, endDate, label }
 * Examples: "last 3 days", "last week", "last month", "this week", "today"
 */
function parsePeriod(input) {
  const text = (input || '').toLowerCase().trim();
  const now = new Date();
  now.setHours(0, 0, 0, 0); // Start of today

  // TODAY
  if (text === 'today') {
    return {
      startDate: new Date(now),
      endDate: new Date(now),
      label: 'Today',
    };
  }

  // THIS WEEK
  if (text.includes('this week')) {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
    return {
      startDate: startOfWeek,
      endDate: new Date(now),
      label: 'This week',
    };
  }

  // LAST WEEK
  if (text.includes('last week')) {
    const endOfLastWeek = new Date(now);
    endOfLastWeek.setDate(now.getDate() - now.getDay() - 1); // Saturday of last week
    const startOfLastWeek = new Date(endOfLastWeek);
    startOfLastWeek.setDate(endOfLastWeek.getDate() - 6);
    return {
      startDate: startOfLastWeek,
      endDate: endOfLastWeek,
      label: 'Last week',
    };
  }

  // LAST N DAYS
  const daysMatch = text.match(/last\s+(\d+)\s+days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - days + 1);
    return {
      startDate,
      endDate: new Date(now),
      label: `Last ${days} days`,
    };
  }

  // THIS MONTH
  if (text.includes('this month')) {
    const startOfMonth = new Date(now);
    startOfMonth.setDate(1);
    return {
      startDate: startOfMonth,
      endDate: new Date(now),
      label: 'This month',
    };
  }

  // LAST MONTH
  if (text.includes('last month')) {
    const startOfThisMonth = new Date(now);
    startOfThisMonth.setDate(1);
    const endOfLastMonth = new Date(startOfThisMonth);
    endOfLastMonth.setDate(0);
    const startOfLastMonth = new Date(endOfLastMonth);
    startOfLastMonth.setDate(1);
    return {
      startDate: startOfLastMonth,
      endDate: endOfLastMonth,
      label: 'Last month',
    };
  }

  // SPECIFIC DATE RANGE: "from X to Y"
  const rangeMatch = text.match(/from\s+(.+?)\s+to\s+(.+)/);
  if (rangeMatch) {
    const start = parseDate(rangeMatch[1], now);
    const end = parseDate(rangeMatch[2], now);
    if (start && end) {
      return {
        startDate: start,
        endDate: end,
        label: `${formatDate(start)} to ${formatDate(end)}`,
      };
    }
  }

  // DEFAULT: last 7 days
  const defaultStart = new Date(now);
  defaultStart.setDate(now.getDate() - 7);
  return {
    startDate: defaultStart,
    endDate: new Date(now),
    label: 'Last 7 days',
  };
}

/**
 * Parse a single date string. Handles formats like:
 * "3 days ago", "monday", "last monday", "15th", specific dates, etc.
 */
function parseDate(dateStr, referenceDate = new Date()) {
  const text = (dateStr || '').toLowerCase().trim();
  const ref = new Date(referenceDate);
  ref.setHours(0, 0, 0, 0);

  // X DAYS AGO
  const agoMatch = text.match(/(\d+)\s+days?\s+ago/);
  if (agoMatch) {
    const date = new Date(ref);
    date.setDate(ref.getDate() - parseInt(agoMatch[1], 10));
    return date;
  }

  // DAY NAME: "monday", "last monday", "next monday"
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = text.match(/(?:last\s+|next\s+)?(\w+)/i);
  if (dayMatch) {
    const dayIndex = dayNames.indexOf(dayMatch[1].toLowerCase());
    if (dayIndex !== -1) {
      const date = new Date(ref);
      const currentDay = date.getDay();
      let diff = dayIndex - currentDay;

      if (text.includes('last')) {
        diff = diff > 0 ? diff - 7 : diff;
      } else if (text.includes('next')) {
        diff = diff < 0 ? diff + 7 : diff;
      } else if (diff > 0) {
        diff = diff - 7; // Past occurrence by default
      }

      date.setDate(ref.getDate() + diff);
      return date;
    }
  }

  // NUMERIC DAY: "15", "15th", "15 Jan"
  const numMatch = text.match(/(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\w+))?/);
  if (numMatch) {
    const day = parseInt(numMatch[1], 10);
    const monthStr = numMatch[2];

    let month = ref.getMonth();
    let year = ref.getFullYear();

    if (monthStr) {
      const monthIndex = getMonthIndex(monthStr);
      if (monthIndex !== -1) {
        month = monthIndex;
        // If month in past, assume last year
        if (month < ref.getMonth() || (month === ref.getMonth() && day < ref.getDate())) {
          year -= 1;
        }
      }
    }

    const date = new Date(year, month, day);
    return date;
  }

  return null;
}

/**
 * Get month index from name (0-11)
 */
function getMonthIndex(monthStr) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return months.indexOf(monthStr.toLowerCase().slice(0, 3));
}

/**
 * Format date for display
 */
function formatDate(date) {
  const d = new Date(date);
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${day} ${month}`;
}

/**
 * Get example period suggestions for help text
 */
function getPeriodExamples() {
  return [
    'today',
    'last 3 days',
    'last 7 days',
    'last 14 days',
    'last month',
    'this month',
    'last week',
    'from 1 Apr to 15 Apr',
  ];
}

module.exports = {
  parsePeriod,
  parseDate,
  formatDate,
  getPeriodExamples,
};
