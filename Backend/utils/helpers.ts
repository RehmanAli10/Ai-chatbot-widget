export function getDateRange(
  daysFromToday: number = 7,
  excludeToday: boolean = false,
): {
  start: string;
  end: string;
} {
  const start = new Date();

  if (excludeToday) {
    start.setDate(start.getDate() + 1);
  }

  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + daysFromToday);
  end.setHours(23, 59, 59, 999);

  // Format as YYYY-MM-DD
  const formatDate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}
